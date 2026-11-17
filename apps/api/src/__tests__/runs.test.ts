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

interface Seed {
  caseId: string;
  datasetId: string;
}

async function seedDataDrivenCase(): Promise<Seed> {
  const caseResponse = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', '/api/v1/cases', {
    name: '数据驱动登录',
    mode: 'steps',
    steps: [
      { id: 'st_1', action: 'goto', url: 'http://127.0.0.1:4174/login' },
      { id: 'st_2', action: 'fill', target: { by: 'label', text: '用户名' }, value: '{{name}}' },
    ],
  });
  expect(caseResponse.status).toBe(201);
  const caseId = dataOf(caseResponse).id;

  const datasetResponse = await call<{ data: { id: string } }>(api!.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
    name: '登录数据',
    rows: [{ data: { name: '甲' } }, { data: { name: '乙' }, enabled: false }, { data: { name: '丙' } }],
  });
  expect(datasetResponse.status).toBe(201);
  return { caseId, datasetId: dataOf(datasetResponse).id };
}

async function createRun(body: {
  target: { kind: 'case'; caseId: string } | { kind: 'suite'; suiteId: string };
  datasetId?: string;
  options?: Record<string, unknown>;
}): Promise<{ id: string; status: string }> {
  const response = await call<{ data: { id: string; status: string } }>(api!.baseUrl, 'POST', '/api/v1/runs', body);
  expect([202, 200]).toContain(response.status);
  return dataOf(response);
}

async function waitTerminal(runId: string): Promise<Record<string, any>> {
  const response = await waitFor(
    () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${runId}`),
    (result) => ['passed', 'failed', 'cancelled', 'error'].includes(result.body.data.status),
    6000,
  );
  return response.body.data;
}

describe('运行生命周期与逐行结果', () => {
  it('数据驱动运行：一行一个 item，itemKey 稳定，passed 判定与官方统计一致', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const { caseId, datasetId } = await seedDataDrivenCase();

    const created = await createRun({ target: { kind: 'case', caseId }, datasetId });
    expect(created.id).toMatch(/^run_/);
    expect(['queued', 'running']).toContain(created.status);

    const run = await waitTerminal(created.id);
    expect(run.status).toBe('passed');
    expect(run.exitCode).toBe(0);
    expect(run.stats.expected).toBe(2);
    expect(run.stats.unexpected).toBe(0);
    expect(run.itemsCount).toBe(2);
    expect(run.artifactsCount).toBeGreaterThanOrEqual(1);
    expect(run.datasetId).toBe(datasetId);
    expect(run.environment.playwright).toBe('1.65.0');
    expect(run.diagnostics.reportPath).toBeTruthy();
    expect(run.diagnostics.workspaceDir).toContain(created.id);

    const items = await call<{ data: { items: { itemKey: string; rowIndex: number; title: string; outcome: string }[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/runs/${created.id}/items`,
    );
    const itemKeys = items.body.data.items.map((item) => item.itemKey);
    expect(itemKeys).toEqual([`${caseId}#row:0`, `${caseId}#row:2`]);
    expect(items.body.data.items[0]!.title).toContain('[row:0]');
    expect(items.body.data.items[0]!.outcome).toBe('expected');

    // 逐项结果按 itemKey 可取单条（itemKey 需 URL 编码）
    const single = await call<{ data: { itemKey: string; attemptCount?: number; attempts: { errorHash: string }[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/runs/${created.id}/items/${encodeURIComponent(`${caseId}#row:0`)}`,
    );
    expect(single.status).toBe(200);
    expect(single.body.data.itemKey).toBe(`${caseId}#row:0`);
    expect(single.body.data.attempts[0]!.errorHash).toBe('');

    // 引擎收到的快照包含数据集 enabled 行（0 与 2）
    expect(engine.calls[0]!.caseSnapshot).toMatchObject({ caseId });
    const snapshot = engine.calls[0]!.caseSnapshot as unknown as { rows: { rowIndex: number }[] };
    expect(snapshot.rows.map((row) => row.rowIndex)).toEqual([0, 2]);
  });

  it('产物索引与内容读取：json-report 可下载，Range 返回 206', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const { caseId } = await seedDataDrivenCase();
    const created = await createRun({ target: { kind: 'case', caseId } });
    await waitTerminal(created.id);

    const artifacts = await call<{ data: { items: { id: string; kind: string; sizeBytes: number; sha256: string }[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/runs/${created.id}/artifacts?kind=json-report`,
    );
    expect(artifacts.status).toBe(200);
    const artifact = artifacts.body.data.items[0]!;
    expect(artifact.kind).toBe('json-report');
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.sizeBytes).toBeGreaterThan(0);

    const content = await call<{ stats: { expected: number } }>(api.baseUrl, 'GET', `/api/v1/runs/${created.id}/artifacts/${artifact.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toContain('application/json');
    expect((content.body as { stats: { expected: number } }).stats.expected).toBe(1);

    const ranged = await call(api.baseUrl, 'GET', `/api/v1/runs/${created.id}/artifacts/${artifact.id}/content`, undefined, {
      headers: { range: 'bytes=0-9' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-9\//);
    expect(ranged.headers.get('content-length')).toBe('10');

    const invalidRange = await call(api.baseUrl, 'GET', `/api/v1/runs/${created.id}/artifacts/${artifact.id}/content`, undefined, {
      headers: { range: 'bytes=999999-' },
    });
    expect(invalidRange.status).toBe(416);

    const missing = await call(api.baseUrl, 'GET', `/api/v1/runs/${created.id}/artifacts/art_missing/content`);
    expect(missing.status).toBe(404);
  });

  it('SSE 端点可用：返回 event-stream 并先推送当前 Run 快照', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const { caseId } = await seedDataDrivenCase();
    const created = await createRun({ target: { kind: 'case', caseId } });
    await waitTerminal(created.id);

    const controller = new AbortController();
    const response = await fetch(`${api.baseUrl}/api/v1/runs/${created.id}/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes('event: run.updated')) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 8192) break;
    }
    controller.abort();
    expect(buffer).toContain('event: run.updated');
    expect(buffer).toContain('"status":"passed"');
  });

  it('失败运行：status=failed 且逐项错误带 errorHash（用于回归比对）', async () => {
    const engine = createFakeEngine({ state: { outcome: 'unexpected' } });
    api = await startApi({ engine });
    const { caseId } = await seedDataDrivenCase();
    const created = await createRun({ target: { kind: 'case', caseId } });
    const run = await waitTerminal(created.id);
    expect(run.status).toBe('failed');
    expect(run.stats.unexpected).toBe(1);

    const items = await call<{ data: { items: { attempts: { error: { message: string }; errorHash: string }[] }[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/runs/${created.id}/items`,
    );
    const attempt = items.body.data.items[0]!.attempts[0]!;
    expect(attempt.error.message).toContain('fake');
    expect(attempt.errorHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('flaky 语义：默认 failOnFlaky=false 视为 passed；开启后 failed', async () => {
    const engine = createFakeEngine({ state: { outcome: 'flaky' } });
    api = await startApi({ engine });
    const { caseId } = await seedDataDrivenCase();

    const relaxed = await createRun({ target: { kind: 'case', caseId } });
    const relaxedRun = await waitTerminal(relaxed.id);
    expect(relaxedRun.status).toBe('passed');
    expect(relaxedRun.stats.flaky).toBe(1);

    const strict = await createRun({ target: { kind: 'case', caseId }, options: { failOnFlaky: true } });
    const strictRun = await waitTerminal(strict.id);
    expect(strictRun.status).toBe('failed');
  });

  it('套件运行：按成员逐个执行并合并结果', async () => {
    const engine = createFakeEngine();
    api = await startApi({ engine });
    const { caseId } = await seedDataDrivenCase();
    const second = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/cases', {
      name: '第二个用例',
      steps: [{ id: 'st_1', action: 'goto', url: 'http://127.0.0.1:4174/' }],
    });
    const suite = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/suites', {
      name: '套件',
      caseIds: [caseId, second.body.data.id],
    });

    const created = await createRun({ target: { kind: 'suite', suiteId: suite.body.data.id } });
    const run = await waitTerminal(created.id);
    expect(run.status).toBe('passed');
    expect(run.kind).toBe('suite');
    expect(run.caseId).toBeNull();
    expect(run.suiteId).toBe(suite.body.data.id);
    // 第一个用例使用默认数据集（enabled 0、2），第二个用例无数据集（单次执行）
    expect(run.itemsCount).toBe(3);
    expect(engine.calls).toHaveLength(2);
  });

  it('运行列表过滤与游标分页；逐项结果按 outcome/rowIndex 过滤', async () => {
    const engine = createFakeEngine({ state: { outcome: 'unexpected' } });
    api = await startApi({ engine });
    const { caseId, datasetId } = await seedDataDrivenCase();
    const first = await createRun({ target: { kind: 'case', caseId }, datasetId });
    await waitTerminal(first.id);
    const second = await createRun({ target: { kind: 'case', caseId }, datasetId });
    await waitTerminal(second.id);

    const failedList = await call<{ data: { items: { id: string }[] } }>(api.baseUrl, 'GET', '/api/v1/runs?status=failed');
    expect(failedList.body.data.items.length).toBe(2);

    const byCase = await call<{ data: { items: { caseId: string }[] } }>(api.baseUrl, 'GET', `/api/v1/runs?caseId=${caseId}`);
    expect(byCase.body.data.items).toHaveLength(2);

    const ascPage = await call<{ data: { items: { id: string }[]; hasMore: boolean; nextCursor: string | null } }>(
      api.baseUrl,
      'GET',
      '/api/v1/runs?limit=1&order=asc',
    );
    expect(ascPage.body.data.items).toHaveLength(1);
    expect(ascPage.body.data.hasMore).toBe(true);

    const items = await call<{ data: { items: { outcome: string; rowIndex: number }[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/runs/${first.id}/items?status=unexpected&rowIndex=0`,
    );
    expect(items.body.data.items).toHaveLength(1);
    expect(items.body.data.items[0]!.rowIndex).toBe(0);
  });
});

describe('运行校验与错误语义', () => {
  it('用例不存在 404；数据集全 disabled → 422 EMPTY_DATASET；数据集不属于用例 → 422', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const { caseId } = await seedDataDrivenCase();
    const other = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/cases', { name: '另一个' });
    const otherDataset = await call<{ data: { id: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${other.body.data.id}/datasets`, {
      name: '别人的',
      rows: [{ data: { a: '1' } }],
    });

    const missing = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId: 'case_missing' },
    });
    expect(missing.status).toBe(404);

    const mismatch = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId },
      datasetId: otherDataset.body.data.id,
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('VALIDATION_FAILED');

    const emptyDataset = await call<{ data: { id: string } }>(api.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '全禁用',
      rows: [{ data: { name: 'x' }, enabled: false }],
    });
    const emptyRun = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId },
      datasetId: emptyDataset.body.data.id,
    });
    expect(emptyRun.status).toBe(422);
    expect(emptyRun.body.error.code).toBe('EMPTY_DATASET');
  });

  it('套件运行不接受 datasetId；options 越界 → 422', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const { caseId, datasetId } = await seedDataDrivenCase();
    const suite = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/suites', {
      name: '套件',
      caseIds: [caseId],
    });

    const withDataset = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'suite', suiteId: suite.body.data.id },
      datasetId,
    });
    expect(withDataset.status).toBe(422);

    const badOptions = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId },
      options: { workers: 9 },
    });
    expect(badOptions.status).toBe(422);
    expect(badOptions.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('引擎不可用 → 运行落 error 且标注 ENGINE_ERROR（不伪造结果）', async () => {
    api = await startApi({ engine: null });
    const { caseId } = await seedDataDrivenCase();
    const created = await createRun({ target: { kind: 'case', caseId } });
    const run = await waitTerminal(created.id);
    expect(run.status).toBe('error');
    expect(run.error.code).toBe('ENGINE_ERROR');
    expect(run.itemsCount).toBe(0);
  });

  it('引擎抛错 → error + ENGINE_ERROR 且保留原因', async () => {
    api = await startApi({ engine: createFakeEngine({ rejectWith: 'chromium 启动失败（fake）' }) });
    const { caseId } = await seedDataDrivenCase();
    const created = await createRun({ target: { kind: 'case', caseId } });
    const run = await waitTerminal(created.id);
    expect(run.status).toBe('error');
    expect(run.error.code).toBe('ENGINE_ERROR');
    expect(run.error.message).toContain('fake');
  });
});

describe('取消、超时与并发', () => {
  it('取消运行中的运行：202 → cancelled，并回调引擎 cancel', async () => {
    const engine: FakeEngine = createFakeEngine({ gate: true });
    api = await startApi({ engine });
    const { caseId } = await seedDataDrivenCase();
    const created = await createRun({ target: { kind: 'case', caseId } });

    await waitFor(
      () => call<{ data: { status: string } }>(api!.baseUrl, 'GET', `/api/v1/runs/${created.id}`),
      (result) => result.body.data.status === 'running',
    );

    const cancelled = await call<{ data: { status: string; cancelRequestedAt: string | null } }>(
      api.baseUrl,
      'POST',
      `/api/v1/runs/${created.id}/cancel`,
    );
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.data.cancelRequestedAt).toBeTruthy();

    const run = await waitTerminal(created.id);
    expect(run.status).toBe('cancelled');
    expect(engine.cancelCalls).toContain(created.id);

    // 重复取消幂等：返回 200 当前状态
    const again = await call<{ data: { status: string } }>(api.baseUrl, 'POST', `/api/v1/runs/${created.id}/cancel`);
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('cancelled');
  });

  it('取消排队中的运行：直接 cancelled 且 queuePosition 归零', async () => {
    const engine = createFakeEngine({ gate: true });
    api = await startApi({ engine, config: { maxConcurrentRuns: 1, queueLimit: 5 } });
    const { caseId } = await seedDataDrivenCase();

    const first = await createRun({ target: { kind: 'case', caseId } });
    await waitFor(
      () => call<{ data: { status: string } }>(api!.baseUrl, 'GET', `/api/v1/runs/${first.id}`),
      (result) => result.body.data.status === 'running',
    );
    const second = await createRun({ target: { kind: 'case', caseId } });
    expect(second.status).toBe('queued');
    const queued = await call<{ data: { queuePosition: number | null } }>(api.baseUrl, 'GET', `/api/v1/runs/${second.id}`);
    expect(queued.body.data.queuePosition).toBe(1);

    const cancelled = await call<{ data: { status: string } }>(api.baseUrl, 'POST', `/api/v1/runs/${second.id}/cancel`);
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.data.status).toBe('cancelled');

    engine.release();
    const firstRun = await waitTerminal(first.id);
    expect(firstRun.status).toBe('passed');
  });

  it('并发上限：maxConcurrentRuns=1 时第二个运行排队，完成后自动开始', async () => {
    const engine = createFakeEngine({ gate: true });
    api = await startApi({ engine, config: { maxConcurrentRuns: 1, queueLimit: 5 } });
    const { caseId } = await seedDataDrivenCase();

    const first = await createRun({ target: { kind: 'case', caseId } });
    const second = await createRun({ target: { kind: 'case', caseId } });
    expect(second.status).toBe('queued');

    engine.release();
    const firstRun = await waitTerminal(first.id);
    expect(firstRun.status).toBe('passed');

    await waitFor(
      () => call<{ data: { status: string } }>(api!.baseUrl, 'GET', `/api/v1/runs/${second.id}`),
      (result) => result.body.data.status === 'running',
    );
    engine.release();
    const secondRun = await waitTerminal(second.id);
    expect(secondRun.status).toBe('passed');
    expect(secondRun.startedAt).toBeTruthy();
  });

  it('排队超限 → 429 TOO_MANY_RUNS', async () => {
    const engine = createFakeEngine({ gate: true });
    api = await startApi({ engine, config: { maxConcurrentRuns: 1, queueLimit: 1 } });
    const { caseId } = await seedDataDrivenCase();

    await createRun({ target: { kind: 'case', caseId } });
    await createRun({ target: { kind: 'case', caseId } });
    const tooMany = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId },
    });
    expect(tooMany.status).toBe(429);
    expect(tooMany.body.error.code).toBe('TOO_MANY_RUNS');
    engine.release();
  });

  it('运行级超时 → error + RUN_TIMEOUT', async () => {
    const engine = createFakeEngine({ hang: true });
    api = await startApi({ engine, config: { runTimeoutMs: 300 } });
    const { caseId } = await seedDataDrivenCase();
    const created = await createRun({ target: { kind: 'case', caseId } });
    const run = await waitTerminal(created.id);
    expect(run.status).toBe('error');
    expect(run.error.code).toBe('RUN_TIMEOUT');
    expect(run.finishedAt).toBeTruthy();
  });
});

describe('运行创建幂等', () => {
  it('同 key 同请求体返回同一运行（200 + Idempotent-Replay），不同请求体 409', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const { caseId } = await seedDataDrivenCase();
    const key = 'idem-key-12345';
    const body = { target: { kind: 'case', caseId } };

    const first = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/runs', body, {
      headers: { 'idempotency-key': key },
    });
    expect(first.status).toBe(202);
    expect(first.headers.get('idempotency-key')).toBe(key);

    const replay = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/runs', body, {
      headers: { 'idempotency-key': key },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(replay.body.data.id).toBe(first.body.data.id);

    const conflict = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      '/api/v1/runs',
      { target: { kind: 'case', caseId }, options: { retries: 1 } },
      { headers: { 'idempotency-key': key } },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('非法 Idempotency-Key 格式 → 422（不静默忽略）', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const { caseId } = await seedDataDrivenCase();
    const response = await call(api.baseUrl, 'POST', '/api/v1/runs', { target: { kind: 'case', caseId } }, {
      headers: { 'idempotency-key': 'short' },
    });
    expect(response.status).toBe(422);
  });
});