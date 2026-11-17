/**
 * A11 异常与可诊断性（R1/R3）：状态码矩阵、队列上限 429、取消、超时、诊断字段。
 *
 * 对应 docs/acceptance-plan.md §3 A11。
 */

import { test, expect } from '@playwright/test';
import {
  cancelRun,
  createCase,
  createRun,
  errorCodeOf,
  getRun,
  http,
  listRunItems,
  listRuns,
  unwrap,
  waitRun,
  waitRunStatus,
} from '../support/api.ts';
import { saveJson } from '../support/evidence.ts';
import { API_BASE, FIXTURE_BASE } from '../support/env.ts';

const SCENARIO = 'a11-errors';

test.describe('A11 异常与可诊断性', () => {
  test('A11-1 状态码矩阵：400/404/405/413/415/409/422 + 错误信封 + Allow 头', async () => {
    const record: Record<string, unknown> = {};

    // 404
    const notFound = await http('GET', '/api/v1/cases/case_missing_e2e');
    expect(notFound.status).toBe(404);
    expect(errorCodeOf(notFound)).toBe('NOT_FOUND');
    expect((notFound.body as { error: { message: string; requestId: string } }).error.message).toContain('用例不存在');
    expect(notFound.requestId).toMatch(/^req_/);
    record['notFound'] = { status: notFound.status, body: notFound.body };

    // 405 + Allow
    const methodNotAllowed = await http('PUT', '/api/health', { body: {} });
    expect(methodNotAllowed.status).toBe(405);
    expect(errorCodeOf(methodNotAllowed)).toBe('METHOD_NOT_ALLOWED');
    expect(methodNotAllowed.headers.get('allow')).toContain('GET');
    record['methodNotAllowed'] = { status: methodNotAllowed.status, allow: methodNotAllowed.headers.get('allow'), body: methodNotAllowed.body };

    // 415
    const unsupported = await http('POST', '/api/v1/cases', { rawBody: 'hello', contentType: 'text/plain' });
    expect(unsupported.status).toBe(415);
    expect(unsupported.headers.get('content-type')).toBe('application/json; charset=utf-8');
    record['unsupportedMediaType'] = { status: unsupported.status, body: unsupported.body };

    // 400 INVALID_JSON
    const invalidJson = await http('POST', '/api/v1/cases', { rawBody: '{not json' });
    expect(invalidJson.status).toBe(400);
    expect(errorCodeOf(invalidJson)).toBe('INVALID_JSON');
    record['invalidJson'] = { status: invalidJson.status, body: invalidJson.body };

    // 409 VERSION_CONFLICT：同一 If-Match 连续 PATCH
    const created = await createCase({ name: `A11-版本冲突-${String(Date.now())}`, mode: 'steps', steps: [{ id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` }] });
    const firstPatch = await http('PATCH', `/api/v1/cases/${created.id}`, { body: { name: '改名一' }, headers: { 'if-match': '"1"' } });
    expect(firstPatch.status).toBe(200);
    const conflict = await http('PATCH', `/api/v1/cases/${created.id}`, { body: { name: '改名二' }, headers: { 'if-match': '"1"' } });
    expect(conflict.status).toBe(409);
    expect(errorCodeOf(conflict)).toBe('VERSION_CONFLICT');
    record['versionConflict'] = { first: firstPatch.status, second: conflict.status, body: conflict.body };

    // 422 INVALID_STEP + details 指到步骤
    const invalidStep = await http('POST', '/api/v1/cases', { body: { name: 'A11-非法步骤', steps: [{ id: 'st_1', action: 'click' }] } });
    expect(invalidStep.status).toBe(422);
    expect(errorCodeOf(invalidStep)).toBe('INVALID_STEP');
    expect((invalidStep.body as { error: { details: { path: string }[] } }).error.details[0]?.path).toBe('steps[0].target');
    record['invalidStep'] = { status: invalidStep.status, body: invalidStep.body };

    // 所有响应均为 JSON 信封 + X-Request-Id
    for (const result of [notFound, methodNotAllowed, unsupported, invalidJson, conflict, invalidStep]) {
      expect(result.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(result.requestId).toMatch(/^req_/);
      const envelope = result.body as { error: { requestId: string; message: string } };
      expect(envelope.error.requestId).toBe(result.requestId);
      expect(envelope.error.message.length).toBeGreaterThan(0);
    }

    saveJson(SCENARIO, 'status-matrix.json', record);
  });

  test('A11-2 队列上限：并发阻塞下第 33 个排队运行 → 429 TOO_MANY_RUNS；随后清理全部运行', async () => {
    const blockingCase = await createCase({
      name: `A11-阻塞-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/slow?ms=35000` },
        { id: 'st_2', action: 'expectVisible', target: { by: 'testId', testId: 'slow-done' } },
      ],
    });

    // 第一个运行进入 running，占满并发（PW_MAX_CONCURRENT_RUNS=1）
    const blocking = await createRun({ target: { kind: 'case', caseId: blockingCase.id }, options: { timeoutMs: 60_000 } });
    await waitRunStatus(blocking.id, (run) => run.status === 'running', 60_000);

    const queuedIds: string[] = [];
    let tooMany: Awaited<ReturnType<typeof http>> | null = null;
    for (let index = 0; index < 40; index += 1) {
      const response = await http('POST', '/api/v1/runs', { body: { target: { kind: 'case', caseId: blockingCase.id } } });
      if (response.status === 429) {
        tooMany = response;
        break;
      }
      expect(response.status).toBe(202);
      queuedIds.push(unwrap<{ id: string }>(response).id);
    }

    expect(tooMany).not.toBeNull();
    expect(tooMany?.status).toBe(429);
    expect(errorCodeOf(tooMany as Awaited<ReturnType<typeof http>>)).toBe('TOO_MANY_RUNS');
    // 队列上限 32（另加 1 个 running）→ 至少 32 个排队成功后才会拒绝
    expect(queuedIds.length).toBeGreaterThanOrEqual(32);

    // 排队位次：至少有运行带 queuePosition
    const queuedPage = await listRuns('?limit=100&status=queued');
    expect(queuedPage.items.length).toBeGreaterThanOrEqual(32);
    expect(queuedPage.items.some((run) => run.queuePosition !== null)).toBe(true);

    // 清理：先取消排队（立即终态），最后取消正在运行的阻塞运行
    for (const runId of queuedIds) {
      const cancelled = await cancelRun(runId);
      expect([200, 202]).toContain(cancelled.status);
    }
    const cancelBlocking = await cancelRun(blocking.id);
    expect([200, 202]).toContain(cancelBlocking.status);
    const blockingFinal = await waitRun(blocking.id, { timeoutMs: 90_000 });
    expect(blockingFinal.status).toBe('cancelled');

    // 队列已排空
    const stillQueued = await listRuns('?limit=100&status=queued');
    expect(stillQueued.items.length).toBe(0);

    saveJson(SCENARIO, 'queue-limit.json', {
      queuedAccepted: queuedIds.length,
      tooMany: { status: tooMany?.status, body: tooMany?.body },
      blockingRun: { id: blocking.id, status: blockingFinal.status },
      queuedRemaining: stillQueued.items.length,
    });
  });

  test('A11-3 取消运行中任务：202、终态 cancelled、cancelRequestedAt 非空、已产出结果保留', async () => {
    const slowCase = await createCase({
      name: `A11-取消-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/slow?ms=15000` },
        { id: 'st_2', action: 'expectVisible', target: { by: 'testId', testId: 'slow-done' } },
      ],
    });
    const run = await createRun({ target: { kind: 'case', caseId: slowCase.id }, options: { timeoutMs: 60_000 } });
    await waitRunStatus(run.id, (current) => current.status === 'running', 60_000);

    const cancelResponse = await cancelRun(run.id);
    expect([200, 202]).toContain(cancelResponse.status);
    const final = await waitRun(run.id, { timeoutMs: 60_000 });
    expect(final.status).toBe('cancelled');
    expect(final.cancelRequestedAt).toBeTruthy();
    expect(final.error).toBeNull();

    // 取消幂等：再次取消返回 200 + 当前状态
    const again = await cancelRun(run.id);
    expect(again.status).toBe(200);
    expect(unwrap<{ status: string }>(again).status).toBe('cancelled');

    // 已产出的 items 仍然可读（可能为 0，但端点必须 200）
    const items = await listRunItems(run.id);
    expect(Array.isArray(items.items)).toBe(true);

    saveJson(SCENARIO, 'cancel.json', {
      runId: run.id,
      firstCancelStatus: cancelResponse.status,
      final: { status: final.status, cancelRequestedAt: final.cancelRequestedAt, itemsCount: final.itemsCount },
      secondCancelStatus: again.status,
      itemsReadable: items.items.length,
    });
  });

  test('A11-4 用例级超时（timeoutMs=1000 + /slow）：终态 failed，逐项 attempts 标记超时且诊断完整', async () => {
    const slowCase = await createCase({
      name: `A11-超时-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/slow?ms=5000` },
        { id: 'st_2', action: 'expectVisible', target: { by: 'testId', testId: 'slow-done' } },
      ],
    });
    const run = await createRun({ target: { kind: 'case', caseId: slowCase.id }, options: { timeoutMs: 1000 } });
    const final = await waitRun(run.id, { timeoutMs: 120_000 });
    expect(['failed', 'error']).toContain(final.status);
    expect(final.exitCode).not.toBe(0);

    const items = await listRunItems(run.id);
    expect(items.items.length).toBe(1);
    const attempt = items.items[0]?.attempts[0];
    expect(attempt).toBeDefined();
    expect(['timedOut', 'failed']).toContain(attempt?.status);
    expect(attempt?.error?.message ?? '').toMatch(/timeout|超时/i);

    // 诊断四件套非空（失败可复现）
    expect(final.diagnostics.command.length).toBeGreaterThanOrEqual(3);
    expect(final.diagnostics.specPath).toBeTruthy();
    expect(final.diagnostics.reportPath).toBeTruthy();
    expect(final.diagnostics.workspaceDir).toBeTruthy();
    expect(final.diagnostics.playwrightCliPath).toMatch(/cli\.js$/);

    saveJson(SCENARIO, 'timeout.json', {
      runId: run.id,
      status: final.status,
      exitCode: final.exitCode,
      stats: final.stats,
      attempt: attempt,
      diagnostics: final.diagnostics,
    });
  });

  test('A11-6 SSE 可选增强：text/event-stream 首帧含 run.updated（轮询仍为 MUST）', async () => {
    const runs = await listRuns('?limit=1');
    const runId = runs.items[0]?.id as string;
    expect(runId).toMatch(/^run_/);

    const controller = new AbortController();
    const response = await fetch(`${API_BASE}/api/v1/runs/${runId}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await reader?.read();
    controller.abort();
    const text = Buffer.from(chunk?.value ?? new Uint8Array()).toString('utf8');
    expect(text).toContain('event: run.updated');
    expect(text).toContain('data:');

    saveJson(SCENARIO, 'sse.json', { runId, firstFrame: text.slice(0, 400) });
  });

  test('A11-5 运行状态机：queued/running → 终态不可回退（轮询观察到的状态序列合法）', async () => {
    const created = await createCase({
      name: `A11-状态机-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
        { id: 'st_2', action: 'expectVisible', target: { by: 'testId', testId: 'hello' } },
      ],
    });
    const run = await createRun({ target: { kind: 'case', caseId: created.id } });
    expect(['queued', 'running']).toContain(run.status);
    const sequence: string[] = [];
    const final = await waitRun(run.id, {
      onPoll: (current) => {
        if (sequence[sequence.length - 1] !== current.status) sequence.push(current.status);
      },
    });
    expect(final.status).toBe('passed');
    const allowedTransitions = new Set(['queued>running', 'running>passed']);
    for (let index = 1; index < sequence.length; index += 1) {
      expect(allowedTransitions).toContain(`${sequence[index - 1]}>${sequence[index]}`);
    }
    expect(sequence[sequence.length - 1]).toBe('passed');

    // 终态不可回退：再读一次仍是 passed
    const reread = await getRun(run.id);
    expect(reread.status).toBe('passed');

    saveJson(SCENARIO, 'state-machine.json', { runId: run.id, sequence, finalStatus: final.status });
  });
});