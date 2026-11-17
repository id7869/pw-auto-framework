/**
 * Agent 最短路径自证脚本（docs/acceptance-plan.md §3 A12-3）。
 *
 * 只用 4 类 HTTP 调用完成「建用例 → 运行 → 查状态（轮询为 MUST）→ 取逐项结果」，
 * 不依赖任何 SDK/前端，验证「agent 可直接用 HTTP 驱动本框架」。
 *
 * 用法：node tests/e2e/agent-quickstart.mjs [apiBase] [fixtureBase]
 * 输出：一行 JSON（含每一步的 status/id/耗时与调用次数），stdout 供 e2e 断言。
 */

const apiBase = process.argv[2] ?? process.env['PW_E2E_API_BASE'] ?? 'http://127.0.0.1:8787';
const fixtureBase = process.argv[3] ?? process.env['PW_E2E_FIXTURE_BASE'] ?? 'http://127.0.0.1:4174';

const calls = [];
async function call(method, path, body) {
  const startedAt = Date.now();
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  const parsed = text === '' ? null : JSON.parse(text);
  calls.push({ method, path, status: response.status, durationMs: Date.now() - startedAt });
  return { status: response.status, body: parsed, headers: response.headers };
}

function unwrap(result) {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`HTTP ${result.status}：${JSON.stringify(result.body).slice(0, 300)}`);
  }
  return result.body.data;
}

async function main() {
  const startedAt = Date.now();
  // ① 建用例（结构化步骤）
  const created = unwrap(
    await call('POST', '/api/v1/cases', {
      name: `agent-quickstart-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${fixtureBase}/` },
        { id: 'st_2', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '你好，自动化' },
      ],
      tags: ['@agent'],
    }),
  );
  // ② 运行
  const run = unwrap(await call('POST', '/api/v1/runs', { target: { kind: 'case', caseId: created.id }, reason: 'agent-quickstart' }));
  // ③ 轮询状态（官方要求：轮询为 MUST）
  let current = run;
  const statuses = [current.status];
  while (!['passed', 'failed', 'cancelled', 'error'].includes(current.status)) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    current = unwrap(await call('GET', `/api/v1/runs/${run.id}`));
    if (statuses[statuses.length - 1] !== current.status) statuses.push(current.status);
  }
  // ④ 取逐项结果
  const items = unwrap(await call('GET', `/api/v1/runs/${run.id}/items?limit=100`));

  const summary = {
    ok: current.status === 'passed' && items.items.length === 1 && items.items[0].outcome === 'expected',
    caseId: created.id,
    runId: run.id,
    status: current.status,
    statusSequence: statuses,
    stats: current.stats,
    itemKey: items.items[0]?.itemKey,
    itemOutcome: items.items[0]?.outcome,
    endpointsUsed: [...new Set(calls.map((entry) => `${entry.method} ${entry.path.split('?')[0].replace(/_[0-9a-f]{32}/g, '_:id')}`))],
    totalCalls: calls.length,
    calls,
    durationMs: Date.now() - startedAt,
  };
  console.log(JSON.stringify(summary));
  process.exitCode = summary.ok ? 0 : 1;
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: String(error), calls }));
  process.exitCode = 1;
});