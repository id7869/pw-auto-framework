import { afterEach, describe, expect, it } from 'vitest';
import { call, cleanupDir, dataOf, startApi, type TestApi } from './helpers.ts';
import { createFakeEngine } from './fake-engine.ts';

let api: TestApi | null = null;

afterEach(async () => {
  if (api) {
    await api.close();
    cleanupDir(api.dataDir);
    api = null;
  }
});

const stepsCase = {
  name: '登录流程',
  description: '演示用例',
  mode: 'steps' as const,
  tags: ['@smoke', '登录'],
  steps: [
    { id: 'st_1', action: 'goto', url: 'http://127.0.0.1:4174/login' },
    { id: 'st_2', action: 'fill', target: { by: 'label', text: '用户名' }, value: '{{name}}' },
    { id: 'st_3', action: 'click', target: { by: 'role', role: 'button', name: '登录' } },
    { id: 'st_4', action: 'expectVisible', target: { by: 'text', text: '欢迎' } },
  ],
};

async function createCase(): Promise<string> {
  const response = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/cases', stepsCase);
  expect(response.status).toBe(201);
  return dataOf(response).id;
}

describe('用例 CRUD', () => {
  it('创建返回 201 与完整资源（version=1、status=active）', async () => {
    api = await startApi({ engine: null });
    const response = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', '/api/v1/cases', stepsCase);
    expect(response.status).toBe(201);
    const created = dataOf(response);
    expect(created.id).toMatch(/^case_/);
    expect(created.version).toBe(1);
    expect(created.status).toBe('active');
    expect(created.mode).toBe('steps');
    expect(created.steps).toHaveLength(4);
    expect(created.code).toBeNull();
    expect(created.deletedAt).toBeNull();
    expect(created.tags).toEqual(['@smoke', '登录']);
  });

  it('列表省略 steps/code，仅给 stepsCount，并支持 q/tag/status 过滤与游标分页', async () => {
    api = await startApi({ engine: null });
    const stepsCaseId = await createCase();
    await call(api.baseUrl, 'POST', '/api/v1/cases', { name: '另一个', mode: 'code', code: 'test("x", async () => {});' });

    const page = await call<{ data: { items: Record<string, any>[]; nextCursor: string | null; hasMore: boolean } }>(
      api.baseUrl,
      'GET',
      '/api/v1/cases?limit=1',
    );
    expect(page.status).toBe(200);
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.data.hasMore).toBe(true);
    expect(page.body.data.nextCursor).toBeTruthy();
    expect('steps' in page.body.data.items[0]!).toBe(false);
    expect('code' in page.body.data.items[0]!).toBe(false);

    const second = await call<{ data: { items: Record<string, any>[]; hasMore: boolean } }>(
      api.baseUrl,
      'GET',
      `/api/v1/cases?limit=1&cursor=${encodeURIComponent(page.body.data.nextCursor as string)}`,
    );
    expect(second.body.data.items).toHaveLength(1);
    expect(second.body.data.items[0]!.id).not.toBe(page.body.data.items[0]!.id);

    const stepsCase = await call<{ data: { items: Record<string, any>[] } }>(
      api.baseUrl,
      'GET',
      '/api/v1/cases?q=登录',
    );
    expect(stepsCase.body.data.items).toHaveLength(1);
    expect(stepsCase.body.data.items[0]!.id).toBe(stepsCaseId);
    expect(stepsCase.body.data.items[0]!.stepsCount).toBe(4);

    const byTag = await call<{ data: { items: Record<string, any>[] } }>(api.baseUrl, 'GET', '/api/v1/cases?tag=@smoke');
    expect(byTag.body.data.items).toHaveLength(1);

    const byQ = await call<{ data: { items: Record<string, any>[] } }>(api.baseUrl, 'GET', '/api/v1/cases?q=登录');
    expect(byQ.body.data.items).toHaveLength(1);
  });

  it('PATCH 需要 If-Match：版本匹配则 version+1，过期 409，缺失 422', async () => {
    api = await startApi({ engine: null });
    const caseId = await createCase();

    const stale = await call(api.baseUrl, 'PATCH', `/api/v1/cases/${caseId}`, { name: '改个名' }, { headers: { 'if-match': '"1"' } });
    expect(stale.status).toBe(200);
    expect((stale.body as { data: { version: number; name: string } }).data.version).toBe(2);
    expect((stale.body as { data: { name: string } }).data.name).toBe('改个名');

    const conflict = await call(api.baseUrl, 'PATCH', `/api/v1/cases/${caseId}`, { name: '再次改名' }, { headers: { 'if-match': '"1"' } });
    expect(conflict.status).toBe(409);
    expect((conflict.body as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT');

    const missing = await call(api.baseUrl, 'PATCH', `/api/v1/cases/${caseId}`, { name: '无版本' });
    expect(missing.status).toBe(422);
    expect((missing.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');

    const invalidHeader = await call(api.baseUrl, 'PATCH', `/api/v1/cases/${caseId}`, { name: 'x' }, { headers: { 'if-match': 'abc' } });
    expect(invalidHeader.status).toBe(422);
  });

  it('步骤语义非法 → 422 INVALID_STEP（带 path 明细）', async () => {
    api = await startApi({ engine: null });
    const response = await call<{ error: { code: string; details: { path: string; message: string }[] } }>(
      api.baseUrl,
      'POST',
      '/api/v1/cases',
      { name: '坏用例', steps: [{ id: 'st_1', action: 'fill' }] },
    );
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INVALID_STEP');
    expect(response.body.error.details.map((item) => item.path)).toEqual(['steps[0].target', 'steps[0].value']);
    expect(response.body.error.details[0]!.message).toContain('target');
  });

  it('两种模式互斥：steps 模式带 code / code 模式带 steps / code 为空都 422', async () => {
    api = await startApi({ engine: null });
    const withCode = await call(api.baseUrl, 'POST', '/api/v1/cases', { name: 'x', mode: 'steps', code: 'test()' });
    expect(withCode.status).toBe(422);

    const codeWithSteps = await call(api.baseUrl, 'POST', '/api/v1/cases', {
      name: 'y',
      mode: 'code',
      code: 'test("a", async () => {});',
      steps: [{ id: 'st_1', action: 'screenshot' }],
    });
    expect(codeWithSteps.status).toBe(422);

    const emptyCode = await call(api.baseUrl, 'POST', '/api/v1/cases', { name: 'z', mode: 'code', code: '  ' });
    expect(emptyCode.status).toBe(422);
  });

  it('css 兜底定位允许保存（只做警告，不阻断）', async () => {
    api = await startApi({ engine: null });
    const response = await call(api.baseUrl, 'POST', '/api/v1/cases', {
      name: 'css 用例',
      steps: [{ id: 'st_1', action: 'click', target: { by: 'css', selector: '#submit' } }],
    });
    expect(response.status).toBe(201);
  });

  it('validate：成功返回统计与 css 警告；引用不存在的数据列 → 422 UNKNOWN_COLUMN', async () => {
    api = await startApi({ engine: null });
    const caseId = await createCase();

    const okValidate = await call<{ data: { ok: boolean; stepsCount: number; rowsCount: number; warnings: { code: string }[] } }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${caseId}/validate`,
      {},
    );
    expect(okValidate.status).toBe(200);
    expect(okValidate.body.data.ok).toBe(true);
    expect(okValidate.body.data.stepsCount).toBe(4);
    expect(okValidate.body.data.rowsCount).toBe(0);

    const dsResponse = await call<{ data: { id: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '错误列数据集',
      rows: [{ data: { title: 'A' } }],
    });
    expect(dsResponse.status).toBe(201);

    const unknownColumn = await call<{ error: { code: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/validate`, {
      datasetId: dsResponse.body.data.id,
    });
    expect(unknownColumn.status).toBe(422);
    expect(unknownColumn.body.error.code).toBe('UNKNOWN_COLUMN');
  });

  it('删除是软删除且幂等：204 → 404；历史快照不受影响（运行仍可创建于快照前）', async () => {
    api = await startApi({ engine: null });
    const caseId = await createCase();
    const first = await call(api.baseUrl, 'DELETE', `/api/v1/cases/${caseId}`);
    expect(first.status).toBe(204);
    const second = await call(api.baseUrl, 'DELETE', `/api/v1/cases/${caseId}`);
    expect(second.status).toBe(204);
    const get = await call(api.baseUrl, 'GET', `/api/v1/cases/${caseId}`);
    expect(get.status).toBe(404);
  });

  it('不存在的用例返回 404；非法 id 形状仍按 NOT_FOUND 处理', async () => {
    api = await startApi({ engine: null });
    const missing = await call(api.baseUrl, 'GET', '/api/v1/cases/case_not_exist');
    expect(missing.status).toBe(404);
    expect((missing.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('tags 去重且上限 20（超限 422）', async () => {
    api = await startApi({ engine: null });
    const dedupe = await call<{ data: { tags: string[] } }>(api.baseUrl, 'POST', '/api/v1/cases', {
      name: 'tag 用例',
      tags: ['a', 'a', 'b'],
    });
    expect(dedupe.body.data.tags).toEqual(['a', 'b']);

    const tooMany = await call(api.baseUrl, 'POST', '/api/v1/cases', {
      name: 'tag 太多',
      tags: Array.from({ length: 21 }, (_, index) => `t${index}`),
    });
    expect(tooMany.status).toBe(422);
  });
});

// F2 回归：validate 必须与真实运行一致地解析数据集（启用行 + 列集合），
// 且必须把列/行随 caseSnapshot 传给官方 compile（否则合法变量被误报 UNKNOWN_COLUMN）。
describe('validate 与数据集列解析（F2 回归）', () => {
  const variableSteps = [
    { id: 'st_1', action: 'goto', url: 'http://127.0.0.1:4174/login' },
    { id: 'st_2', action: 'fill', target: { by: 'label', text: '用户名' }, value: '{{name}}' },
  ];

  async function createVariableCase(): Promise<string> {
    const response = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/cases', {
      name: '变量用例',
      mode: 'steps',
      steps: variableSteps,
    });
    expect(response.status).toBe(201);
    return dataOf(response).id;
  }

  async function createDataset(caseId: string, rows: unknown[], name = '数据集'): Promise<string> {
    const response = await call<{ data: { id: string; columns: string[]; enabledRowsCount: number } }>(
      api!.baseUrl,
      'POST',
      `/api/v1/cases/${caseId}/datasets`,
      { name, rows },
    );
    expect(response.status).toBe(201);
    return dataOf(response).id;
  }

  it('带数据集合法列：ok=true、rowsCount=启用行数，且 compile 收到 columns/rows/datasetId', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const caseId = await createVariableCase();
    const datasetId = await createDataset(caseId, [
      { data: { name: '甲' } },
      { data: { name: '乙' }, enabled: false },
      { data: { name: '丙' } },
    ]);

    const response = await call<{
      data: { ok: boolean; rowsCount: number; stepsCount: number; warnings: { code: string; message: string }[] };
    }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/validate`, { datasetId });

    expect(response.status).toBe(200);
    expect(response.body.data.ok).toBe(true);
    expect(response.body.data.rowsCount).toBe(2);
    expect(response.body.data.stepsCount).toBe(2);
    expect(response.body.data.warnings.some((warning) => warning.code === 'UNKNOWN_COLUMN')).toBe(false);

    // 核心断言：传给官方 compile 的快照必须带数据集列与启用行（不能只测返回码）
    expect(engine.compileCalls).toHaveLength(1);
    const snapshot = engine.compileCalls[0]!.caseSnapshot;
    expect(snapshot.columns).toEqual(['name']);
    expect(snapshot.datasetId).toBe(datasetId);
    expect(snapshot.rows?.map((row) => row.rowIndex)).toEqual([0, 2]);
    expect(snapshot.rows?.map((row) => row.data)).toEqual([{ name: '甲' }, { name: '丙' }]);
  });

  it('未知列：本地前置校验阻断 → 422 UNKNOWN_COLUMN（不进入 compile，不降低强度）', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const caseId = await createVariableCase();
    const datasetId = await createDataset(caseId, [{ data: { title: 'x' } }]);

    const response = await call<{ error: { code: string; details: { path: string }[] } }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${caseId}/validate`,
      { datasetId },
    );
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('UNKNOWN_COLUMN');
    expect(response.body.error.details[0]!.path).toBe('steps[1]');
    expect(engine.compileCalls).toHaveLength(0);
  });

  it('禁用行：全部 disabled → 422 EMPTY_DATASET（与真实运行一致）', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const caseId = await createVariableCase();
    const datasetId = await createDataset(caseId, [{ data: { name: 'x' }, enabled: false }]);

    const response = await call<{ error: { code: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/validate`, {
      datasetId,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('EMPTY_DATASET');
    expect(engine.compileCalls).toHaveLength(0);
  });

  it('无 datasetId：行为不变（无变量用例 ok=true，快照不带数据集字段）', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const caseId = await createCase();
    const validate = await call<{ data: { ok: boolean; rowsCount: number; stepsCount: number } }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${caseId}/validate`,
      {},
    );
    expect(validate.status).toBe(200);
    expect(validate.body.data.ok).toBe(true);
    expect(validate.body.data.rowsCount).toBe(0);
    expect(validate.body.data.stepsCount).toBe(4);

    expect(engine.compileCalls).toHaveLength(1);
    const snapshot = engine.compileCalls[0]!.caseSnapshot;
    expect(snapshot.columns).toBeUndefined();
    expect(snapshot.rows).toBeUndefined();
    expect(snapshot.datasetId).toBeUndefined();
  });

  it('官方 compile 返回错误时不伪造成功：ok=false 且 errors 以 warning 回显', async () => {
    const engine = createFakeEngine({
      compile: {
        ok: false,
        stepsCount: 1,
        rowsCount: 0,
        warnings: [],
        errors: [{ code: 'INVALID_STEP', message: '第 1 步 action 非法（fake）', path: 'steps[0]' }],
        specSource: null,
        specFileName: null,
        itemKeys: [],
      },
    });
    api = await startApi({ engine });
    const caseId = await createCase();

    const response = await call<{ data: { ok: boolean; warnings: { code: string; message: string }[] } }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${caseId}/validate`,
      {},
    );
    expect(response.status).toBe(200);
    expect(response.body.data.ok).toBe(false);
    expect(response.body.data.warnings.some((warning) => warning.code === 'INVALID_STEP')).toBe(true);
    expect(engine.compileCalls).toHaveLength(1);
  });
});