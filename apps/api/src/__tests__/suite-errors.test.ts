/**
 * F-SUITE-1 回归：套件成员用例「引擎级失败」不得被吞成 passed。
 *
 * 覆盖：A 合法 + B 编译失败、单 B 失败、全合法套件、成员抛错、数据驱动成员失败逐行可见。
 * 断言终态/error/items/诊断，不只断言 HTTP 200。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { call, cleanupDir, dataOf, startApi, waitFor, type TestApi } from './helpers.ts';
import { createFakeEngine, type FakeEngine } from './fake-engine.ts';

let api: TestApi | null = null;

afterEach(async () => {
  if (api) {
    await api.close();
    cleanupDir(api.dataDir);
    api = null;
  }
});

const caseSteps = (value: string): unknown[] => [
  { id: 'st_1', action: 'goto', url: 'http://127.0.0.1:4174/login' },
  { id: 'st_2', action: 'expectText', target: { by: 'text', text: '欢迎' }, value },
];

async function createCase(name: string, value = '欢迎，访客'): Promise<string> {
  const response = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/cases', {
    name,
    mode: 'steps',
    steps: caseSteps(value),
  });
  expect(response.status).toBe(201);
  return dataOf(response).id;
}

async function createSuite(name: string, caseIds: string[]): Promise<string> {
  const response = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/suites', { name, caseIds });
  expect(response.status).toBe(201);
  return dataOf(response).id;
}

async function waitRun(runId: string): Promise<Record<string, any>> {
  const response = await waitFor(
    () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${runId}`),
    (result) => ['passed', 'failed', 'cancelled', 'error'].includes(result.body.data.status),
    8000,
  );
  return response.body.data;
}

async function runSuite(suiteId: string): Promise<Record<string, any>> {
  const created = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/runs', {
    target: { kind: 'suite', suiteId },
  });
  expect(created.status).toBe(202);
  return waitRun(created.body.data.id);
}

async function runCase(caseId: string): Promise<Record<string, any>> {
  const created = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/runs', {
    target: { kind: 'case', caseId },
  });
  expect(created.status).toBe(202);
  return waitRun(created.body.data.id);
}

async function itemsOf(runId: string): Promise<Record<string, any>[]> {
  const response = await call<{ data: { items: Record<string, any>[] } }>(api!.baseUrl, 'GET', `/api/v1/runs/${runId}/items`);
  return response.body.data.items;
}

/** 让指定成员用例在引擎层失败（模拟编译失败 / 无报告等 status=error 结果） */
function makeCaseEngineError(engine: FakeEngine, caseId: string, code: string, message: string): void {
  engine.engineErrors[caseId] = { code, message };
}

describe('套件成员引擎失败（F-SUITE-1）', () => {
  it('A 合法 + B 引擎 error：status=error、保留 A 的 items/stats/exitCode/命令回显，B 以 missing 项可见', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const caseA = await createCase('A 合法用例');
    const caseB = await createCase('B 编译失败用例', '');
    makeCaseEngineError(engine, caseB, 'INVALID_STEP', 'expectText 缺少必填的 value');
    const suiteId = await createSuite('A+B 套件', [caseA, caseB]);

    const run = await runSuite(suiteId);
    expect(run.status).toBe('error');
    expect(run.error).not.toBeNull();
    expect(run.error.code).toBe('INVALID_STEP');
    expect(run.error.message).toContain('套件中 1 个成员用例执行失败');
    expect(run.error.message).toContain(caseB);
    expect(run.error.detail.cases).toHaveLength(1);
    expect(run.error.detail.cases[0]).toMatchObject({ caseId: caseB, code: 'INVALID_STEP' });

    // 已产出的 A 结果保留
    expect(run.stats).toMatchObject({ expected: 1, unexpected: 0 });
    expect(run.exitCode).toBe(0);
    expect(run.itemsCount).toBe(2);
    // 失败成员的 command 为 []，不得覆盖 A 已回显的官方命令
    expect(run.diagnostics.command.length).toBeGreaterThan(0);
    expect(run.diagnostics.warnings.some((warning: string) => warning.includes(caseB))).toBe(true);

    const items = await itemsOf(run.id);
    const itemA = items.find((item) => item.caseId === caseA);
    const itemB = items.find((item) => item.caseId === caseB);
    expect(itemA?.outcome).toBe('expected');
    expect(itemB?.outcome).toBe('missing');
    expect(itemB?.title).toContain('未执行：INVALID_STEP');
    expect(itemB?.attempts[0].status).toBe('failed');
    expect(itemB?.attempts[0].error.message).toContain('缺少必填的 value');
    expect(itemB?.attempts[0].errorHash).not.toBe('');
  });

  it('单 B 失败：与套件场景一致（status=error + INVALID_STEP + missing 项），不再是无诊断的 failed', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const caseB = await createCase('B 编译失败用例', '');
    makeCaseEngineError(engine, caseB, 'INVALID_STEP', 'expectText 缺少必填的 value');

    const run = await runCase(caseB);
    expect(run.status).toBe('error');
    expect(run.error.code).toBe('INVALID_STEP');
    expect(run.error.message).toContain(caseB);
    expect(run.stats.expected).toBe(0);
    expect(run.exitCode).toBeNull();
    expect(run.itemsCount).toBe(1);

    const items = await itemsOf(run.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.itemKey).toBe(caseB);
    expect(items[0]?.outcome).toBe('missing');
    expect(items[0]?.attempts[0].status).toBe('failed');
    expect(items[0]?.attempts[0].error.message).toContain('缺少必填的 value');
  });

  it('全合法套件：仍正常 passed（不误伤）', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const caseA = await createCase('A 合法用例');
    const caseC = await createCase('C 合法用例');
    const suiteId = await createSuite('全合法套件', [caseA, caseC]);

    const run = await runSuite(suiteId);
    expect(run.status).toBe('passed');
    expect(run.error).toBeNull();
    expect(run.exitCode).toBe(0);
    expect(run.stats).toMatchObject({ expected: 2, unexpected: 0, flaky: 0, skipped: 0 });
    expect(run.itemsCount).toBe(2);

    const items = await itemsOf(run.id);
    expect(items.map((item) => item.outcome)).toEqual(['expected', 'expected']);
    expect(items.every((item) => item.attempts[0].status === 'passed')).toBe(true);
  });

  it('成员抛错：运行 error，已完成成员结果保留、抛错成员以 missing 项可见', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const caseA = await createCase('A 合法用例');
    const caseD = await createCase('D 抛错用例');
    engine.caseRejects[caseD] = '子进程启动失败（fake）';
    const suiteId = await createSuite('抛错套件', [caseA, caseD]);

    const run = await runSuite(suiteId);
    expect(run.status).toBe('error');
    expect(run.error.code).toBe('ENGINE_ERROR');
    expect(run.error.message).toContain('子进程启动失败');
    expect(run.stats.expected).toBe(1);
    expect(run.itemsCount).toBe(2);

    const items = await itemsOf(run.id);
    expect(items.find((item) => item.caseId === caseA)?.outcome).toBe('expected');
    const itemD = items.find((item) => item.caseId === caseD);
    expect(itemD?.outcome).toBe('missing');
    expect(itemD?.attempts[0].error.message).toContain('子进程启动失败');
  });

  it('数据驱动成员失败：每个启用行各留一条 missing 项（rowIndex 为原始稳定行号）', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const caseE = await createCase('E 数据驱动用例', '{{expect}}');
    const dataset = await call<{ data: { id: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseE}/datasets`, {
      name: '两行启用一行禁用',
      rows: [
        { data: { expect: '欢迎，访客' } },
        { data: { expect: '禁用的行' }, enabled: false },
        { data: { expect: '欢迎，访客' } },
      ],
    });
    expect(dataset.status).toBe(201);
    makeCaseEngineError(engine, caseE, 'ENGINE_ERROR', '数据驱动成员整体失败（fake）');
    const suiteId = await createSuite('数据驱动套件', [caseE]);

    const run = await runSuite(suiteId);
    expect(run.status).toBe('error');
    expect(run.error.code).toBe('ENGINE_ERROR');
    expect(run.itemsCount).toBe(2);

    const items = await itemsOf(run.id);
    expect(items.map((item) => item.rowIndex)).toEqual([0, 2]);
    expect(items.every((item) => item.outcome === 'missing')).toBe(true);
    for (const item of items) {
      expect(item.itemKey).toBe(`${caseE}#row:${String(item.rowIndex)}`);
      expect(item.attempts[0].status).toBe('failed');
    }
  });
});