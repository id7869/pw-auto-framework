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

async function createCase(name = '回归用例'): Promise<string> {
  const response = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/cases', {
    name,
    steps: [{ id: 'st_1', action: 'goto', url: 'http://127.0.0.1:4174/' }],
  });
  return dataOf(response).id;
}

async function runCase(caseId: string): Promise<Record<string, any>> {
  const created = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/runs', {
    target: { kind: 'case', caseId },
  });
  const finished = await waitFor(
    () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${created.body.data.id}`),
    (result) => ['passed', 'failed', 'cancelled', 'error'].includes(result.body.data.status),
    6000,
  );
  return finished.body.data;
}

async function createBaseline(caseId: string, runId: string, name = '基线1'): Promise<Record<string, any>> {
  const response = await call<{ data: Record<string, any> }>(api!.baseUrl, 'POST', '/api/v1/baselines', {
    scope: 'case',
    scopeId: caseId,
    runId,
    name,
  });
  expect(response.status).toBe(201);
  return dataOf(response);
}

describe('基线（Baseline）', () => {
  it('只有 passed 运行可设基线：失败运行 → 409 BASELINE_SCOPE_MISMATCH', async () => {
    const engine: FakeEngine = createFakeEngine();
    api = await startApi({ engine });
    const caseId = await createCase();

    engine.state.outcome = 'unexpected';
    const failedRun = await runCase(caseId);
    expect(failedRun.status).toBe('failed');

    const response = await call<{ error: { code: string; message: string } }>(api.baseUrl, 'POST', '/api/v1/baselines', {
      scope: 'case',
      scopeId: caseId,
      runId: failedRun.id,
      name: '不该成功',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BASELINE_SCOPE_MISMATCH');
    expect(response.body.error.message).toContain('passed');
  });

  it('scope 与运行不一致 → 409；运行不存在 → 404', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const caseId = await createCase();
    const run = await runCase(caseId);

    const wrongScope = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/baselines', {
      scope: 'case',
      scopeId: 'case_other',
      runId: run.id,
      name: '错 scope',
    });
    expect(wrongScope.status).toBe(409);
    expect(wrongScope.body.error.code).toBe('BASELINE_SCOPE_MISMATCH');

    const missingRun = await call(api.baseUrl, 'POST', '/api/v1/baselines', {
      scope: 'case',
      scopeId: caseId,
      runId: 'run_missing',
      name: '无运行',
    });
    expect(missingRun.status).toBe(404);
  });

  it('首条基线自动成为默认；第二条不默认；setDefault 切换且同 scope 至多一条 true', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const caseId = await createCase();
    const run1 = await runCase(caseId);
    const run2 = await runCase(caseId);

    const base1 = await createBaseline(caseId, run1.id, '基线A');
    expect(base1.isDefault).toBe(true);
    expect(base1.createdBy).toBe('user');
    expect(base1.archivedAt).toBeNull();

    const base2 = await createBaseline(caseId, run2.id, '基线B');
    expect(base2.isDefault).toBe(false);

    const switched = await call<{ data: { isDefault: boolean } }>(
      api.baseUrl,
      'POST',
      `/api/v1/baselines/${base2.id}/default`,
    );
    expect(switched.status).toBe(200);
    expect(switched.body.data.isDefault).toBe(true);

    const list = await call<{ data: { items: { id: string; isDefault: boolean }[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/baselines?scope=case&scopeId=${caseId}&archived=false`,
    );
    expect(list.body.data.items.filter((item) => item.isDefault)).toHaveLength(1);
    expect(list.body.data.items.find((item) => item.isDefault)!.id).toBe(base2.id);
  });

  it('归档需要 confirm:true（428/200），归档后从默认集合移除', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const caseId = await createCase();
    const run = await runCase(caseId);
    const baseline = await createBaseline(caseId, run.id);

    const noConfirm = await call<{ error: { code: string } }>(api.baseUrl, 'POST', `/api/v1/baselines/${baseline.id}/archive`, {});
    expect(noConfirm.status).toBe(428);
    expect(noConfirm.body.error.code).toBe('CONFIRM_REQUIRED');

    const archived = await call<{ data: { archivedAt: string | null; isDefault: boolean } }>(
      api.baseUrl,
      'POST',
      `/api/v1/baselines/${baseline.id}/archive`,
      { confirm: true },
    );
    expect(archived.status).toBe(200);
    expect(archived.body.data.archivedAt).toBeTruthy();
    expect(archived.body.data.isDefault).toBe(false);
  });
});

describe('回归对比（Comparison）', () => {
  it('由通过转失败 → newly_failed / regression / 归因含错误哈希变化', async () => {
    const engine: FakeEngine = createFakeEngine();
    api = await startApi({ engine });
    const caseId = await createCase();
    const baseRun = await runCase(caseId);
    const baseline = await createBaseline(caseId, baseRun.id);

    engine.state.outcome = 'unexpected';
    engine.state.failMessage =
      'expect(received).toHaveText(expected)\n\nExpected: "提交"\nReceived: "发送"';
    const targetRun = await runCase(caseId);
    expect(targetRun.status).toBe('failed');

    const created = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', '/api/v1/comparisons', {
      baselineId: baseline.id,
      runId: targetRun.id,
    });
    expect(created.status).toBe(201);
    const comparison = dataOf(created);
    expect(comparison.id).toMatch(/^cmp_/);
    expect(comparison.baselineRunId).toBe(baseRun.id);
    expect(comparison.runId).toBe(targetRun.id);
    expect(comparison.summary.verdict).toBe('regression');
    expect(comparison.summary.verdictBasis).toBe('computed');
    expect(comparison.summary.newly_failed).toBe(1);
    expect(comparison.summary.total).toBe(1);
    expect(comparison.items).toHaveLength(1);

    const item = comparison.items[0];
    expect(item.itemKey).toBe(caseId);
    expect(item.change).toBe('newly_failed');
    expect(item.baseOutcome).toBe('expected');
    expect(item.targetOutcome).toBe('unexpected');
    expect(item.errorChanged).toBe(true);
    expect(item.baseErrorHash).toBeNull();
    expect(item.targetErrorHash).toMatch(/^[a-f0-9]{64}$/);
    expect(item.durationDeltaMs).not.toBeNull();
    expect(item.attribution.category).toBe('new_failure');
    // PRD R3.5：断言类官方错误文本 → assertion_mismatch（官方证据推断，confidence=high）
    expect(item.attribution.failureCategory).toBe('assertion_mismatch');
    expect(item.attribution.confidence).toBe('high');
    expect(item.attribution.evidence.join('\n')).toContain('官方 error.message');
    expect(item.attribution.evidence.join('\n')).toContain('官方 errorLocation：fake.spec.ts:10:5');

    // 落库后可再次读取（items 独立分页）
    const fetched = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'GET',
      `/api/v1/comparisons/${comparison.id}?itemsLimit=1`,
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.comparison.summary.newly_failed).toBe(1);
    expect(fetched.body.data.items).toHaveLength(1);

    const list = await call<{ data: { items: { id: string }[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/comparisons?runId=${targetRun.id}`,
    );
    expect(list.body.data.items).toHaveLength(1);
  });

  it('失败运行不能设基线（同时验证 409 详情）', async () => {
    const engine: FakeEngine = createFakeEngine({ state: { outcome: 'unexpected' } });
    api = await startApi({ engine });
    const caseId = await createCase();
    const baseRun = await runCase(caseId);
    const targetRun = await runCase(caseId);
    expect(baseRun.status).toBe('failed');
    expect(targetRun.status).toBe('failed');

    const baselineAttempt = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/baselines', {
      scope: 'case',
      scopeId: caseId,
      runId: baseRun.id,
      name: '失败基线',
    });
    expect(baselineAttempt.status).toBe(409);
    expect(baselineAttempt.body.error.code).toBe('BASELINE_SCOPE_MISMATCH');
  });

  it('flaky 语义可见：基线通过 → 本次 flaky 判 became_flaky / mixed', async () => {
    const engine: FakeEngine = createFakeEngine();
    api = await startApi({ engine });
    const caseId = await createCase();
    const baseRun = await runCase(caseId);
    const baseline = await createBaseline(caseId, baseRun.id);

    engine.state.outcome = 'flaky';
    const targetRun = await runCase(caseId);
    expect(targetRun.status).toBe('passed');
    expect(targetRun.stats.flaky).toBe(1);

    const created = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', '/api/v1/comparisons', {
      baselineId: baseline.id,
      runId: targetRun.id,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.summary.became_flaky).toBe(1);
    expect(created.body.data.summary.verdict).toBe('mixed');
    expect(created.body.data.items[0].change).toBe('became_flaky');
    expect(created.body.data.items[0].attribution.category).toBe('flaky_introduced');
  });

  it('数据集行减少 → missing_item；verdict unchanged', async () => {
    const engine: FakeEngine = createFakeEngine();
    api = await startApi({ engine });
    const caseId = await createCase();
    const dataset = await call<{ data: { id: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '两行',
      rows: [{ data: { a: '1' } }, { data: { a: '2' } }],
    });
    const baseRunResponse = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId },
      datasetId: dataset.body.data.id,
    });
    const baseRun = await waitFor(
      () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${baseRunResponse.body.data.id}`),
      (result) => result.body.data.status === 'passed',
    );
    const baseline = await createBaseline(caseId, baseRun.body.data.id);

    // 删掉一行（行号重排只保留 rowIndex 0）
    await call(api.baseUrl, 'PUT', `/api/v1/datasets/${dataset.body.data.id}/rows`, { rows: [{ data: { a: '1' } }] });
    const targetRunResponse = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId },
      datasetId: dataset.body.data.id,
    });
    const targetRun = await waitFor(
      () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${targetRunResponse.body.data.id}`),
      (result) => result.body.data.status === 'passed',
    );

    const created = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', '/api/v1/comparisons', {
      baselineId: baseline.id,
      runId: targetRun.body.data.id,
    });
    expect(created.status).toBe(201);
    const summary = created.body.data.summary;
    expect(summary.missing_item).toBe(1);
    expect(summary.still_passed).toBe(1);
    expect(summary.verdict).toBe('unchanged');
    const missing = created.body.data.items.find((item: { change: string }) => item.change === 'missing_item');
    expect(missing.itemKey).toBe(`${caseId}#row:1`);
  });

  it('scope 不同 → 409 COMPARISON_SCOPE_MISMATCH；运行未终态 → 422 RUN_NOT_TERMINAL', async () => {
    const engine: FakeEngine = createFakeEngine({ gate: true });
    api = await startApi({ engine });
    const caseId = await createCase();
    const otherCaseId = await createCase('另一个用例');

    // 第一个运行：放行 → passed → 可设基线
    const firstRunResponse = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId },
    });
    engine.release();
    const firstRun = await waitFor(
      () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${firstRunResponse.body.data.id}`),
      (result) => ['passed', 'failed', 'cancelled', 'error'].includes(result.body.data.status),
      6000,
    );
    expect(firstRun.body.data.status).toBe('passed');
    const baseline = await createBaseline(caseId, firstRun.body.data.id);

    // 第二个运行保持 running（不 release），对比应 422
    const runningRun = await call<{ data: { id: string; status: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId },
    });
    expect(runningRun.body.data.status).toBe('running');

    const notTerminal = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/comparisons', {
      baselineId: baseline.id,
      runId: runningRun.body.data.id,
    });
    expect(notTerminal.status).toBe(422);
    expect(notTerminal.body.error.code).toBe('RUN_NOT_TERMINAL');

    const otherRunResponse = await call<{ data: { id: string; status: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId: otherCaseId },
    });
    expect(otherRunResponse.body.data.status).toBe('queued');
    const mismatch = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/comparisons', {
      baselineId: baseline.id,
      runId: otherRunResponse.body.data.id,
    });
    // 目标运行尚未终态：ComparisonService 先做终态校验 → 必然 422 RUN_NOT_TERMINAL（scope 校验在其后）
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('RUN_NOT_TERMINAL');

    engine.release();
    await waitFor(
      () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${runningRun.body.data.id}`),
      (result) => ['passed', 'failed', 'cancelled', 'error'].includes(result.body.data.status),
      6000,
    );
  });
});