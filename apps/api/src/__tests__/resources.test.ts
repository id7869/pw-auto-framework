import { afterEach, describe, expect, it } from 'vitest';
import { call, cleanupDir, dataOf, startApi, type TestApi } from './helpers.ts';

let api: TestApi | null = null;

afterEach(async () => {
  if (api) {
    await api.close();
    cleanupDir(api.dataDir);
    api = null;
  }
});

async function createCase(name: string): Promise<string> {
  const response = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/cases', {
    name,
    steps: [{ id: 'st_1', action: 'goto', url: 'http://127.0.0.1:4174/' }],
  });
  expect(response.status).toBe(201);
  return dataOf(response).id;
}

async function createDataset(caseId: string, rows: unknown[], name = '数据集'): Promise<string> {
  const response = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
    name,
    source: 'manual',
    rows,
  });
  expect(response.status).toBe(201);
  return dataOf(response).id;
}

describe('数据集 CRUD 与边界', () => {
  it('创建后推导列、统计总行数与启用行数', async () => {
    api = await startApi({ engine: null });
    const caseId = await createCase('数据驱动用例');
    const response = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '登录数据',
      source: 'manual',
      rows: [
        { data: { name: '甲', age: 1, vip: true }, enabled: true },
        { data: { name: '乙', age: 2, vip: false }, enabled: false },
      ],
    });
    expect(response.status).toBe(201);
    const dataset = dataOf(response);
    expect(dataset.id).toMatch(/^ds_/);
    expect(dataset.caseId).toBe(caseId);
    expect(dataset.columns).toEqual(['name', 'age', 'vip']);
    expect(dataset.rowsCount).toBe(2);
    expect(dataset.enabledRowsCount).toBe(1);
  });

  it('行列表支持游标分页与 enabled 过滤，rowIndex 0 基稳定', async () => {
    api = await startApi({ engine: null });
    const caseId = await createCase('行分页');
    const datasetId = await createDataset(caseId, [
      { data: { a: '1' } },
      { data: { a: '2' }, enabled: false },
      { data: { a: '3' } },
    ]);

    const firstPage = await call<{ data: { items: { rowIndex: number; enabled: boolean }[]; hasMore: boolean; nextCursor: string | null } }>(
      api.baseUrl,
      'GET',
      `/api/v1/datasets/${datasetId}/rows?limit=2`,
    );
    expect(firstPage.body.data.items).toHaveLength(2);
    expect(firstPage.body.data.items.map((row) => row.rowIndex)).toEqual([0, 1]);
    expect(firstPage.body.data.hasMore).toBe(true);

    const secondPage = await call<{ data: { items: { rowIndex: number }[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/datasets/${datasetId}/rows?limit=2&cursor=${encodeURIComponent(firstPage.body.data.nextCursor as string)}`,
    );
    expect(secondPage.body.data.items.map((row) => row.rowIndex)).toEqual([2]);

    const enabledOnly = await call<{ data: { items: { rowIndex: number }[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/datasets/${datasetId}/rows?enabled=true`,
    );
    expect(enabledOnly.body.data.items.map((row) => row.rowIndex)).toEqual([0, 2]);
  });

  it('PUT rows 全量替换：行号重排、列集合重算、旧行失效', async () => {
    api = await startApi({ engine: null });
    const caseId = await createCase('替换行');
    const datasetId = await createDataset(caseId, [{ data: { a: '1' } }, { data: { a: '2' } }]);

    const replaced = await call<{ data: { columns: string[]; rowsCount: number; enabledRowsCount: number } }>(
      api.baseUrl,
      'PUT',
      `/api/v1/datasets/${datasetId}/rows`,
      { rows: [{ data: { title: 'x', flag: true } }] },
    );
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.columns).toEqual(['title', 'flag']);
    expect(replaced.body.data.rowsCount).toBe(1);

    const rows = await call<{ data: { items: { rowIndex: number; data: Record<string, unknown> }[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/datasets/${datasetId}/rows`,
    );
    expect(rows.body.data.items[0]!.rowIndex).toBe(0);
    expect(rows.body.data.items[0]!.data).toEqual({ title: 'x', flag: true });
  });

  it('行数超 500 → 422 ROW_LIMIT_EXCEEDED', async () => {
    api = await startApi({ engine: null });
    const caseId = await createCase('行上限');
    const rows = Array.from({ length: 501 }, (_, index) => ({ data: { a: String(index) } }));
    const response = await call<{ error: { code: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '超限',
      rows,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('ROW_LIMIT_EXCEEDED');
  });

  it('单元格超 8192 字符 → 422 ROW_TOO_LARGE', async () => {
    api = await startApi({ engine: null });
    const caseId = await createCase('单元格上限');
    const response = await call<{ error: { code: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '超长',
      rows: [{ data: { a: 'x'.repeat(8193) } }],
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('ROW_TOO_LARGE');
  });

  it('列数超 50 → 422 INVALID_DATASET；列名含 {{ }} → 422 INVALID_DATASET', async () => {
    api = await startApi({ engine: null });
    const caseId = await createCase('列上限');

    const wide: Record<string, string> = {};
    for (let index = 0; index < 51; index += 1) wide[`c${index}`] = 'v';
    const tooManyColumns = await call<{ error: { code: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '宽表',
      rows: [{ data: wide }],
    });
    expect(tooManyColumns.status).toBe(422);
    expect(tooManyColumns.body.error.code).toBe('INVALID_DATASET');

    const badName = await call<{ error: { code: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '坏列名',
      rows: [{ data: { '{{x}}': 'v' } }],
    });
    expect(badName.status).toBe(422);
    expect(badName.body.error.code).toBe('INVALID_DATASET');
  });

  it('重命名、软删除与 404 语义', async () => {
    api = await startApi({ engine: null });
    const caseId = await createCase('重命名');
    const datasetId = await createDataset(caseId, [{ data: { a: '1' } }]);

    const renamed = await call<{ data: { name: string } }>(api.baseUrl, 'PATCH', `/api/v1/datasets/${datasetId}`, {
      name: '新名字',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('新名字');

    expect((await call(api.baseUrl, 'DELETE', `/api/v1/datasets/${datasetId}`)).status).toBe(204);
    expect((await call(api.baseUrl, 'GET', `/api/v1/datasets/${datasetId}`)).status).toBe(404);
    expect((await call(api.baseUrl, 'GET', `/api/v1/datasets/${datasetId}/rows`)).status).toBe(404);
  });

  it('不存在用例下的数据集列表 → 404', async () => {
    api = await startApi({ engine: null });
    const response = await call(api.baseUrl, 'GET', '/api/v1/cases/case_missing/datasets');
    expect(response.status).toBe(404);
  });
});

describe('套件 CRUD', () => {
  it('创建/查询/改成员/改名/删除；成员数正确', async () => {
    api = await startApi({ engine: null });
    const [c1, c2, c3] = [await createCase('用例1'), await createCase('用例2'), await createCase('用例3')];

    const created = await call<{ data: { id: string; caseIds: string[]; casesCount: number } }>(api.baseUrl, 'POST', '/api/v1/suites', {
      name: '冒烟套件',
      description: '演示',
      caseIds: [c1, c2],
    });
    expect(created.status).toBe(201);
    const suiteId = created.body.data.id;
    expect(created.body.data.caseIds).toEqual([c1, c2]);
    expect(created.body.data.casesCount).toBe(2);

    const replaced = await call<{ data: { caseIds: string[] } }>(api.baseUrl, 'PUT', `/api/v1/suites/${suiteId}/cases`, {
      caseIds: [c3, c1],
    });
    expect(replaced.body.data.caseIds).toEqual([c3, c1]);

    const patched = await call<{ data: { name: string } }>(api.baseUrl, 'PATCH', `/api/v1/suites/${suiteId}`, {
      name: '改名套件',
    });
    expect(patched.body.data.name).toBe('改名套件');

    const list = await call<{ data: { items: { name: string }[] } }>(api.baseUrl, 'GET', '/api/v1/suites?q=改名');
    expect(list.body.data.items).toHaveLength(1);

    expect((await call(api.baseUrl, 'DELETE', `/api/v1/suites/${suiteId}`)).status).toBe(204);
    expect((await call(api.baseUrl, 'GET', `/api/v1/suites/${suiteId}`)).status).toBe(404);
  });

  it('引用不存在用例 → 422 UNKNOWN_CASE；重复成员 → 422 VALIDATION_FAILED', async () => {
    api = await startApi({ engine: null });
    const caseId = await createCase('存在');

    const unknown = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/suites', {
      name: '坏套件',
      caseIds: [caseId, 'case_missing'],
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('UNKNOWN_CASE');

    const duplicated = await call<{ error: { code: string; message: string } }>(api.baseUrl, 'POST', '/api/v1/suites', {
      name: '重复套件',
      caseIds: [caseId, caseId],
    });
    expect(duplicated.status).toBe(422);
    expect(duplicated.body.error.message).toContain('重复');
  });
});