import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePlaywrightCliPath } from '../official.ts';
import { call, cleanupDir, dataOf, startApi, type TestApi } from './helpers.ts';

let api: TestApi | null = null;

afterEach(async () => {
  if (api) {
    await api.close();
    cleanupDir(api.dataDir);
    api = null;
  }
});

function collectKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      acc.push(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

describe('health 与 meta', () => {
  it('GET /api/health 返回成功信封、db=ok 且 requestId 与响应头一致', async () => {
    api = await startApi({ engine: null });
    const response = await call<{ data: { status: string; db: string; version: string; uptimeMs: number }; meta: { requestId: string } }>(
      api.baseUrl,
      'GET',
      '/api/health',
    );
    expect(response.status).toBe(200);
    const data = dataOf(response);
    expect(data.status).toBe('ok');
    expect(data.db).toBe('ok');
    expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(data.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(response.headers.get('x-request-id')).toBe(response.body.meta.requestId);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('GET /api/v1/meta 回显官方版本、限制、能力与白名单 loops', async () => {
    api = await startApi({ engine: null });
    const response = await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', '/api/v1/meta');
    expect(response.status).toBe(200);
    const data = dataOf(response);
    expect(data['app'].name).toBe('pw-auto-framework');
    // 版本来自启动时 `node <cli.js> --version` 的真实探测，而不是硬编码常量
    const cliPath = resolvePlaywrightCliPath();
    expect(cliPath.endsWith('cli.js')).toBe(true);
    const versionProbe = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
    const realVersion = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(
      `${versionProbe.stdout ?? ''}\n${versionProbe.stderr ?? ''}`,
    )?.[1];
    expect(realVersion).toBeTruthy();
    expect(data['versions'].playwright).toBe(realVersion);
    expect(data['versions'].playwrightSource).toBe('cli');
    expect(data['versions'].playwrightVersionError).toBeUndefined();
    expect(data['versions'].playwright).toBe('1.65.0');
    expect(data['versions'].playwrightCliPath).toBe(cliPath);
    expect(data['versions'].node).toBe(process.versions.node);
    expect(data['limits'].bodyLimitBytes).toBe(1024 * 1024);
    expect(data['limits'].maxConcurrentRuns).toBe(1);
    expect(data['env'].staticDir).toBe('');
    expect(data['env'].corsOrigins).toEqual(['http://127.0.0.1:4173']);
    expect(data['capabilities'].agents.entries).toEqual(['claude', 'codex', 'deepseek']);
    expect(JSON.stringify(data['capabilities'].agents)).not.toMatch(/copilot|opencode|vscode/);
    expect(data['capabilities'].sse).toBe(true);
    expect(data['capabilities'].unsafeTools).toBe(false);
    // 能力开关是布尔（是否可用取决于 automation 适配器装配结果，不在此断言具体值）
    expect(typeof data['capabilities'].mcp.enabled).toBe('boolean');
    expect(typeof data['capabilities'].cli.enabled).toBe('boolean');
    expect(typeof data['capabilities'].mcp.sessions).toBe('number');
    expect(typeof data['capabilities'].cli.unsafeEnabled).toBe('boolean');
  });

  it('meta 与 health 响应不含任何密钥字段', async () => {
    api = await startApi({ engine: null });
    for (const path of ['/api/health', '/api/v1/meta']) {
      const response = await call<unknown>(api.baseUrl, 'GET', path);
      const keys = collectKeys(response.body);
      expect(keys.some((key) => /secret|token|password|credential|storageState/i.test(key))).toBe(false);
    }
  });
});

describe('通用错误与传输约束', () => {
  it('未知路径 404 NOT_FOUND（中文 message + requestId）', async () => {
    api = await startApi({ engine: null });
    const response = await call<{ error: { code: string; message: string; requestId: string } }>(
      api.baseUrl,
      'GET',
      '/api/v1/unknown',
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message.length).toBeGreaterThan(0);
    expect(response.body.error.requestId).toBeTruthy();
  });

  it('方法不允许 405 且带 Allow 头', async () => {
    api = await startApi({ engine: null });
    const response = await call(api.baseUrl, 'POST', '/api/health');
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect((response.body as { error: { code: string } }).error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('非 application/json 请求体 415', async () => {
    api = await startApi({ engine: null });
    const response = await call(api.baseUrl, 'POST', '/api/v1/cases', undefined, {
      rawBody: '{"name":"x"}',
      omitContentType: true,
    });
    expect(response.status).toBe(415);
    expect((response.body as { error: { code: string } }).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('非法 JSON 400 INVALID_JSON', async () => {
    api = await startApi({ engine: null });
    const response = await call(api.baseUrl, 'POST', '/api/v1/cases', undefined, { rawBody: '{bad json' });
    expect(response.status).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe('INVALID_JSON');
  });

  it('超过 1 MiB 请求体 413', async () => {
    api = await startApi({ engine: null });
    const payload = JSON.stringify({ name: 'x', description: 'a'.repeat(1024 * 1024 + 10) });
    const response = await call(api.baseUrl, 'POST', '/api/v1/cases', undefined, { rawBody: payload });
    expect(response.status).toBe(413);
    expect((response.body as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('CORS 只回显白名单来源', async () => {
    api = await startApi({ engine: null });
    const allowed = await call(api.baseUrl, 'GET', '/api/health', undefined, {
      headers: { origin: 'http://127.0.0.1:4173' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4173');
    expect(allowed.headers.get('access-control-expose-headers')).toContain('x-request-id');

    const denied = await call(api.baseUrl, 'GET', '/api/health', undefined, {
      headers: { origin: 'http://evil.example' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('OPTIONS 预检返回 204', async () => {
    api = await startApi({ engine: null });
    const response = await call(api.baseUrl, 'OPTIONS', '/api/v1/cases');
    expect(response.status).toBe(204);
  });
});