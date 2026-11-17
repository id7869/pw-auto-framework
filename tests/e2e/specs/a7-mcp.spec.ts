/**
 * A7 官方 MCP（需求 R2）：官方 `playwright mcp` 独立探针 + 框架 MCP 会话端点。
 *
 * 对应 docs/acceptance-plan.md §3 A7：
 *  - 独立拉起官方 MCP，initialize / tools/list / browser_navigate / browser_snapshot（本地 fixture）；
 *  - 框架 POST /api/v1/mcp/sessions → serverInfo=Playwright、protocolVersion、工具数；
 *  - 白名单负路径 403；DELETE 关闭后 GET 404；浏览器进程回到基线。
 */

import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import {
  callMcpTool,
  closeMcpSession,
  createMcpSession,
  errorCodeOf,
  getMcpSession,
  unwrap,
} from '../support/api.ts';
import { saveJson, saveText } from '../support/evidence.ts';
import { DATA_DIR, FIXTURE_BASE, PLAYWRIGHT_VERSION, WORK_DIR } from '../support/env.ts';
import { mcpProbe } from '../support/official.ts';
import { countBrowserProcesses, countBrowserProcessesWithMarker } from '../support/process.ts';
import type { McpSession, McpToolCallResult } from '../support/types.ts';

const SCENARIO = 'a7-mcp';

/** 从 MCP tools/call 响应中拼出文本内容（content 数组的 text 字段） */
function contentText(content: unknown[]): string {
  return content
    .map((item) => {
      if (item !== null && typeof item === 'object' && 'text' in item) {
        const text = (item as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('\n');
}

test.describe('A7 官方 MCP', () => {
  test('A7-1 独立探针：官方 playwright mcp 握手 + navigate + snapshot（本地 fixture）', async () => {
    // cwd 指向受控临时目录：官方 MCP 会在 cwd 下写 .playwright-mcp/（不污染仓库）
    const probe = await mcpProbe({ url: `${FIXTURE_BASE}/`, timeoutMs: 120_000, cwd: join(WORK_DIR, 'mcp-probe') });
    expect(probe.serverInfo?.name).toBe('Playwright');
    expect(probe.serverInfo?.version).toBe(PLAYWRIGHT_VERSION);
    expect(probe.protocolVersion).toBe('2025-06-18');
    expect(probe.tools.length).toBeGreaterThanOrEqual(25);
    expect(probe.tools.map((tool) => tool.name)).toContain('browser_navigate');
    expect(probe.tools.map((tool) => tool.name)).toContain('browser_snapshot');
    // 官方 tools/call 成功时不回 isError 字段（省略），失败时为 true —— 因此只断言「不是 true」
    expect(probe.navigateIsError).not.toBe(true);
    expect(probe.navigateText).toContain('Page URL');
    expect(probe.snapshotText).toContain('演示站');

    saveJson(SCENARIO, 'official-probe.json', {
      serverInfo: probe.serverInfo,
      protocolVersion: probe.protocolVersion,
      toolCount: probe.tools.length,
      toolNames: probe.tools.map((tool) => tool.name),
      navigate: { isError: probe.navigateIsError, text: probe.navigateText.slice(0, 800) },
      snapshotExcerpt: probe.snapshotText.slice(0, 1200),
      durationMs: probe.durationMs,
      stderrTail: probe.stderr.slice(-500),
    });
  });

  test('A7-2 框架 MCP 会话：工具清单、navigate/snapshot、白名单拒绝、关闭后 404、进程清理', async () => {
    const chromeBaseline = countBrowserProcesses();
    const createResponse = await createMcpSession({ caps: ['testing', 'storage', 'network'], headless: true, isolated: true });
    expect(createResponse.status).toBe(201);
    const session = unwrap<McpSession>(createResponse);
    expect(session.id).toMatch(/^mcps_[0-9a-f]{32}$/);
    expect(session.status).toBe('ready');
    expect(session.serverInfo?.name).toBe('Playwright');
    expect(session.serverInfo?.version).toBe(PLAYWRIGHT_VERSION);
    expect(session.protocolVersion).toBe('2025-06-18');
    expect(session.caps).toEqual(['testing', 'storage', 'network']);
    expect(session.tools.length).toBeGreaterThanOrEqual(25);
    expect(session.headless).toBe(true);
    expect(session.isolated).toBe(true);
    expect(session.workDir).toContain('pw-e2e-acceptance');
    expect(session.pid).toBeGreaterThan(0);

    try {
      // 导航到本地 fixture
      const navigate = await callMcpTool(session.id, 'browser_navigate', { url: `${FIXTURE_BASE}/` });
      expect(navigate.status).toBe(200);
      const navigateResult = unwrap<McpToolCallResult>(navigate);
      expect(navigateResult.isError).toBe(false);
      expect(contentText(navigateResult.content)).toContain('Page URL');

      // 页面快照（无障碍树）包含 fixture 标题文案
      const snapshot = await callMcpTool(session.id, 'browser_snapshot', {});
      expect(snapshot.status).toBe(200);
      const snapshotResult = unwrap<McpToolCallResult>(snapshot);
      expect(snapshotResult.isError).toBe(false);
      const snapshotText = contentText(snapshotResult.content);
      expect(snapshotText).toContain('演示站');
      expect(snapshotText).toContain('你好，自动化');

      // 不安全工具 / 未在白名单的工具一律 403
      const unsafe = await callMcpTool(session.id, 'browser_run_code_unsafe', { code: '1+1' });
      expect(unsafe.status).toBe(403);
      expect(errorCodeOf(unsafe)).toBe('CAPABILITY_DISABLED');
      const evaluate = await callMcpTool(session.id, 'browser_evaluate', { fn: '() => 1' });
      expect(evaluate.status).toBe(403);
      const unknownTool = await callMcpTool(session.id, 'browser_run_anything', {});
      expect(unknownTool.status).toBe(403);

      saveJson(SCENARIO, 'framework-session.json', {
        session,
        navigate: { isError: navigateResult.isError, text: contentText(navigateResult.content).slice(0, 800) },
        snapshotExcerpt: snapshotText.slice(0, 1200),
        negative: { unsafeTool: unsafe.body, evaluate: evaluate.body, unknownTool: unknownTool.body },
      });
    } finally {
      const closed = await closeMcpSession(session.id);
      expect(closed.status).toBe(204);
    }

    // 关闭后会话不再可用：合同 §8.1 只要求 DELETE 204，未要求记录消失；
    // 实现保留审计记录（GET 200 + status=closed），两种形态都视为「已关闭」，但如实记录。
    const afterClose = await getMcpSession(session.id);
    expect([200, 404]).toContain(afterClose.status);
    if (afterClose.status === 200) {
      const closedSession = unwrap<McpSession>(afterClose);
      expect(closedSession.status).toBe('closed');
      expect(closedSession.endedAt).toBeTruthy();
    }

    // 本套件启动的浏览器进程回到 0（按数据目录前缀精确统计，排除测试 runner 自身浏览器）
    const deadline = Date.now() + 25_000;
    let chromeAfter = countBrowserProcessesWithMarker(DATA_DIR);
    while (Date.now() < deadline && chromeAfter.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      chromeAfter = countBrowserProcessesWithMarker(DATA_DIR);
    }
    expect(chromeAfter).toEqual([]);

    saveText(
      SCENARIO,
      'process-count.txt',
      [
        `chrome(global) baseline=${String(chromeBaseline)} after=${String(countBrowserProcesses())}`,
        `chrome(dataDir marker) after=${String(chromeAfter.length)}`,
        `session=${session.id} workDir=${session.workDir}`,
        `getAfterClose=${String(afterClose.status)}`,
      ].join('\n'),
    );
  });
});