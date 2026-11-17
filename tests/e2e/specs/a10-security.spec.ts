/**
 * A10 安全抽查（全部需求）：密钥、体积、路径穿越、命令注入、CORS、危险能力、进程清理、绑定。
 *
 * 对应 docs/acceptance-plan.md §3 A10 的 S1~S9。所有断言都是"值级"的：
 *  - 植入假密钥（PW_E2E_SECRET）不得出现在任何响应/前端页面/产物中；
 *  - 2 MiB 请求体 → 413；
 *  - 路径穿越被拒且不得返回任意文件内容；
 *  - URL 里的 `&` 不被当作命令分隔符（spawn argv，不拼 shell）；
 *  - CORS 只放行白名单；
 *  - 取消运行后浏览器/子进程回到基线；服务只绑定 127.0.0.1。
 */

import { test, expect } from '@playwright/test';
import {
  callMcpTool,
  closeMcpSession,
  collectKeys,
  createCase,
  createMcpSession,
  createRun,
  errorCodeOf,
  fetchArtifactContent,
  getMeta,
  http,
  unwrap,
  waitRun,
  waitRunStatus,
  cancelRun,
} from '../support/api.ts';
import { saveJson, saveText } from '../support/evidence.ts';
import { API_BASE, DATA_DIR, FIXTURE_BASE, PLANTED_SECRET_VALUE, WEB_BASE } from '../support/env.ts';
import { countBrowserProcesses, countBrowserProcessesWithMarker, countNodeProcessesWithMarker } from '../support/process.ts';

const SCENARIO = 'a10-security';

const SECRET_KEY_PATTERN = /password|passwd|cookie|token|secret|storageState|apiKey/i;

test.describe('A10 安全', () => {
  test('S1 密钥不出现在响应/前端/产物；S8 只绑定 127.0.0.1', async ({ page }) => {
    const meta = await getMeta();
    expect(meta.env.bindHost).toBe('127.0.0.1');

    // 响应体：植入的假密钥值绝不出现
    const metaText = JSON.stringify(meta);
    expect(metaText).not.toContain(PLANTED_SECRET_VALUE);
    // 键名不得出现 password/cookie/token/secret 等（避免把敏感字段带入 API）
    const sensitiveKeys = collectKeys(meta).filter((key) => SECRET_KEY_PATTERN.test(key));
    expect(sensitiveKeys).toEqual([]);

    // 运行响应同样不含密钥键
    const created = await createCase({
      name: `A10-密钥-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
        { id: 'st_2', action: 'expectVisible', target: { by: 'testId', testId: 'hello' } },
      ],
    });
    const run = await createRun({ target: { kind: 'case', caseId: created.id } });
    const final = await waitRun(run.id);
    const runText = JSON.stringify(final);
    expect(runText).not.toContain(PLANTED_SECRET_VALUE);
    expect(collectKeys(final).filter((key) => SECRET_KEY_PATTERN.test(key))).toEqual([]);

    // 产物内容（spec / stdout）不含密钥
    const artifacts = unwrap<{ items: { id: string; kind: string }[] }>(await http('GET', `/api/v1/runs/${run.id}/artifacts?limit=100`)).items;
    for (const artifact of artifacts) {
      const content = await fetchArtifactContent(run.id, artifact.id);
      expect(content.text).not.toContain(PLANTED_SECRET_VALUE);
    }

    // 前端页面（含健康页展示的 meta）不含密钥值
    await page.goto('/#/health');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain(PLANTED_SECRET_VALUE);
    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).not.toContain(PLANTED_SECRET_VALUE);
    // 前端源码（Vite dev 模块）也不应内联密钥
    const src = await (await page.request.get('/src/main.tsx')).text();
    expect(src).not.toContain(PLANTED_SECRET_VALUE);

    saveJson(SCENARIO, 'secret-check.json', {
      plantedSecretChecked: true,
      sensitiveKeysInMeta: sensitiveKeys,
      metaKeys: collectKeys(meta).length,
      runId: final.id,
      artifactsChecked: artifacts.length,
      frontendUrl: `${WEB_BASE}/#/health`,
      bindHost: meta.env.bindHost,
      apiBase: API_BASE,
    });
  });

  test('S2 超大请求体 → 413 PAYLOAD_TOO_LARGE；S3/S3b 路径穿越被拒且不泄露任意文件', async () => {
    // S2：2 MiB body（上限 1 MiB）
    const big = 'x'.repeat(2 * 1024 * 1024);
    const tooLarge = await http('POST', '/api/v1/cases', { rawBody: JSON.stringify({ name: big }), timeoutMs: 60_000 });
    expect(tooLarge.status).toBe(413);
    expect(errorCodeOf(tooLarge)).toBe('PAYLOAD_TOO_LARGE');

    // S3：产物内容端点带 ?path=../../package.json —— 参数不参与寻址，返回的只能是已登记产物
    const runList = unwrap<{ items: { id: string }[] }>(await http('GET', '/api/v1/runs?limit=1'));
    const runId = runList.items[0]?.id as string;
    const artifacts = unwrap<{ items: { id: string; kind: string; sizeBytes: number }[] }>(
      await http('GET', `/api/v1/runs/${runId}/artifacts?limit=100`),
    ).items;
    const artifact = artifacts[0];
    expect(artifact).toBeDefined();
    const withPathParam = await fetchArtifactContent(runId, artifact?.id as string, '?path=../../package.json');
    expect(withPathParam.status).toBe(200);
    // 返回的是登记产物的字节数（未被 path 参数影响），且内容不是仓库 package.json
    expect(withPathParam.bytes.byteLength).toBe(artifact?.sizeBytes);
    expect(withPathParam.text).not.toContain('"name": "pw-auto-framework"');
    expect(withPathParam.text).not.toContain('"packageManager"');

    // artifactId 里塞穿越片段 → 404（不存在该产物）
    const traversalArtifact = await fetch(`${API_BASE}/api/v1/runs/${runId}/artifacts/${encodeURIComponent('../../package.json')}/content`);
    expect(traversalArtifact.status).toBe(404);

    // S3b：Agent 工作区浏览绝对/越界路径 → 拒绝（未被任何文件内容泄露）
    // 说明：本用例先于 A9 执行，此时尚无脚手架 → 后端先返回 404 NOT_FOUND；
    // 有脚手架时的 400 INVALID_PATH / 403 PATH_FORBIDDEN 由 A9-1 覆盖。两者都属于「拒绝」。
    const windowsPath = await http('GET', `/api/v1/agents/workspace?path=${encodeURIComponent('C:\\Windows')}`);
    expect([400, 403, 404]).toContain(windowsPath.status);
    const upPath = await http('GET', `/api/v1/agents/workspace?path=${encodeURIComponent('../../../..')}`);
    expect([400, 403, 404]).toContain(upPath.status);
    expect(windowsPath.text).not.toContain('system32');
    expect(windowsPath.text).not.toContain('Windows');

    saveJson(SCENARIO, 'traversal.json', {
      payload: { status: tooLarge.status, body: tooLarge.body },
      pathParamIgnored: { status: withPathParam.status, bytes: withPathParam.bytes.byteLength, artifactSize: artifact?.sizeBytes },
      traversalArtifactId: { status: traversalArtifact.status, body: await traversalArtifact.text() },
      workspaceWindows: { status: windowsPath.status, body: windowsPath.body },
      workspaceUp: { status: upPath.status, body: upPath.body },
    });
  });

  test('S4 命令注入：URL 含 & 与引号仍按 argv 传递，运行 passed 且无额外进程', async () => {
    const markerBefore = countNodeProcessesWithMarker(DATA_DIR);
    const created = await createCase({
      name: `A10-注入-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        // `&` 之后的 name 参数决定页面文案：若 URL 被 shell 拆开，name 丢失 → 断言必然失败
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/?a=1&b=2&name=%E6%9D%8E%E5%9B%9B` },
        { id: 'st_2', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '你好，李四' },
      ],
    });
    const run = await createRun({ target: { kind: 'case', caseId: created.id } });
    const final = await waitRun(run.id);
    expect(final.status).toBe('passed');
    expect(final.stats.expected).toBe(1);
    expect(final.diagnostics.command.length).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(final.diagnostics.command)).toBe(true);
    expect(final.diagnostics.command.join(' ')).toContain('cli.js');
    // 若命令被 shell 拆分，会出现未知命令/多次启动特征；此处要求恰好一次官方 CLI 调用
    expect(final.diagnostics.command.filter((arg) => arg.endsWith('cli.js')).length).toBe(1);

    const deadline = Date.now() + 15_000;
    let markerAfter = countNodeProcessesWithMarker(DATA_DIR);
    while (Date.now() < deadline && markerAfter.length > markerBefore.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      markerAfter = countNodeProcessesWithMarker(DATA_DIR);
    }
    expect(markerAfter.length).toBeLessThanOrEqual(markerBefore.length);

    saveJson(SCENARIO, 'injection.json', {
      runId: final.id,
      status: final.status,
      command: final.diagnostics.command,
      stats: final.stats,
      nodeProcessesWithDataDir: { before: markerBefore.length, after: markerAfter.length },
      url: `${FIXTURE_BASE}/?a=1&b=2&name=李四`,
    });
  });

  test('S5 CORS 白名单：非法 Origin 无 ACAO；127.0.0.1:4173 放行', async () => {
    const evil = await fetch(`${API_BASE}/api/v1/runs`, {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(evil.status).toBe(204);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();

    const allowed = await fetch(`${API_BASE}/api/v1/runs`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:4173', 'access-control-request-method': 'GET' },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4173');

    saveJson(SCENARIO, 'cors.json', {
      evil: { status: evil.status, acao: evil.headers.get('access-control-allow-origin') },
      allowed: { status: allowed.status, acao: allowed.headers.get('access-control-allow-origin') },
    });
  });

  test('S6/S7 危险能力默认关闭；取消运行后浏览器与子进程回到基线', async () => {
    const chromeBaseline = countBrowserProcesses();

    // MCP：unsafe 工具默认关闭
    const session = unwrap<{ id: string }>(await createMcpSession({ caps: ['testing'], headless: true, isolated: true }));
    try {
      const unsafe = await callMcpTool(session.id, 'browser_run_code_unsafe', { code: 'process.exit(1)' });
      expect(unsafe.status).toBe(403);
      expect(errorCodeOf(unsafe)).toBe('CAPABILITY_DISABLED');
    } finally {
      expect((await closeMcpSession(session.id)).status).toBe(204);
    }

    // CLI：run-code 默认关闭（A8 已覆盖，此处只做 svc 级复核）
    const runCode = await http('POST', '/api/v1/cli/exec', { body: { argv: ['run-code', '1+1'], confirm: true } });
    expect(runCode.status).toBe(403);

    // S7：取消一个正在运行的慢用例 → 终态 cancelled，进程回到基线
    const slowCase = await createCase({
      name: `A10-取消-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/slow?ms=20000` },
        { id: 'st_2', action: 'expectVisible', target: { by: 'testId', testId: 'slow-done' } },
      ],
    });
    const run = await createRun({ target: { kind: 'case', caseId: slowCase.id }, options: { timeoutMs: 60_000 } });
    const running = await waitRunStatus(run.id, (current) => current.status === 'running', 60_000);
    expect(['queued', 'running']).toContain(running.status);

    const cancelResponse = await cancelRun(run.id);
    expect([200, 202]).toContain(cancelResponse.status);
    const cancelledRun = await waitRun(run.id, { timeoutMs: 60_000 });
    expect(cancelledRun.status).toBe('cancelled');
    expect(cancelledRun.cancelRequestedAt).toBeTruthy();

    const deadline = Date.now() + 30_000;
    let chromeAfter = countBrowserProcessesWithMarker(DATA_DIR);
    let markerAfter = countNodeProcessesWithMarker(DATA_DIR);
    while (Date.now() < deadline && (chromeAfter.length > 0 || markerAfter.length > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      chromeAfter = countBrowserProcessesWithMarker(DATA_DIR);
      markerAfter = countNodeProcessesWithMarker(DATA_DIR);
    }
    expect(chromeAfter).toEqual([]);
    expect(markerAfter).toEqual([]);

    saveText(
      SCENARIO,
      'process-cleanup.txt',
      [
        `chrome(global) baseline=${String(chromeBaseline)} after=${String(countBrowserProcesses())}`,
        `chrome(dataDir marker) after=${String(chromeAfter.length)}`,
        `node(dataDir) after=${String(markerAfter.length)}`,
        `cancelled run=${cancelledRun.id} status=${cancelledRun.status} cancelRequestedAt=${String(cancelledRun.cancelRequestedAt)}`,
      ].join('\n'),
    );
  });
});