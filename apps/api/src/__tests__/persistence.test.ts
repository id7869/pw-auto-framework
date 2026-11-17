import { afterEach, describe, expect, it } from 'vitest';
import { call, cleanupDir, makeTempDir, startApiIn, waitFor, type TestApi } from './helpers.ts';
import { createFakeEngine } from './fake-engine.ts';

const dirs: string[] = [];
const apis: TestApi[] = [];

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close();
  for (const dir of dirs.splice(0)) cleanupDir(dir);
});

async function open(dataDir: string, options: Parameters<typeof startApiIn>[1]): Promise<TestApi> {
  const api = await startApiIn(dataDir, options);
  apis.push(api);
  return api;
}

async function waitTerminal(api: TestApi, runId: string): Promise<Record<string, any>> {
  const response = await waitFor(
    () => call<{ data: Record<string, any> }>(api.baseUrl, 'GET', `/api/v1/runs/${runId}`),
    (result) => ['passed', 'failed', 'cancelled', 'error'].includes(result.body.data.status),
    6000,
  );
  return response.body.data;
}

describe('持久化与重启恢复', () => {
  it('重启后用例/数据集/套件/运行/基线仍可读，运行工作区仍在', async () => {
    const dataDir = makeTempDir();
    dirs.push(dataDir);
    const engine = createFakeEngine();
    const first = await open(dataDir, { engine });

    const createdCase = await call<{ data: { id: string } }>(first.baseUrl, 'POST', '/api/v1/cases', {
      name: '持久化用例',
      steps: [{ id: 'st_1', action: 'goto', url: 'http://127.0.0.1:4174/' }],
    });
    const caseId = createdCase.body.data.id;
    const dataset = await call<{ data: { id: string } }>(first.baseUrl, 'POST', `/api/v1/cases/${caseId}/datasets`, {
      name: '持久化数据集',
      rows: [{ data: { a: '1' } }, { data: { a: '2' } }],
    });
    const suite = await call<{ data: { id: string } }>(first.baseUrl, 'POST', '/api/v1/suites', {
      name: '持久化套件',
      caseIds: [caseId],
    });
    const runResponse = await call<{ data: { id: string } }>(first.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId },
      datasetId: dataset.body.data.id,
    });
    const run = await waitTerminal(first, runResponse.body.data.id);
    expect(run.status).toBe('passed');
    const baseline = await call<{ data: { id: string } }>(first.baseUrl, 'POST', '/api/v1/baselines', {
      scope: 'case',
      scopeId: caseId,
      runId: run.id,
      name: '持久化基线',
    });
    expect(baseline.status).toBe(201);

    await first.close();
    apis.pop();

    const second = await open(dataDir, { engine: createFakeEngine() });
    const reopenedCase = await call<{ data: { name: string; steps: unknown[] } }>(second.baseUrl, 'GET', `/api/v1/cases/${caseId}`);
    expect(reopenedCase.status).toBe(200);
    expect(reopenedCase.body.data.name).toBe('持久化用例');
    expect(reopenedCase.body.data.steps).toHaveLength(1);

    const reopenedDataset = await call<{ data: { rowsCount: number } }>(
      second.baseUrl,
      'GET',
      `/api/v1/datasets/${dataset.body.data.id}`,
    );
    expect(reopenedDataset.body.data.rowsCount).toBe(2);

    const reopenedSuite = await call<{ data: { caseIds: string[] } }>(
      second.baseUrl,
      'GET',
      `/api/v1/suites/${suite.body.data.id}`,
    );
    expect(reopenedSuite.body.data.caseIds).toEqual([caseId]);

    const reopenedRun = await call<{ data: { status: string; stats: { expected: number }; itemsCount: number } }>(
      second.baseUrl,
      'GET',
      `/api/v1/runs/${run.id}`,
    );
    expect(reopenedRun.body.data.status).toBe('passed');
    expect(reopenedRun.body.data.stats.expected).toBe(2);
    expect(reopenedRun.body.data.itemsCount).toBe(2);

    const items = await call<{ data: { items: unknown[] } }>(second.baseUrl, 'GET', `/api/v1/runs/${run.id}/items`);
    expect(items.body.data.items).toHaveLength(2);

    const baselines = await call<{ data: { items: { id: string; isDefault: boolean }[] } }>(
      second.baseUrl,
      'GET',
      `/api/v1/baselines?scope=case&scopeId=${caseId}`,
    );
    expect(baselines.body.data.items).toHaveLength(1);
    expect(baselines.body.data.items[0]!.isDefault).toBe(true);

    // 运行工作区仍在磁盘（诊断信息指向它）
    const diagnostics = await call<{ data: { diagnostics: { workspaceDir: string; reportPath: string | null } } }>(
      second.baseUrl,
      'GET',
      `/api/v1/runs/${run.id}`,
    );
    expect(diagnostics.body.data.diagnostics.reportPath).toBeTruthy();
  });

  it('重启把未完成运行置为 error(RUN_INTERRUPTED)，不伪造结果', async () => {
    const dataDir = makeTempDir();
    dirs.push(dataDir);
    const gated = createFakeEngine({ gate: true });
    const first = await open(dataDir, { engine: gated });

    const createdCase = await call<{ data: { id: string } }>(first.baseUrl, 'POST', '/api/v1/cases', {
      name: '中断用例',
      steps: [{ id: 'st_1', action: 'goto', url: 'http://127.0.0.1:4174/' }],
    });
    const run = await call<{ data: { id: string; status: string } }>(first.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId: createdCase.body.data.id },
    });
    expect(run.body.data.status).toBe('running');

    await first.close();
    apis.pop();

    const second = await open(dataDir, { engine: createFakeEngine() });
    const reopened = await call<{ data: { status: string; error: { code: string; message: string } | null } }>(
      second.baseUrl,
      'GET',
      `/api/v1/runs/${run.body.data.id}`,
    );
    expect(reopened.body.data.status).toBe('error');
    expect(reopened.body.data.error?.code).toBe('RUN_INTERRUPTED');
  });
});