/**
 * A12 幂等与 agent 友好路径（R2/R5）。
 *
 * 对应 docs/acceptance-plan.md §3 A12：
 *  1. 同 Idempotency-Key + 同 body → 同一 runId，第二次 200 + Idempotent-Replay: true；
 *  2. 同 key + 不同 body → 409 IDEMPOTENCY_CONFLICT；
 *  3. 最短路径自证：独立脚本用 4 类 HTTP 调用完成「建用例 → 运行 → 轮询状态 → 取逐项结果」；
 *  4. 成功响应统一 application/json; charset=utf-8 + X-Request-Id。
 */

import { test, expect } from '@playwright/test';
import { createCase, errorCodeOf, getMeta, http, listCases, unwrap, waitRun } from '../support/api.ts';
import { saveJson, saveText } from '../support/evidence.ts';
import { API_BASE, FIXTURE_BASE, REPO_ROOT } from '../support/env.ts';
import { runProcess } from '../support/process.ts';

const SCENARIO = 'a12-idempotency';

test.describe('A12 幂等与 agent 友好', () => {
  test('A12-1/2 Idempotency-Key：同体重放返回同一运行；异体冲突 409', async () => {
    const caseA = await createCase({
      name: `A12-幂等-A-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
        { id: 'st_2', action: 'expectVisible', target: { by: 'testId', testId: 'hello' } },
      ],
    });
    const caseB = await createCase({
      name: `A12-幂等-B-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/login` },
        { id: 'st_2', action: 'expectVisible', target: { by: 'testId', testId: 'login-result' } },
      ],
    });

    const key = `idem-e2e-${String(Date.now())}`;
    const body = { target: { kind: 'case', caseId: caseA.id }, reason: '幂等验收' };

    const first = await http('POST', '/api/v1/runs', { body, headers: { 'idempotency-key': key } });
    expect(first.status).toBe(202);
    const firstRun = unwrap<{ id: string; idempotencyKey: string | null; status: string }>(first);
    expect(firstRun.idempotencyKey).toBe(key);
    expect(first.headers.get('idempotency-key')).toBe(key);
    expect(first.headers.get('idempotent-replay')).toBeNull();

    const second = await http('POST', '/api/v1/runs', { body, headers: { 'idempotency-key': key } });
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    const secondRun = unwrap<{ id: string }>(second);
    expect(secondRun.id).toBe(firstRun.id);

    // 同 key + 不同 body（换用例）→ 409
    const conflict = await http('POST', '/api/v1/runs', {
      body: { target: { kind: 'case', caseId: caseB.id } },
      headers: { 'idempotency-key': key },
    });
    expect(conflict.status).toBe(409);
    expect(errorCodeOf(conflict)).toBe('IDEMPOTENCY_CONFLICT');

    // 重放不会重复执行：两次请求得到同一运行，最终只有一条运行记录（按 id 过滤）
    const final = await waitRun(firstRun.id);
    expect(final.status).toBe('passed');
    const runsOfCase = await http('GET', `/api/v1/runs?caseId=${encodeURIComponent(caseA.id)}&limit=100`);
    const ids = unwrap<{ items: { id: string }[] }>(runsOfCase).items.map((run) => run.id);
    expect(ids.filter((id) => id === firstRun.id).length).toBe(1);

    saveJson(SCENARIO, 'idempotency.json', {
      key,
      first: { status: first.status, id: firstRun.id, replay: first.headers.get('idempotent-replay') },
      second: { status: second.status, id: secondRun.id, replay: second.headers.get('idempotent-replay') },
      conflict: { status: conflict.status, body: conflict.body },
      finalStatus: final.status,
      runCountForCase: ids.length,
    });
  });

  test('A12-3 最短路径自证：独立脚本 4 类 HTTP 调用完成全流程', async () => {
    const result = await runProcess(process.execPath, ['tests/e2e/agent-quickstart.mjs', API_BASE, FIXTURE_BASE], {
      cwd: REPO_ROOT,
      timeoutMs: 180_000,
    });
    expect(result.exitCode).toBe(0);
    const lastLine = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .pop();
    expect(lastLine).toBeTruthy();
    const summary = JSON.parse(lastLine as string) as {
      ok: boolean;
      caseId: string;
      runId: string;
      status: string;
      statusSequence: string[];
      stats: { expected: number };
      itemKey: string;
      itemOutcome: string;
      endpointsUsed: string[];
      totalCalls: number;
    };
    expect(summary.ok).toBe(true);
    expect(summary.status).toBe('passed');
    expect(summary.stats.expected).toBe(1);
    expect(summary.itemKey).toBe(summary.caseId);
    expect(summary.itemOutcome).toBe('expected');

    // 四类端点的最短路径
    const endpoints = summary.endpointsUsed;
    expect(endpoints).toContain('POST /api/v1/cases');
    expect(endpoints).toContain('POST /api/v1/runs');
    expect(endpoints.some((endpoint) => endpoint.startsWith('GET /api/v1/runs/') && !endpoint.includes('/items'))).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.includes('/items'))).toBe(true);
    // 轮询为 MUST：调用次数 = 1 建用例 + 1 运行 + N 轮询 + 1 取结果
    expect(summary.totalCalls).toBeGreaterThanOrEqual(4);

    saveJson(SCENARIO, 'quickstart.json', summary);
    saveText(SCENARIO, 'quickstart-raw.txt', `exit=${String(result.exitCode)}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  });

  test('A12-4 成功响应统一信封：application/json; charset=utf-8 + X-Request-Id + no-store', async () => {
    const meta = await getMeta();
    expect(meta.app.name).toBe('pw-auto-framework');

    const checks: { name: string; result: Awaited<ReturnType<typeof http>> }[] = [];
    checks.push({ name: 'meta', result: await http('GET', '/api/v1/meta') });
    checks.push({ name: 'cases', result: await http('GET', '/api/v1/cases?limit=1') });
    checks.push({ name: 'runs', result: await http('GET', '/api/v1/runs?limit=1') });
    checks.push({ name: 'cliCommands', result: await http('GET', '/api/v1/cli/commands') });
    const caseList = await listCases('?limit=1');
    expect(Array.isArray(caseList.items)).toBe(true);

    for (const check of checks) {
      expect(check.result.status).toBe(200);
      expect(check.result.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(check.result.headers.get('cache-control')).toBe('no-store');
      expect(check.result.requestId).toMatch(/^req_/);
      const envelope = check.result.body as { data?: unknown; meta?: { requestId?: string } };
      expect(envelope.data).toBeDefined();
      expect(envelope.meta?.requestId).toBe(check.result.requestId);
    }

    saveJson(SCENARIO, 'envelope.json', checks.map((check) => ({
      name: check.name,
      status: check.result.status,
      contentType: check.result.headers.get('content-type'),
      cacheControl: check.result.headers.get('cache-control'),
      requestId: check.result.requestId,
      metaRequestId: (check.result.body as { meta?: { requestId?: string } }).meta?.requestId,
    })));
  });
});