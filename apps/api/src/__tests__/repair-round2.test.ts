/**
 * repair-round-2（t22）回归：
 *  - PRD R3.5 失败原因分类（failureCategory，基于官方证据）
 *  - 幂等哈希覆盖完整请求体（target/datasetId/options/reason，options 归一化，字段顺序无关）
 *  - 数据集结构硬上限放宽后业务错误码（2001 行 → ROW_LIMIT_EXCEEDED，61 字符列名 → INVALID_DATASET）
 *  - PATCH 数据集 name 可选 + refine 至少一个字段
 *  - 归档基线不可再设默认
 *  - attempt.error.snippet 透传
 *  - running 期间 stats 单调递增（逐成员 saveRunProgress）
 *  - 排队取消后 queuePosition 归零且后续位次前移
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

async function createCase(name = 'repair2 用例'): Promise<string> {
  const response = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/cases', {
    name,
    steps: [{ id: 'st_1', action: 'goto', url: 'http://127.0.0.1:4174/login' }],
  });
  expect(response.status).toBe(201);
  return dataOf(response).id;
}

async function createSuite(caseIds: string[]): Promise<string> {
  const response = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/suites', {
    name: 'repair2 套件',
    caseIds,
  });
  expect(response.status).toBe(201);
  return dataOf(response).id;
}

async function waitRun(runId: string, timeoutMs = 8000): Promise<Record<string, any>> {
  const response = await waitFor(
    () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${runId}`),
    (result) => ['passed', 'failed', 'cancelled', 'error'].includes(result.body.data.status),
    timeoutMs,
  );
  return response.body.data;
}

async function runCase(caseId: string): Promise<Record<string, any>> {
  const created = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/runs', {
    target: { kind: 'case', caseId },
  });
  expect(created.status).toBe(202);
  return waitRun(created.body.data.id);
}

async function createBaseline(caseId: string, runId: string, name: string): Promise<Record<string, any>> {
  const response = await call<{ data: Record<string, any> }>(api!.baseUrl, 'POST', '/api/v1/baselines', {
    scope: 'case',
    scopeId: caseId,
    runId,
    name,
  });
  expect(response.status).toBe(201);
  return dataOf(response);
}

describe('PRD R3.5 失败原因分类（failureCategory）', () => {
  const cases: { label: string; message: string; expected: string; confidence: string }[] = [
    {
      label: 'locator 未找到（locator 超时优先于通用 timeout）',
      message: 'Timeout 5000ms exceeded.\nWaiting for locator("getByRole(\'button\', { name: \'登录\' })")',
      expected: 'locator_not_found',
      confidence: 'high',
    },
    { label: '通用超时', message: 'Timeout 30000ms exceeded.', expected: 'timeout', confidence: 'medium' },
    {
      label: '断言不匹配',
      message: 'expect(received).toHaveText(expected)\nExpected: "欢迎"\nReceived: "错误"',
      expected: 'assertion_mismatch',
      confidence: 'high',
    },
    {
      label: '网络错误',
      message: 'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4174/login',
      expected: 'network_error',
      confidence: 'high',
    },
    {
      label: '环境错误',
      message: "browserType.launch: Executable doesn't exist at C:\\ms-playwright\\chromium-1254\\chrome.exe",
      expected: 'environment_error',
      confidence: 'high',
    },
    {
      label: '导航错误',
      message: 'page.goto: Navigation interrupted by another action',
      expected: 'navigation_error',
      confidence: 'high',
    },
    {
      label: '数据错误',
      message: 'UNKNOWN_COLUMN: 第 2 步引用了数据集不存在的列：{{name}}',
      expected: 'data_error',
      confidence: 'high',
    },
    { label: '无法归因', message: '某种未分类的异常 XYZ', expected: 'unknown', confidence: 'low' },
  ];

  it('8 类官方证据模式均得到正确 failureCategory + confidence + evidence，change 仍为回归变化', async () => {
    const engine: FakeEngine = createFakeEngine();
    api = await startApi({ engine });
    const caseId = await createCase();
    const baseRun = await runCase(caseId);
    expect(baseRun.status).toBe('passed');
    const baseline = await createBaseline(caseId, baseRun.id, '基线');

    for (const scenario of cases) {
      engine.state.outcome = 'unexpected';
      engine.state.failMessage = scenario.message;
      const run = await runCase(caseId);
      expect(run.status).toBe('failed');

      const compared = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', '/api/v1/comparisons', {
        baselineId: baseline.id,
        runId: run.id,
      });
      expect(compared.status).toBe(201);
      const item = compared.body.data.items[0];
      expect(item.change).toBe('newly_failed');
      expect(item.attribution.failureCategory).toBe(scenario.expected);
      expect(item.attribution.confidence).toBe(scenario.confidence);
      expect(item.attribution.category).toBe('new_failure');
      expect(item.attribution.evidence.join('\n')).toContain('官方 error.message');
      expect(item.attribution.evidence.join('\n')).toContain('官方 errorLocation：fake.spec.ts:10:5');
    }
  });

  it('非失败变化（still_passed）不产生失败归因', async () => {
    const engine: FakeEngine = createFakeEngine();
    api = await startApi({ engine });
    const caseId = await createCase();
    const baseRun = await runCase(caseId);
    const baseline = await createBaseline(caseId, baseRun.id, '基线');
    const second = await runCase(caseId);
    expect(second.status).toBe('passed');

    const compared = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', '/api/v1/comparisons', {
      baselineId: baseline.id,
      runId: second.id,
    });
    expect(compared.status).toBe(201);
    const item = compared.body.data.items[0];
    expect(item.change).toBe('still_passed');
    expect(item.attribution ?? null).toBeNull();
  });
});

describe('幂等哈希覆盖完整请求体', () => {
  it('同 key 不同 reason → 409；字段顺序不同但同体 → 200 重放同一运行；options 归一化后等价', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const caseId = await createCase();
    const key = 'repair2-idem-key';

    const first = await call<{ data: { id: string } }>(
      api.baseUrl,
      'POST',
      '/api/v1/runs',
      { target: { kind: 'case', caseId }, reason: '回归-改版后验证', options: { retries: 1 } },
      { headers: { 'idempotency-key': key } },
    );
    expect(first.status).toBe(202);
    const runId = first.body.data.id;

    // 字段顺序不同：仍应命中同一哈希 → 200 + Idempotent-Replay + 同一 runId
    const reordered = await call<{ data: { id: string } }>(
      api.baseUrl,
      'POST',
      '/api/v1/runs',
      { options: { retries: 1 }, reason: '回归-改版后验证', target: { kind: 'case', caseId } },
      { headers: { 'idempotency-key': key } },
    );
    expect(reordered.status).toBe(200);
    expect(reordered.headers.get('idempotent-replay')).toBe('true');
    expect(reordered.body.data.id).toBe(runId);

    // reason 属于请求体：同 key 不同 reason → 409
    const differentReason = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      '/api/v1/runs',
      { target: { kind: 'case', caseId }, reason: '另一个原因' },
      { headers: { 'idempotency-key': key } },
    );
    expect(differentReason.status).toBe(409);
    expect(differentReason.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    // options 缺省与显式默认值按 schema 归一化后等价 → 重放
    const anotherKey = 'repair2-idem-defaults';
    const plain = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/runs', { target: { kind: 'case', caseId } }, {
      headers: { 'idempotency-key': anotherKey },
    });
    const explicitDefaults = await call<{ data: { id: string } }>(
      api.baseUrl,
      'POST',
      '/api/v1/runs',
      {
        target: { kind: 'case', caseId },
        options: {
          retries: 0,
          workers: 1,
          timeoutMs: 60000,
          trace: 'retain-on-failure',
          screenshot: 'only-on-failure',
          video: 'off',
          headed: false,
          browser: 'chromium',
          failOnFlaky: false,
        },
      },
      { headers: { 'idempotency-key': anotherKey } },
    );
    expect(explicitDefaults.status).toBe(200);
    expect(explicitDefaults.body.data.id).toBe(plain.body.data.id);
  });
});

describe('数据集结构硬上限 / 业务错误码 / PATCH 语义', () => {
  it('2001 行 POST/PUT → 422 ROW_LIMIT_EXCEEDED（不再被 zod 降级为 VALIDATION_FAILED）', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const caseId = await createCase();
    const rows = Array.from({ length: 2001 }, (_, index) => ({ data: { a: String(index) } }));

    const created = await call<{ error: { code: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '2001 行',
      rows,
    });
    expect(created.status).toBe(422);
    expect(created.body.error.code).toBe('ROW_LIMIT_EXCEEDED');

    const dataset = await call<{ data: { id: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '正常数据集',
      rows: [{ data: { a: '1' } }],
    });
    expect(dataset.status).toBe(201);
    const replaced = await call<{ error: { code: string } }>(
      api.baseUrl,
      'PUT',
      `/api/v1/datasets/${dataset.body.data.id}/rows`,
      { rows },
    );
    expect(replaced.status).toBe(422);
    expect(replaced.body.error.code).toBe('ROW_LIMIT_EXCEEDED');
  });

  it('61 字符列名 → 422 INVALID_DATASET（业务校验给合同错误码）', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const caseId = await createCase();
    const longName = 'c'.repeat(61);
    const response = await call<{ error: { code: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '长列名',
      rows: [{ data: { [longName]: 'x' } }],
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INVALID_DATASET');
  });

  it('PATCH 数据集：空对象 422（refine 至少一字段），仅 name 可 200', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const caseId = await createCase();
    const dataset = await call<{ data: { id: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '原名',
      rows: [{ data: { a: '1' } }],
    });
    const empty = await call<{ error: { code: string; message: string } }>(
      api.baseUrl,
      'PATCH',
      `/api/v1/datasets/${dataset.body.data.id}`,
      {},
    );
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe('VALIDATION_FAILED');
    expect(empty.body.error.message).toContain('至少提供');

    const renamed = await call<{ data: { name: string } }>(
      api.baseUrl,
      'PATCH',
      `/api/v1/datasets/${dataset.body.data.id}`,
      { name: '新名' },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('新名');
  });
});

describe('归档基线不可设默认', () => {
  it('归档后 setDefault → 422 VALIDATION_FAILED；未归档基线仍可设默认', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const caseId = await createCase();
    const run1 = await runCase(caseId);
    const run2 = await runCase(caseId);
    const base1 = await createBaseline(caseId, run1.id, '基线1');
    const base2 = await createBaseline(caseId, run2.id, '基线2');

    const archived = await call<{ data: { archivedAt: string | null; isDefault: boolean } }>(
      api.baseUrl,
      'POST',
      `/api/v1/baselines/${base1.id}/archive`,
      { confirm: true },
    );
    expect(archived.status).toBe(200);
    expect(archived.body.data.archivedAt).not.toBeNull();
    expect(archived.body.data.isDefault).toBe(false);

    const rejected = await call<{ error: { code: string; message: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/baselines/${base1.id}/default`,
    );
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
    expect(rejected.body.error.message).toContain('已归档');

    const ok = await call<{ data: { isDefault: boolean } }>(api.baseUrl, 'POST', `/api/v1/baselines/${base2.id}/default`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.isDefault).toBe(true);
  });
});

describe('attempt.error.snippet 透传', () => {
  it('官方 error.snippet 原样出现在 attempts[0].error.snippet', async () => {
    const engine = createFakeEngine();
    engine.state.failSnippet = '> 12 |   await expect(page.getByText("欢迎")).toBeVisible();';
    api = await startApi({ engine });
    const caseId = await createCase();
    engine.state.outcome = 'unexpected';
    const run = await runCase(caseId);
    expect(run.status).toBe('failed');

    const items = await call<{ data: { items: Record<string, any>[] } }>(api.baseUrl, 'GET', `/api/v1/runs/${run.id}/items`);
    const attempt = items.body.data.items[0]!.attempts[0]!;
    expect(attempt.error.message.length).toBeGreaterThan(0);
    expect(attempt.error.snippet).toBe('> 12 |   await expect(page.getByText("欢迎")).toBeVisible();');
  });
});

describe('running 期间 stats 单调递增（逐成员 saveRunProgress）', () => {
  it('套件逐成员完成后 stats.expected 从 0→1→2 单调增加，终态仍由 finishRun 收口', async () => {
    const engine = createFakeEngine({ gate: true });
    api = await startApi({ engine, config: { maxConcurrentRuns: 1 } });
    const caseA = await createCase('A 用例');
    const caseB = await createCase('B 用例');
    const suiteId = await createSuite([caseA, caseB]);

    const created = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'suite', suiteId },
    });
    expect(created.status).toBe(202);
    const runId = created.body.data.id;

    await waitFor(
      () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${runId}`),
      (result) => result.body.data.status === 'running',
    );

    // 放行第一个成员（A）：进度应落库为 expected=1，而运行仍 running、items 尚未入库
    engine.release();
    const observed: number[] = [];
    await waitFor(
      () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${runId}`),
      (result) => {
        observed.push(Number(result.body.data.stats.expected));
        return Number(result.body.data.stats.expected) >= 1;
      },
      8000,
      40,
    );
    const midRun = (await waitFor(
      () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${runId}`),
      (result) => Number(result.body.data.stats.expected) >= 1,
    )).body.data;
    expect(midRun.status).toBe('running');
    expect(midRun.stats.expected).toBe(1);
    expect(midRun.itemsCount).toBe(0);

    // 放行第二个成员（B）：终态收口
    engine.release();
    const finished = await waitRun(runId);
    expect(finished.status).toBe('passed');
    expect(finished.stats.expected).toBe(2);
    expect(finished.itemsCount).toBe(2);

    // 观测到的 expected 值单调不减（0 → 1）
    let previous = 0;
    for (const value of observed) {
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe('排队取消后的位次', () => {
  it('取消排队运行：该运行 queuePosition=null，后续排队者位次前移', async () => {
    const engine = createFakeEngine({ gate: true });
    api = await startApi({ engine, config: { maxConcurrentRuns: 1, queueLimit: 5 } });
    const caseId = await createCase();

    const first = await call<{ data: { id: string; status: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId },
    });
    expect(first.body.data.status).toBe('running');
    const second = await call<{ data: { id: string; status: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId },
    });
    const third = await call<{ data: { id: string; status: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId },
    });
    expect(second.body.data.status).toBe('queued');
    expect(third.body.data.status).toBe('queued');

    const beforeSecond = await call<{ data: { queuePosition: number | null } }>(
      api.baseUrl,
      'GET',
      `/api/v1/runs/${second.body.data.id}`,
    );
    const beforeThird = await call<{ data: { queuePosition: number | null } }>(
      api.baseUrl,
      'GET',
      `/api/v1/runs/${third.body.data.id}`,
    );
    expect(beforeSecond.body.data.queuePosition).toBe(1);
    expect(beforeThird.body.data.queuePosition).toBe(2);

    const cancelled = await call<{ data: { status: string; queuePosition: number | null } }>(
      api.baseUrl,
      'POST',
      `/api/v1/runs/${second.body.data.id}/cancel`,
    );
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(cancelled.body.data.queuePosition).toBeNull();

    const afterThird = await call<{ data: { queuePosition: number | null } }>(
      api.baseUrl,
      'GET',
      `/api/v1/runs/${third.body.data.id}`,
    );
    expect(afterThird.body.data.queuePosition).toBe(1);

    engine.release();
    await waitRun(first.body.data.id);
    await waitFor(
      () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${third.body.data.id}`),
      (result) => result.body.data.status === 'running',
    );
    engine.release();
    const thirdRun = await waitRun(third.body.data.id);
    expect(thirdRun.status).toBe('passed');
  });
});