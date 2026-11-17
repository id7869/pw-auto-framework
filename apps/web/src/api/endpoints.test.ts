import { describe, expect, it } from 'vitest';
import { Api, loadAllDatasetRows } from './endpoints.ts';
import { ApiClient } from './http.ts';
import { DEFAULT_RUN_OPTIONS } from '../lib/validation.ts';

interface Recorded {
  url: string;
  method: string;
  body: string | undefined;
  headers: Headers;
}

function makeApi(handler?: (recorded: Recorded) => Response): { api: Api; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client = new ApiClient({
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const recorded: Recorded = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
        headers: new Headers(init?.headers),
      };
      calls.push(recorded);
      return handler ? handler(recorded) : new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof fetch,
    getRetries: 0,
    sleep: async () => undefined,
  });
  return { api: new Api(client), calls };
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('api/endpoints：路径、方法与合同字段', () => {
  it('用例列表带过滤条件', async () => {
    const { api, calls } = makeApi(() => ok({ items: [], nextCursor: null, hasMore: false }));
    await api.listCases({ limit: 20, q: '登录', status: 'active', tag: '@fast' });
    const call = calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url).toContain('/api/v1/cases?');
    expect(call?.url).toContain('limit=20');
    expect(call?.url).toContain(`q=${encodeURIComponent('登录')}`);
    expect(call?.url).toContain('status=active');
    expect(call?.url).toContain(`tag=${encodeURIComponent('@fast')}`);
  });

  it('PATCH 用例带引号版本号 If-Match', async () => {
    const { api, calls } = makeApi(() => ok({ id: 'case_1', version: 2 }));
    await api.patchCase('case_1', 3, { name: '改名' });
    const call = calls[0];
    expect(call?.method).toBe('PATCH');
    expect(call?.url).toContain('/api/v1/cases/case_1');
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(call?.headers.get('Content-Type')).toContain('application/json');
    expect(call?.body).toBe(JSON.stringify({ name: '改名' }));
  });

  it('创建/删除用例：POST 与 204', async () => {
    const { api, calls } = makeApi((recorded) =>
      recorded.method === 'DELETE' ? new Response(null, { status: 204 }) : ok({ id: 'case_2' }),
    );
    await api.createCase({ name: '新用例' });
    await api.deleteCase('case_2');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/api/v1/cases');
    expect(calls[1]?.method).toBe('DELETE');
    expect(calls[1]?.url).toContain('/api/v1/cases/case_2');
  });

  it('校验用例带 datasetId', async () => {
    const { api, calls } = makeApi(() => ok({ ok: true, compiledSpecPath: null, stepsCount: 3, rowsCount: 2, warnings: [] }));
    await api.validateCase('case_1', { datasetId: 'ds_1' });
    expect(calls[0]?.url).toContain('/api/v1/cases/case_1/validate');
    expect(calls[0]?.body).toBe(JSON.stringify({ datasetId: 'ds_1' }));
  });

  it('数据集端点路径与全量替换', async () => {
    const { api, calls } = makeApi(() => ok({ id: 'ds_1' }));
    await api.listDatasets('case_1', { limit: 10 });
    await api.createDataset('case_1', { name: 'ds', source: 'json', rows: [{ data: { 名字: '张三' } }] });
    await api.replaceDatasetRows('ds_1', [{ data: { 名字: '李四' }, enabled: false }]);
    expect(calls[0]?.url).toContain('/api/v1/cases/case_1/datasets');
    expect(calls[1]?.method).toBe('POST');
    expect(calls[2]?.method).toBe('PUT');
    expect(calls[2]?.url).toContain('/api/v1/datasets/ds_1/rows');
    expect(calls[2]?.body).toBe(JSON.stringify({ rows: [{ data: { 名字: '李四' }, enabled: false }] }));
  });

  it('套件：创建与按顺序替换用例', async () => {
    const { api, calls } = makeApi(() => ok({ id: 'suite_1' }));
    await api.createSuite({ name: '回归', caseIds: ['case_1', 'case_2'] });
    await api.replaceSuiteCases('suite_1', ['case_2', 'case_1']);
    expect(calls[0]?.url).toContain('/api/v1/suites');
    expect(calls[1]?.url).toContain('/api/v1/suites/suite_1/cases');
    expect(calls[1]?.body).toBe(JSON.stringify({ caseIds: ['case_2', 'case_1'] }));
  });

  it('创建运行带 Idempotency-Key，未提供时无该头', async () => {
    const { api, calls } = makeApi(() => ok({ id: 'run_1', status: 'queued' }));
    await api.createRun({ target: { kind: 'case', caseId: 'case_1' } }, 'key-12345678');
    await api.createRun({ target: { kind: 'suite', suiteId: 'suite_1' } });
    expect(calls[0]?.headers.get('Idempotency-Key')).toBe('key-12345678');
    expect(calls[1]?.headers.get('Idempotency-Key')).toBeNull();
    expect(calls[0]?.body).toContain('"target"');
  });

  it('itemKey 在路径中安全编码；产物内容地址只按 id 拼接', async () => {
    const { api, calls } = makeApi(() => ok({ itemKey: 'case_a#row:1' }));
    await api.getRunItem('run_1', 'case_a#row:1');
    expect(calls[0]?.url).toContain('/api/v1/runs/run_1/items/case_a%23row%3A1');
    expect(api.artifactContentUrl('run_1', 'art_1')).toBe('/api/v1/runs/run_1/artifacts/art_1/content');
    expect(api.runEventsUrl('run_1')).toBe('/api/v1/runs/run_1/events');
  });

  it('取消运行走 POST /cancel，归档基线带 confirm:true', async () => {
    const { api, calls } = makeApi(() => ok({ id: 'base_1' }));
    await api.cancelRun('run_1');
    await api.archiveBaseline('base_1');
    await api.setDefaultBaseline('base_1');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/api/v1/runs/run_1/cancel');
    expect(calls[1]?.body).toBe(JSON.stringify({ confirm: true }));
    expect(calls[2]?.url).toContain('/api/v1/baselines/base_1/default');
    expect(calls[2]?.body).toBeUndefined();
  });

  it('数据集改名：PATCH {name} 后 GET 回读', async () => {
    let storedName = '旧名称';
    const { api, calls } = makeApi((recorded) => {
      if (recorded.method === 'PATCH') {
        const body = JSON.parse(recorded.body ?? '{}') as { name?: string };
        storedName = body.name ?? storedName;
        return ok({ id: 'ds_1', name: storedName });
      }
      if (recorded.method === 'GET') return ok({ id: 'ds_1', name: storedName });
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '未找到', requestId: 'r' } }), { status: 404 });
    });
    const renamed = await api.patchDataset('ds_1', { name: '新名称' });
    expect(renamed.ok).toBe(true);
    if (renamed.ok) expect(renamed.data.name).toBe('新名称');
    const readBack = await api.getDataset('ds_1');
    expect(readBack.ok).toBe(true);
    if (readBack.ok) expect(readBack.data.name).toBe('新名称');
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toContain('/api/v1/datasets/ds_1');
    expect(calls[0]?.body).toBe(JSON.stringify({ name: '新名称' }));
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.url).toContain('/api/v1/datasets/ds_1');
    expect(calls).toHaveLength(2);
  });

  it('创建运行网络失败后重试复用同一幂等键（请求头一致）', async () => {
    let attempt = 0;
    const { api, calls } = makeApi(() => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('network down');
      return ok({ id: 'run_2', status: 'queued' });
    });
    const first = await api.createRun({ target: { kind: 'case', caseId: 'case_1' } }, 'retry-key-1');
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe('NETWORK_ERROR');
    const second = await api.createRun({ target: { kind: 'case', caseId: 'case_1' } }, 'retry-key-1');
    expect(second.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get('Idempotency-Key')).toBe('retry-key-1');
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe('retry-key-1');
  });

  it('NL 读写、生成任务、Accept/Reject、只读代码预览与三 harness 端点', async () => {
    const { api, calls } = makeApi((recorded) => {
      if (recorded.url.includes('/accept')) {
        return ok({ case: { id: 'case_1' }, generation: { id: 'nlg_1', status: 'accepted' } });
      }
      if (recorded.url.includes('/reject')) return ok({ id: 'nlg_1', status: 'rejected' });
      if (recorded.url.includes('/spec')) return ok({ text: 'spec', stepsCount: 1, rowsCount: 0, warnings: [] });
      if (recorded.url.includes('/harnesses')) return ok({ items: [] });
      if (recorded.url.includes('/nl/generations') && recorded.method === 'POST') {
        return ok({ id: 'nlg_1', status: 'queued' });
      }
      if (recorded.url.includes('/nl/generations')) return ok({ items: [], nextCursor: null, hasMore: false });
      if (recorded.method === 'PUT') {
        return ok({ text: '新的 NL', status: 'draft', sourceHash: '0000000000000000', origin: null, generatorVersion: null, warnings: [], lines: [], updatedAt: '' });
      }
      return ok({});
    });
    await api.putCaseNl('case_1', '新的 NL');
    await api.createNlGeneration('case_1', { generator: 'agent' });
    await api.acceptNlGeneration('case_1', 'nlg_1', { force: true });
    await api.rejectNlGeneration('case_1', 'nlg_1', '定位不明确');
    await api.previewCaseSpec('case_1');
    await api.agentHarnesses();
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toContain('/api/v1/cases/case_1/nl');
    expect(calls[0]?.body).toBe(JSON.stringify({ text: '新的 NL' }));
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.url).toContain('/api/v1/cases/case_1/nl/generations');
    expect(calls[1]?.body).toBe(JSON.stringify({ generator: 'agent' }));
    expect(calls[2]?.url).toContain('/api/v1/cases/case_1/nl/generations/nlg_1/accept');
    expect(calls[2]?.body).toContain('"force":true');
    expect(calls[3]?.url).toContain('/api/v1/cases/case_1/nl/generations/nlg_1/reject');
    expect(calls[3]?.body).toBe(JSON.stringify({ reason: '定位不明确' }));
    expect(calls[4]?.url).toContain('/api/v1/cases/case_1/spec?preview=1');
    expect(calls[5]?.url).toContain('/api/v1/agents/harnesses');
  });

  it('运行选项 allowStaleNl 透传到 POST /runs', async () => {
    const { api, calls } = makeApi(() => ok({ id: 'run_1', status: 'queued' }));
    await api.createRun(
      {
        target: { kind: 'case', caseId: 'case_1' },
        options: { ...DEFAULT_RUN_OPTIONS, allowStaleNl: true },
      },
      'stale-key-1',
    );
    const body = JSON.parse(calls[0]?.body ?? '{}') as { options?: { allowStaleNl?: boolean } };
    expect(body.options?.allowStaleNl).toBe(true);
    expect(calls[0]?.headers.get('Idempotency-Key')).toBe('stale-key-1');
  });

  it('对比详情带 itemsLimit/itemsCursor', async () => {
    const { api, calls } = makeApi(() => ok({ comparison: { id: 'cmp_1' }, items: [], nextCursor: null, hasMore: false }));
    await api.getComparison('cmp_1', { itemsLimit: 50, itemsCursor: 'abc' });
    expect(calls[0]?.url).toContain('/api/v1/comparisons/cmp_1?');
    expect(calls[0]?.url).toContain('itemsLimit=50');
    expect(calls[0]?.url).toContain('itemsCursor=abc');
  });

  it('Agent 脚手架、提示词、产物索引与 MCP、CLI 端点', async () => {
    const { api, calls } = makeApi(() => ok({ items: [] }));
    await api.agentLoops();
    await api.createScaffold({ entry: 'claude', prompts: true, confirm: true }, 'idem-key-1');
    await api.agentPrompts('claude');
    await api.agentWorkspace({ path: 'specs/', scaffoldId: 'scf_1' });
    await api.createMcpSession({ caps: ['testing'], headless: true });
    await api.closeMcpSession('mcps_1');
    await api.cliCommands();
    await api.cliExec({ argv: ['snapshot', '--json'], session: 's1', timeoutMs: 30000, confirm: false });
    expect(calls[0]?.url).toContain('/api/v1/agents/loops');
    expect(calls[1]?.url).toContain('/api/v1/agents/scaffolds');
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({ entry: 'claude', prompts: true, confirm: true });
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe('idem-key-1');
    expect(calls[2]?.url).toContain('/api/v1/agents/prompts?loop=claude');
    expect(calls[3]?.url).toContain(`path=${encodeURIComponent('specs/')}`);
    expect(calls[3]?.url).toContain('scaffoldId=scf_1');
    expect(calls[4]?.url).toContain('/api/v1/mcp/sessions');
    expect(calls[5]?.method).toBe('DELETE');
    expect(calls[6]?.url).toContain('/api/v1/cli/commands');
    expect(calls[7]?.body).toBe(JSON.stringify({ argv: ['snapshot', '--json'], session: 's1', timeoutMs: 30000, confirm: false }));
  });

  it('loadAllDatasetRows 按游标翻页并在 hasMore=false 停止', async () => {
    let call = 0;
    const { api, calls } = makeApi(() => {
      call += 1;
      if (call === 1) {
        return ok({
          items: [{ id: 'row_1', datasetId: 'ds_1', rowIndex: 0, data: { 名字: '张三' }, enabled: true, createdAt: '', updatedAt: '' }],
          nextCursor: 'cursor-2',
          hasMore: true,
        });
      }
      return ok({
        items: [{ id: 'row_2', datasetId: 'ds_1', rowIndex: 1, data: { 名字: '李四' }, enabled: true, createdAt: '', updatedAt: '' }],
        nextCursor: null,
        hasMore: false,
      });
    });
    const result = await loadAllDatasetRows(api, 'ds_1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toHaveLength(2);
    expect(calls[0]?.url).toContain('limit=100');
    expect(calls[1]?.url).toContain('cursor=cursor-2');
  });
});