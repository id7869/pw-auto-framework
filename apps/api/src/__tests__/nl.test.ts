/**
 * R6 NL-first 后端集成测试（api-contract §12/§13，amended 三入口口径）：
 * - NL 模型：Create/PUT/DELETE、5 态派生、lines/warnings、旧用例零变化；
 * - 生成任务：7 态、租约、互斥、队列、submit 校验、accept/stale/force、reject/cancel；
 * - 门禁：draft/generating/invalid → 422；stale validate warning / run 409（allowStaleNl 放行）；
 * - 数据驱动：datasetColumns 快照、submit 列校验、accept 后 {{列}} 走现有逐行执行；
 * - 持久化：重启后 NL/生成任务仍可读（迁移幂等）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  call,
  cleanupDir,
  dataOf,
  makeTempDir,
  startApi,
  startApiIn,
  waitFor,
  type TestApi,
} from './helpers.ts';
import { createFakeEngine, type FakeEngine } from './fake-engine.ts';

let api: TestApi | null = null;

afterEach(async () => {
  if (api) {
    await api.close();
    cleanupDir(api.dataDir);
    api = null;
  }
});

const NL_TEXT = ['打开 http://127.0.0.1:4174/login', '在「用户名」输入 {{用户名}}', '点击「登录」', '页面上应该出现「欢迎」'].join(
  '\n',
);

async function createCase(body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await call<{ data: Record<string, any> }>(api!.baseUrl, 'POST', '/api/v1/cases', body);
  expect(response.status).toBe(201);
  return dataOf(response);
}

async function validSteps(): Promise<Record<string, unknown>[]> {
  return [
    { id: 's1', action: 'goto', url: 'http://127.0.0.1:4174/login' },
    { id: 's2', action: 'fill', target: { by: 'css', selector: 'input[name=username]' }, value: '{{用户名}}' },
    { id: 's3', action: 'click', target: { by: 'css', selector: 'button[type=submit]' } },
  ];
}

async function createGeneration(caseId: string, body: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const response = await call<{ data: Record<string, any> }>(
    api!.baseUrl,
    'POST',
    `/api/v1/cases/${caseId}/nl/generations`,
    { generator: 'agent', ...body },
  );
  expect(response.status).toBe(202);
  return dataOf(response);
}

async function claim(generationId: string): Promise<Record<string, any>> {
  const response = await call<{ data: Record<string, any> }>(
    api!.baseUrl,
    'POST',
    `/api/v1/nl/generations/${generationId}/claim`,
    {},
  );
  expect(response.status).toBe(200);
  return dataOf(response);
}

async function submitReady(caseId: string, steps: Record<string, unknown>[]): Promise<Record<string, any>> {
  const generation = await createGeneration(caseId);
  const claimed = await claim(generation.id);
  const submitted = await call<{ data: Record<string, any> }>(
    api!.baseUrl,
    'POST',
    `/api/v1/nl/generations/${generation.id}/submit`,
    {
      leaseId: claimed.leaseId,
      steps,
      generatorVersion: 'skill/1.0.0',
      stepOrigin: Object.fromEntries(steps.map((step, index) => [step['id'], { nlLine: index + 1 }])),
    },
  );
  expect([200]).toContain(submitted.status);
  expect(dataOf(submitted).status).toBe('ready');
  return dataOf(submitted);
}

describe('NL 模型：创建/读写/5 态/旧用例零变化', () => {
  it('POST /cases 接受 nl.text（draft，hash/lines 派生）；旧用例 nl=null 且 PATCH 拒绝 nl', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const withNl = await createCase({ name: 'NL 用例', nl: { text: NL_TEXT } });
    expect(withNl.nl).toMatchObject({ status: 'draft', origin: null, generatorVersion: null, warnings: [] });
    expect(withNl.nl.sourceHash).toMatch(/^[a-f0-9]{16}$/);
    expect(withNl.nl.lines).toHaveLength(4);
    expect(withNl.nl.lines[0].kind).toBe('instruction');
    expect(withNl.nl.lines[1].kind).toBe('step');
    expect(withNl.stepOrigin).toBeNull();

    const plain = await createCase({ name: '旧用例', steps: [] });
    expect(plain.nl ?? null).toBeNull();
    expect(plain.stepOrigin ?? null).toBeNull();

    const patchNl = await call<{ error: { code: string } }>(api.baseUrl, 'PATCH', `/api/v1/cases/${withNl.id}`, {
      nl: { text: '改文本' },
    }, { headers: { 'if-match': String(withNl.version) } });
    expect(patchNl.status).toBe(422);
    expect(patchNl.body.error.code).toBe('VALIDATION_FAILED');

    const read = await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', `/api/v1/cases/${withNl.id}/nl`);
    expect(read.status).toBe(200);
    expect(read.body.data.text).toBe(NL_TEXT);
    expect(read.body.data.status).toBe('draft');
  });

  it('PUT 重置草稿；DELETE 移除 nl/stepOrigin 但保留 steps；GET 无 nl → 404', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const created = await createCase({ name: '可编辑 NL', steps: await validSteps(), nl: { text: NL_TEXT } });

    const put = await call<{ data: Record<string, any> }>(api.baseUrl, 'PUT', `/api/v1/cases/${created.id}/nl`, {
      text: '打开 http://127.0.0.1:4174/login',
    });
    expect(put.status).toBe(200);
    expect(put.body.data.status).toBe('draft');
    expect(put.body.data.lines).toHaveLength(1);

    const removed = await call(api.baseUrl, 'DELETE', `/api/v1/cases/${created.id}/nl`);
    expect(removed.status).toBe(204);
    const afterDelete = await call<{ error: { code: string } }>(api.baseUrl, 'GET', `/api/v1/cases/${created.id}/nl`);
    expect(afterDelete.status).toBe(404);
    const fetched = await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', `/api/v1/cases/${created.id}`);
    expect(fetched.body.data.steps).toHaveLength(3);
    expect(fetched.body.data.nl ?? null).toBeNull();
  });
});

describe('生成任务 7 态 / 租约 / 互斥 / submit 校验 / accept', () => {
  it('queued→claim→submit→ready→accept 全链路；active 互斥 409；claim 非 queued 409', async () => {
    const engine: FakeEngine = createFakeEngine();
    api = await startApi({ engine });
    const created = await createCase({ name: '生成用例', nl: { text: NL_TEXT } });
    const generation = await createGeneration(created.id);
    expect(generation).toMatchObject({ status: 'queued', generator: 'agent', caseName: '生成用例', nlText: NL_TEXT });
    expect(generation.datasetColumns).toEqual([]);
    expect(generation.sourceHash).toMatch(/^[a-f0-9]{16}$/);

    const conflict = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${created.id}/nl/generations`,
      { generator: 'agent' },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('NL_GENERATION_CONFLICT');

    // 用例状态派生：有活跃任务 → generating，validate/run → 422 NL_NOT_GENERATED
    const runningCase = await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', `/api/v1/cases/${created.id}`);
    expect(runningCase.body.data.nl.status).toBe('generating');
    for (const [method, path, body] of [
      ['POST', `/api/v1/cases/${created.id}/validate`, {}],
      ['POST', '/api/v1/runs', { target: { kind: 'case', caseId: created.id } }],
    ] as const) {
      const gated = await call<{ error: { code: string } }>(api.baseUrl, method, path, body);
      expect(gated.status).toBe(422);
      expect(gated.body.error.code).toBe('NL_NOT_GENERATED');
    }

    const claimed = await claim(generation.id);
    expect(claimed.status).toBe('running');
    expect(claimed.leaseId).toMatch(/^lease_/);
    expect(claimed.leaseExpiresAt).toBeTruthy();
    expect(claimed.leaseAttempts).toBe(1);

    const claimAgain = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${generation.id}/claim`,
      {},
    );
    expect(claimAgain.status).toBe(409);
    expect(claimAgain.body.error.code).toBe('NL_GENERATION_CONFLICT');

    const submitted = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${generation.id}/submit`,
      {
        leaseId: claimed.leaseId,
        steps: await validSteps(),
        generatorVersion: 'skill/1.0.0',
        stepOrigin: { s1: { nlLine: 1 }, s2: { nlLine: 2 }, s3: { nlLine: 3 } },
      },
    );
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('ready');
    expect(submitted.body.data.steps).toHaveLength(3);

    const accepted = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${created.id}/nl/generations/${generation.id}/accept`,
      {},
    );
    expect(accepted.status).toBe(200);
    const acceptedCase = accepted.body.data.case;
    expect(acceptedCase.steps).toHaveLength(3);
    expect(acceptedCase.stepOrigin).toEqual({ s1: { nlLine: 1 }, s2: { nlLine: 2 }, s3: { nlLine: 3 } });
    expect(acceptedCase.nl.status).toBe('generated');
    expect(acceptedCase.nl.origin).toBe('agent');
    expect(accepted.body.data.generation.status).toBe('accepted');

    // accept 幂等
    const again = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${created.id}/nl/generations/${generation.id}/accept`,
      {},
    );
    expect(again.status).toBe(200);
    expect(again.body.data.case.version).toBe(acceptedCase.version);

    // 生成后 validate 正常（带数据集列不报 UNKNOWN_COLUMN）
    const validated = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', `/api/v1/cases/${created.id}/validate`, {});
    expect(validated.status).toBe(200);
    expect(validated.body.data.ok).toBe(true);

    // 运行正常
    const run = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId: created.id },
    });
    expect(run.status).toBe(202);
    const terminal = await waitFor(
      () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${run.body.data.id}`),
      (result) => ['passed', 'failed', 'cancelled', 'error'].includes(result.body.data.status),
    );
    expect(terminal.body.data.status).toBe('passed');
  });

  it('submit 校验：非法 step / 未知列 / stepOrigin 缺失或越界 / 空结果 → 422 NL_SUBMIT_INVALID；租约失效 409', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const created = await createCase({ name: 'submit 校验', nl: { text: NL_TEXT } });
    const dataset = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', `/api/v1/cases/${created.id}/datasets`, {
      name: '列校验集',
      rows: [{ data: { 用户名: '张三' } }],
    });
    expect(dataset.status).toBe(201);

    const generation = await createGeneration(created.id);
    expect(generation.datasetColumns).toEqual(['用户名']);
    const claimed = await claim(generation.id);

    const badColumn = await call<{ error: { code: string; message: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${generation.id}/submit`,
      {
        leaseId: claimed.leaseId,
        steps: [{ id: 's1', action: 'fill', target: { by: 'css', selector: '#u' }, value: '{{不存在}}' }],
        generatorVersion: 'skill/1',
        datasetId: dataset.body.data.id,
      },
    );
    expect(badColumn.status).toBe(422);
    expect(badColumn.body.error.code).toBe('NL_SUBMIT_INVALID');

    const badOrigin = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${generation.id}/submit`,
      {
        leaseId: claimed.leaseId,
        steps: await validSteps(),
        generatorVersion: 'skill/1',
        stepOrigin: { s1: { nlLine: 1 } },
      },
    );
    expect(badOrigin.status).toBe(422);
    expect(badOrigin.body.error.code).toBe('NL_SUBMIT_INVALID');

    const empty = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${generation.id}/submit`,
      { leaseId: claimed.leaseId, generatorVersion: 'skill/1' },
    );
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe('NL_SUBMIT_INVALID');

    const invalidLease = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${generation.id}/submit`,
      { leaseId: 'lease_wrong', steps: await validSteps(), generatorVersion: 'skill/1' },
    );
    expect(invalidLease.status).toBe(409);

    // 首次成功提交后 ready；再用不同内容提交 → 409
    const ok = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${generation.id}/submit`,
      { leaseId: claimed.leaseId, steps: await validSteps(), generatorVersion: 'skill/1' },
    );
    expect(ok.status).toBe(200);
    const overwrite = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${generation.id}/submit`,
      { leaseId: claimed.leaseId, steps: [], generatorVersion: 'skill/2' },
    );
    expect(overwrite.status).toBe(409);
  });

  it('stale 语义：编辑文本后 validate 带 NL_STALE warning、run 409、allowStaleNl 放行；accept 需 force', async () => {
    const engine: FakeEngine = createFakeEngine();
    api = await startApi({ engine });
    const created = await createCase({ name: 'stale 用例', nl: { text: NL_TEXT } });
    await submitReady(created.id, await validSteps());
    const history = await call<{ data: { items: Record<string, any>[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/cases/${created.id}/nl/generations`,
    );
    const generationId = history.body.data.items[0]!.id;
    const accept = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', `/api/v1/cases/${created.id}/nl/generations/${generationId}/accept`, {});
    expect(accept.status).toBe(200);

    await call(api.baseUrl, 'PUT', `/api/v1/cases/${created.id}/nl`, { text: `${NL_TEXT}\n再做一次检查` });
    const staleCase = await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', `/api/v1/cases/${created.id}`);
    expect(staleCase.body.data.nl.status).toBe('stale');

    const validated = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', `/api/v1/cases/${created.id}/validate`, {});
    expect(validated.status).toBe(200);
    expect(validated.body.data.warnings.map((warning: { code: string }) => warning.code)).toContain('NL_STALE');

    const gated = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId: created.id },
    });
    expect(gated.status).toBe(409);
    expect(gated.body.error.code).toBe('NL_STALE');

    const forced = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId: created.id },
      options: { allowStaleNl: true },
    });
    expect(forced.status).toBe(202);
    await waitFor(
      () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${forced.body.data.id}`),
      (result) => ['passed', 'failed', 'cancelled', 'error'].includes(result.body.data.status),
    );

    // 新生成结果对应旧文本；再次编辑文本后 accept 需 force
    const staleGeneration = await createGeneration(created.id);
    const claimed = await claim(staleGeneration.id);
    const submitted = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${staleGeneration.id}/submit`,
      { leaseId: claimed.leaseId, steps: await validSteps(), generatorVersion: 'skill/1' },
    );
    expect(submitted.status).toBe(200);
    await call(api.baseUrl, 'PUT', `/api/v1/cases/${created.id}/nl`, { text: `${NL_TEXT}\n第三版文本` });
    const staleAccept = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${created.id}/nl/generations/${staleGeneration.id}/accept`,
      {},
    );
    expect(staleAccept.status).toBe(409);
    expect(staleAccept.body.error.code).toBe('NL_STALE');
    const forcedAccept = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${created.id}/nl/generations/${staleGeneration.id}/accept`,
      { force: true },
    );
    expect(forcedAccept.status).toBe(200);
  });

  it('reject / cancel / rule 开关 / 跨用例队列', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const caseA = await createCase({ name: '用例A', nl: { text: NL_TEXT } });
    const caseB = await createCase({ name: '用例B', nl: { text: NL_TEXT } });

    const ruleDisabled = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${caseA.id}/nl/generations`,
      { generator: 'rule' },
    );
    expect(ruleDisabled.status).toBe(403);
    expect(ruleDisabled.body.error.code).toBe('NL_RULE_FALLBACK_DISABLED');

    const genA = await createGeneration(caseA.id);
    const genB = await createGeneration(caseB.id);

    const queue = await call<{ data: { items: Record<string, any>[] } }>(
      api.baseUrl,
      'GET',
      '/api/v1/nl/generations?status=queued',
    );
    expect(queue.status).toBe(200);
    expect(queue.body.data.items.map((item) => item.id).sort()).toEqual([genA.id, genB.id].sort());
    expect(queue.body.data.items.every((item) => item.caseName && item.nlText)).toBe(true);

    // cancel queued
    const cancelled = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${caseA.id}/nl/generations/${genA.id}/cancel`,
      {},
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');

    // reject ready
    const claimed = await claim(genB.id);
    await call(api.baseUrl, 'POST', `/api/v1/nl/generations/${genB.id}/submit`, {
      leaseId: claimed.leaseId,
      steps: await validSteps(),
      generatorVersion: 'skill/1',
    });
    const rejected = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', `/api/v1/cases/${caseB.id}/nl/generations/${genB.id}/reject`, {
      reason: '业务语义不符',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('rejected');
    expect(rejected.body.data.error.code).toBe('NL_GENERATION_REJECTED');
  });
});

describe('数据驱动：datasetColumns 快照 / 列校验 / {{列}} 逐行执行', () => {
  it('NL 生成的步骤保留 {{用户名}}，按数据集逐行执行（itemKey #row:N）', async () => {
    const engine: FakeEngine = createFakeEngine();
    api = await startApi({ engine });
    const created = await createCase({ name: 'NL 数据驱动', nl: { text: '打开 http://127.0.0.1:4174/login\n在「用户名」输入 {{用户名}}\n点击「登录」' } });
    const dataset = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', `/api/v1/cases/${created.id}/datasets`, {
      name: '两行数据',
      rows: [{ data: { 用户名: '张三' } }, { data: { 用户名: '李四' } }],
    });
    expect(dataset.status).toBe(201);

    const generation = await createGeneration(created.id);
    expect(generation.datasetColumns).toEqual(['用户名']);
    const claimed = await claim(generation.id);
    const steps = [
      { id: 's1', action: 'goto', url: 'http://127.0.0.1:4174/login' },
      { id: 's2', action: 'fill', target: { by: 'css', selector: '#u' }, value: '{{用户名}}' },
    ];
    const submitted = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${generation.id}/submit`,
      { leaseId: claimed.leaseId, steps, generatorVersion: 'skill/1', datasetId: dataset.body.data.id },
    );
    expect(submitted.status).toBe(200);
    const accepted = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${created.id}/nl/generations/${generation.id}/accept`,
      {},
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.case.steps[1].value).toBe('{{用户名}}');

    const run = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', '/api/v1/runs', {
      target: { kind: 'case', caseId: created.id },
      datasetId: dataset.body.data.id,
    });
    expect(run.status).toBe(202);
    const terminal = await waitFor(
      () => call<{ data: Record<string, any> }>(api!.baseUrl, 'GET', `/api/v1/runs/${run.body.data.id}`),
      (result) => ['passed', 'failed', 'cancelled', 'error'].includes(result.body.data.status),
    );
    expect(terminal.body.data.status).toBe('passed');
    expect(terminal.body.data.stats.expected).toBe(2);
    const items = await call<{ data: { items: Record<string, any>[] } }>(api.baseUrl, 'GET', `/api/v1/runs/${run.body.data.id}/items`);
    expect(items.body.data.items.map((item) => item.itemKey)).toEqual([`${created.id}#row:0`, `${created.id}#row:1`]);
  });
});

describe('只读 spec 预览与持久化恢复', () => {
  it('GET /cases/{id}/spec?preview=1 返回编译文本（不落盘）；缺 preview/非法值 → 422；引擎不可用 → 501', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const created = await createCase({ name: 'spec 预览', steps: await validSteps() });

    const preview = await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', `/api/v1/cases/${created.id}/spec?preview=1`);
    expect(preview.status).toBe(200);
    expect(preview.body.data.text.length).toBeGreaterThan(0);
    expect(preview.body.data.stepsCount).toBe(3);
    expect(preview.body.data.rowsCount).toBe(0);

    const missing = await call<{ error: { code: string } }>(api.baseUrl, 'GET', `/api/v1/cases/${created.id}/spec`);
    expect(missing.status).toBe(422);
    const invalid = await call<{ error: { code: string } }>(api.baseUrl, 'GET', `/api/v1/cases/${created.id}/spec?preview=2`);
    expect(invalid.status).toBe(422);

    await api.close();
    api = null;
    const noEngine = await startApi({ engine: null });
    api = noEngine;
    const caseNoEngine = await createCase({ name: '无引擎', steps: [] });
    const notImplemented = await call<{ error: { code: string } }>(
      noEngine.baseUrl,
      'GET',
      `/api/v1/cases/${caseNoEngine.id}/spec?preview=1`,
    );
    expect(notImplemented.status).toBe(501);
  });

  it('重启后 NL 状态/生成历史仍在（迁移幂等，不破坏既有用例）', async () => {
    const dataDir = makeTempDir();
    const engine = createFakeEngine();
    api = await startApiIn(dataDir, { engine });
    const created = await createCase({ name: '持久化 NL', nl: { text: NL_TEXT } });
    const generation = await submitReady(created.id, await validSteps());
    await call(api.baseUrl, 'POST', `/api/v1/cases/${created.id}/nl/generations/${generation.id}/accept`, {});
    await api.close();
    api = null;

    const restarted = await startApiIn(dataDir, { engine });
    api = restarted;
    const fetched = await call<{ data: Record<string, any> }>(restarted.baseUrl, 'GET', `/api/v1/cases/${created.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.nl.status).toBe('generated');
    expect(fetched.body.data.stepOrigin).toBeTruthy();
    const history = await call<{ data: { items: Record<string, any>[] } }>(
      restarted.baseUrl,
      'GET',
      `/api/v1/cases/${created.id}/nl/generations`,
    );
    expect(history.body.data.items.map((item) => item.status)).toContain('accepted');
    cleanupDir(dataDir);
  });
});

// ---------------------------------------------------------------------------
// t47 repair-round-2：F1~F5 回归（同内容重放 / 运行期租约 / failed→PUT / accept 事务）
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

function mutateDb(dataDir: string, sql: string, params: (string | number | null)[] = []): void {
  const db = new DatabaseSync(join(dataDir, 'pw-auto.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const statement = db.prepare(sql);
    statement.run(...params);
  } finally {
    db.close();
  }
}

function pastIso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

describe('t47 回归：ready 幂等含 stepOrigin', () => {
  it('同 leaseId + 同 steps/stepOrigin 重复 submit → 200 同一 generation；内容/租约不同 → 409；ready 保留 leaseId 但 leaseExpiresAt=null', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const created = await createCase({ name: 'F1 幂等', nl: { text: NL_TEXT } });
    const generation = await createGeneration(created.id);
    const claimed = await claim(generation.id);
    const steps = await validSteps();
    const stepOrigin = { s1: { nlLine: 1 }, s2: { nlLine: 2 }, s3: { nlLine: 3 } };
    const payload = { leaseId: claimed.leaseId, steps, stepOrigin, generatorVersion: 'skill/1.0.0' };

    const first = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', `/api/v1/nl/generations/${generation.id}/submit`, payload);
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('ready');
    expect(first.body.data.leaseId).toBe(claimed.leaseId);
    expect(first.body.data.leaseExpiresAt).toBeNull();
    expect(first.body.data.stepOrigin).toEqual(stepOrigin);

    // 同内容（stepOrigin 键顺序不同）→ 200 + 同一 generation（不重复写入）
    const replay = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', `/api/v1/nl/generations/${generation.id}/submit`, {
      ...payload,
      stepOrigin: { s3: { nlLine: 3 }, s1: { nlLine: 1 }, s2: { nlLine: 2 } },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(generation.id);
    expect(replay.body.data.updatedAt).toBe(first.body.data.updatedAt);

    // 不同 stepOrigin（内容不同）→ 409
    const differentOrigin = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${generation.id}/submit`,
      { ...payload, stepOrigin: { s1: { nlLine: 2 }, s2: { nlLine: 2 }, s3: { nlLine: 3 } } },
    );
    expect(differentOrigin.status).toBe(409);
    expect(differentOrigin.body.error.code).toBe('NL_GENERATION_CONFLICT');

    // 不同 leaseId（伪造/旧租约）同内容 → 409
    const differentLease = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${generation.id}/submit`,
      { ...payload, leaseId: 'lease_0000000000000000' },
    );
    expect(differentLease.status).toBe(409);
    expect(differentLease.body.error.code).toBe('NL_GENERATION_CONFLICT');
  });
});

describe('t47 回归：运行期租约回收（不重启）+ failed→PUT→draft', () => {
  it('请求级 recoverExpired：running 过期→queued(attempts+1) 可再 claim；queued 超时→failed；failed 后 PUT→draft', async () => {
    api = await startApi({
      engine: createFakeEngine(),
      config: { nlLeaseTimeoutMs: 5000, nlGenerationTimeoutMs: 5000 },
    });

    const caseA = await createCase({ name: 'F2 租约', nl: { text: NL_TEXT } });
    const genA = await createGeneration(caseA.id);
    const claimedA = await claim(genA.id);
    expect(claimedA.status).toBe('running');

    const caseB = await createCase({ name: 'F2/F3 超时', nl: { text: NL_TEXT } });
    const genB = await createGeneration(caseB.id);

    // 不重启：直接把租约/排队时间改成过去，模拟运行期到期
    mutateDb(api.dataDir, 'UPDATE nl_generations SET lease_expires_at = ? WHERE id = ?', [pastIso(1000), genA.id]);
    mutateDb(api.dataDir, 'UPDATE nl_generations SET created_at = ? WHERE id = ?', [pastIso(6000), genB.id]);

    // 任意队列请求触发请求级回收
    const queue = await call<{ data: { items: Record<string, any>[] } }>(
      api.baseUrl,
      'GET',
      '/api/v1/nl/generations?status=queued,running',
    );
    expect(queue.status).toBe(200);
    const requeuedA = queue.body.data.items.find((item) => item.id === genA.id)!;
    expect(requeuedA.status).toBe('queued');
    expect(requeuedA.leaseId).toBeNull();
    expect(requeuedA.leaseAttempts).toBe(2);

    const failedB = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'GET',
      `/api/v1/cases/${caseB.id}/nl/generations/${genB.id}`,
    );
    expect(failedB.body.data.status).toBe('failed');
    expect(failedB.body.data.error.code).toBe('NL_GENERATION_TIMEOUT');

    // failed → 用例派生 invalid；PUT 新文本 → draft（不得保持 invalid）
    const invalidCase = await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', `/api/v1/cases/${caseB.id}`);
    expect(invalidCase.body.data.nl.status).toBe('invalid');
    const put = await call<{ data: Record<string, any> }>(api.baseUrl, 'PUT', `/api/v1/cases/${caseB.id}/nl`, {
      text: `${NL_TEXT}\n再检查一次`,
    });
    expect(put.status).toBe(200);
    expect(put.body.data.status).toBe('draft');
    const afterPut = await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', `/api/v1/cases/${caseB.id}`);
    expect(afterPut.body.data.nl.status).toBe('draft');

    // 旧 failed 任务被标记 cancelled（可审计），不再把新文本判为 invalid
    const historyB = await call<{ data: { items: Record<string, any>[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/cases/${caseB.id}/nl/generations`,
    );
    expect(historyB.body.data.items.find((item) => item.id === genB.id)!.status).toBe('cancelled');

    // 重新 claim 成功（运行期回收释放了 active）；再过期 → attempts 达 3 → failed
    const reclaim = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/nl/generations/${genA.id}/claim`,
      {},
    );
    expect(reclaim.status).toBe(200);
    expect(reclaim.body.data.status).toBe('running');
    expect(reclaim.body.data.leaseAttempts).toBe(3);

    mutateDb(api.dataDir, 'UPDATE nl_generations SET lease_expires_at = ? WHERE id = ?', [pastIso(1000), genA.id]);
    const afterSweep = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'GET',
      `/api/v1/cases/${caseA.id}/nl/generations/${genA.id}`,
    );
    expect(afterSweep.body.data.status).toBe('failed');
    expect(afterSweep.body.data.error.code).toBe('NL_GENERATION_TIMEOUT');
  });
});

describe('t47 回归：真实 5s 租约过期（无重启）', () => {
  it(
    'claim(leaseSeconds=5) 后等待过期 → 请求级回收 running→queued(attempts+1) 并可重新 claim',
    async () => {
      api = await startApi({
        engine: createFakeEngine(),
        config: { nlLeaseTimeoutMs: 5000, nlGenerationTimeoutMs: 60000 },
      });
      const created = await createCase({ name: '真实租约过期', nl: { text: NL_TEXT } });
      const generation = await createGeneration(created.id);
      const claimed = await claim(generation.id);
      expect(claimed.leaseAttempts).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 5200));

      // 不重启：任意队列请求触发运行期回收
      const queue = await call<{ data: { items: Record<string, any>[] } }>(
        api.baseUrl,
        'GET',
        '/api/v1/nl/generations?status=queued,running',
      );
      const reclaimed = queue.body.data.items.find((item) => item.id === generation.id)!;
      expect(reclaimed.status).toBe('queued');
      expect(reclaimed.leaseId).toBeNull();
      expect(reclaimed.leaseAttempts).toBe(2);

      const again = await claim(generation.id);
      expect(again.leaseAttempts).toBe(3);
      expect(again.status).toBe('running');
    },
    20000,
  );
});

describe('t47 回归：accept 事务/重试', () => {
  it('stale 409 不半写（generation 仍 ready、case 未改）；force 重试成功；重复 accept 幂等；崩溃重试可恢复一致', async () => {
    api = await startApi({ engine: createFakeEngine() });
    const created = await createCase({ name: 'F4 事务', nl: { text: NL_TEXT } });
    const generation = await submitReady(created.id, await validSteps());
    const versionBefore = (await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', `/api/v1/cases/${created.id}`)).body.data.version;

    // 文本变更后 accept 无 force → 409，两侧均未写
    await call(api.baseUrl, 'PUT', `/api/v1/cases/${created.id}/nl`, { text: `${NL_TEXT}\n变更` });
    const versionAfterPut = (await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', `/api/v1/cases/${created.id}`)).body
      .data.version;
    const stale = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${created.id}/nl/generations/${generation.id}/accept`,
      {},
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('NL_STALE');
    const generationStillReady = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'GET',
      `/api/v1/cases/${created.id}/nl/generations/${generation.id}`,
    );
    expect(generationStillReady.body.data.status).toBe('ready');
    const caseUnchanged = await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', `/api/v1/cases/${created.id}`);
    expect(caseUnchanged.body.data.version).toBe(versionAfterPut);
    expect(caseUnchanged.body.data.steps).toHaveLength(0);

    // force 重试 → 两侧一致写入（同一事务）
    const forced = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${created.id}/nl/generations/${generation.id}/accept`,
      { force: true },
    );
    expect(forced.status).toBe(200);
    expect(forced.body.data.generation.status).toBe('accepted');
    expect(forced.body.data.case.steps.length).toBeGreaterThan(0);
    expect(forced.body.data.case.version).toBe(versionAfterPut + 1);
    expect(forced.body.data.generation.id).toBe(generation.id);

    // 重复 accept 幂等：case 版本不再增长
    const again = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${created.id}/nl/generations/${generation.id}/accept`,
      {},
    );
    expect(again.status).toBe(200);
    expect(again.body.data.case.version).toBe(versionAfterPut + 1);

    // 模拟「case 已写、generation 未置 accepted」的崩溃点：回拨 generation=ready 后重试 → 可恢复一致
    mutateDb(api.dataDir, "UPDATE nl_generations SET status = 'ready', accepted_at = NULL WHERE id = ?", [generation.id]);
    const retried = await call<{ data: Record<string, any> }>(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${created.id}/nl/generations/${generation.id}/accept`,
      { force: true },
    );
    expect(retried.status).toBe(200);
    expect(retried.body.data.generation.status).toBe('accepted');
    expect(retried.body.data.case.steps.length).toBeGreaterThan(0);
    expect(retried.body.data.generation.acceptedAt).toBeTruthy();
  });
});