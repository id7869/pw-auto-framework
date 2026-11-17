import { describe, expect, it } from 'vitest';
import { ApiClient, HTTP_STATUS_MESSAGES, createIdempotencyKey } from './http.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function makeClient(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  options: { timeoutMs?: number; getRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
): ApiClient {
  return new ApiClient({
    fetchImpl: handler as typeof fetch,
    timeoutMs: options.timeoutMs ?? 1000,
    getRetries: options.getRetries ?? 0,
    retryDelayMs: 1,
    sleep: options.sleep ?? (async () => undefined),
  });
}

describe('api/http：信封与错误', () => {
  it('成功信封只解包 data', async () => {
    const client = makeClient(async () => jsonResponse({ data: { id: 'case_1' }, meta: { requestId: 'req_1' } }));
    const result = await client.get<{ id: string }>('/api/v1/cases/case_1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ id: 'case_1' });
  });

  it('204 视为成功且无内容', async () => {
    const client = makeClient(async () => new Response(null, { status: 204 }));
    const result = await client.delete('/api/v1/cases/case_1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeUndefined();
  });

  it('错误信封映射为结构化错误（含 details 与 requestId）', async () => {
    const client = makeClient(async () =>
      jsonResponse(
        {
          error: {
            code: 'INVALID_STEP',
            message: '第 2 步缺少 target',
            details: [{ path: 'steps[1].target', message: '必填' }],
            requestId: 'req_abc',
          },
        },
        422,
      ),
    );
    const result = await client.post('/api/v1/cases', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_STEP');
      expect(result.error.message).toBe('第 2 步缺少 target');
      expect(result.error.httpStatus).toBe(422);
      expect(result.error.requestId).toBe('req_abc');
      expect(result.error.details).toEqual([{ path: 'steps[1].target', message: '必填' }]);
    }
  });

  it('无错误信封时按 HTTP 状态给中文兜底文案', async () => {
    const client = makeClient(async () => new Response('not-json', { status: 404 }));
    const result = await client.get('/api/v1/cases/none');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('HTTP_404');
      expect(result.error.message).toBe(HTTP_STATUS_MESSAGES[404]);
    }
  });

  it('200 但返回非 JSON 时给出 INVALID_RESPONSE', async () => {
    const client = makeClient(async () => new Response('<html>oops</html>', { status: 200 }));
    const result = await client.get('/api/v1/cases');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_RESPONSE');
  });

  it('网络异常给出可操作的中文提示', async () => {
    const client = makeClient(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await client.get('/api/health');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_ERROR');
      expect(result.error.message).toContain('无法连接后端服务');
    }
  });

  it('超时给出 TIMEOUT（含秒数）', async () => {
    const client = makeClient(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      { timeoutMs: 20 },
    );
    const result = await client.get('/api/health');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TIMEOUT');
      expect(result.error.message).toContain('超时');
    }
  });

  it('GET 对 5xx 自动重试（默认配置 2 次）', async () => {
    let calls = 0;
    let slept = 0;
    const client = makeClient(
      async () => {
        calls += 1;
        return calls < 3 ? jsonResponse({ error: { code: 'ENGINE_ERROR', message: 'boom', requestId: 'r' } }, 500) : jsonResponse({ data: { ok: true } });
      },
      { getRetries: 2, sleep: async () => { slept += 1; } },
    );
    const result = await client.get('/api/v1/runs');
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(slept).toBe(2);
  });

  it('GET 对 4xx 不重试；POST 不重试', async () => {
    let calls = 0;
    const getClient = makeClient(async () => {
      calls += 1;
      return jsonResponse({ error: { code: 'NOT_FOUND', message: '没有', requestId: 'r' } }, 404);
    });
    await getClient.get('/api/v1/cases/x');
    expect(calls).toBe(1);

    calls = 0;
    const postClient = makeClient(async () => {
      calls += 1;
      return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: '内部错误', requestId: 'r' } }, 500);
    });
    await postClient.post('/api/v1/cases', {});
    expect(calls).toBe(1);
  });

  it('查询串跳过 undefined/null/空字符串并正确编码中文', () => {
    const client = makeClient(async () => jsonResponse({ data: null }));
    const url = client.buildUrl('/api/v1/cases', { limit: 20, cursor: undefined, q: '', tag: '首页', status: 'active' });
    expect(url).toContain('limit=20');
    expect(url).toContain('status=active');
    expect(url).toContain(`tag=${encodeURIComponent('首页')}`);
    expect(url).not.toContain('cursor');
    expect(url).not.toContain('q=');
  });

  it('外部 signal 取消后不再重试并返回 CANCELLED', async () => {
    const controller = new AbortController();
    const client = makeClient(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      { getRetries: 3 },
    );
    controller.abort();
    const result = await client.get('/api/health', { signal: controller.signal });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CANCELLED');
  });

  it('幂等键非空且每次不同', () => {
    const first = createIdempotencyKey();
    const second = createIdempotencyKey();
    expect(first.length).toBeGreaterThan(8);
    expect(first).not.toBe(second);
  });
});