import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MCP_CAPS,
  MCP_TOOL_WHITELIST,
  MCP_UNSAFE_TOOL_NAMES,
} from '@pw-auto/contracts';

import {
  AutomationError,
  createMcpAdapter,
  isProcessAlive,
  isUnsafeMcpTool,
  MCP_DEFAULT_CAPS,
  MCP_DEFAULT_ALLOWED_TOOLS,
  MCP_PROTOCOL_VERSION,
  MCP_UNSAFE_TOOLS,
  type McpAdapter,
  type McpSessionInfo,
} from '../index.ts';
import { removeDirWithRetry } from './helpers/fs-cleanup.ts';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server.ts';

describe('mcp/官方 MCP 服务 · 离线集成', () => {
  let server: FixtureServer;
  let adapter: McpAdapter;
  let workDir: string;
  let session: McpSessionInfo;

  beforeAll(async () => {
    server = await startFixtureServer();
    workDir = mkdtempSync(join(tmpdir(), 'pw-auto-mcp-'));
    adapter = createMcpAdapter({
      allowedWorkDirRoots: [workDir],
      startupTimeoutMs: 60_000,
      unsafeToolsEnabled: true,
    });
    session = await adapter.createSession({ headless: true, isolated: true, workDir });
  }, 120_000);

  afterAll(async () => {
    await adapter?.closeAll();
    await server?.close();
    if (workDir !== undefined) await removeDirWithRetry(workDir);
  });

  it('initialize/listTools：serverInfo=Playwright 1.65.0、协议 2025-06-18、默认 caps、工具 ≥25', () => {
    expect(session.status).toBe('ready');
    expect(session.serverInfo).toEqual({ name: 'Playwright', version: '1.65.0' });
    expect(session.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(session.caps).toEqual([...MCP_DEFAULT_CAPS]);
    expect(session.tools.length).toBeGreaterThanOrEqual(25);
    expect(session.tools.map((tool) => tool.name)).toContain('browser_navigate');
    expect(session.tools.map((tool) => tool.name)).toContain('browser_snapshot');
    expect(session.headless).toBe(true);
    expect(session.isolated).toBe(true);
    expect(session.pid).toBeGreaterThan(0);
    expect(session.workDir).toBe(workDir);
    expect(session.error).toBeNull();
    expect(adapter.getSession(session.id).id).toBe(session.id);
    expect(adapter.listSessions().some((item) => item.id === session.id)).toBe(true);
  });

  it('callTool：browser_navigate + browser_snapshot 返回官方工具结果', async () => {
    const navigate = await adapter.callTool(session.id, 'browser_navigate', {
      url: `http://127.0.0.1:${server.port}/`,
    });
    expect(navigate.isError).toBe(false);
    expect(navigate.content.length).toBeGreaterThan(0);
    expect(navigate.durationMs).toBeGreaterThanOrEqual(0);

    const snapshot = await adapter.callTool(session.id, 'browser_snapshot', {});
    expect(snapshot.isError).toBe(false);
    const text = JSON.stringify(snapshot.content);
    expect(text).toContain('演示站');
  }, 120_000);

  it('白名单/未知工具/unsafe 二次确认：未授权一律 CAPABILITY_DISABLED', async () => {
    // 暴露在 tools/list 但不在合同默认白名单内。
    expect(session.tools.map((tool) => tool.name)).toContain('browser_cookie_list');
    await expect(adapter.callTool(session.id, 'browser_cookie_list', {})).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
    });
    await expect(adapter.callTool(session.id, 'browser_not_exists', {})).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
    });
    await expect(adapter.callTool(session.id, 'browser_evaluate', { function: '() => 1 + 1' })).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
    });
    expect(MCP_DEFAULT_ALLOWED_TOOLS).not.toContain('browser_evaluate');
  });

  it('unsafe 工具：开关开启 + confirm:true 才可执行', async () => {
    const result = await adapter.callTool(
      session.id,
      'browser_evaluate',
      { function: '() => 1 + 1' },
      { confirm: true },
    );
    expect(result.isError).toBe(false);
    expect(result.content.length).toBeGreaterThan(0);
  }, 60_000);

  it('contracts↔automation unsafe/白名单/caps 常量完全一致（精确集合，含 down/up/wheel）', () => {
    expect([...MCP_UNSAFE_TOOLS]).toEqual([...MCP_UNSAFE_TOOL_NAMES]);
    expect(MCP_UNSAFE_TOOLS).toHaveLength(8);
    expect([...MCP_DEFAULT_ALLOWED_TOOLS]).toEqual([...MCP_TOOL_WHITELIST]);
    expect([...MCP_DEFAULT_CAPS]).toEqual([...DEFAULT_MCP_CAPS]);
    expect(MCP_UNSAFE_TOOL_NAMES).toEqual(
      expect.arrayContaining(['browser_mouse_down', 'browser_mouse_up', 'browser_mouse_wheel']),
    );
    for (const toolName of MCP_UNSAFE_TOOL_NAMES) {
      expect(isUnsafeMcpTool(toolName)).toBe(true);
    }
    // 不按前缀/正则猜测：形似名一律不是 unsafe（后续由白名单/未知工具拒绝）。
    for (const lookalike of [
      'browser_mouse_move',
      'browser_mouse_fly_xy',
      'browser_mouse_move_xy_v2',
      'browser_run_code_safe',
      'browser_evaluate_extra',
    ]) {
      expect(isUnsafeMcpTool(lookalike)).toBe(false);
    }
  });

  it('vision 会话：8 个 unsafe 暴露；未 confirm 一律拒绝；confirm 后可执行；形似名拒绝', async () => {
    const vision = await adapter.createSession({
      headless: true,
      isolated: true,
      workDir,
      caps: [...MCP_DEFAULT_CAPS, 'vision'],
    });
    try {
      expect(vision.caps).toContain('vision');
      const toolNames = vision.tools.map((tool) => tool.name);
      for (const unsafeName of MCP_UNSAFE_TOOL_NAMES) {
        expect(toolNames).toContain(unsafeName);
      }
      expect(vision.tools.length).toBeGreaterThan(session.tools.length);

      // unsafe 精确集合：未 confirm 时全部拒绝（gate 发生在调用前，不依赖参数）。
      for (const unsafeName of MCP_UNSAFE_TOOL_NAMES) {
        await expect(adapter.callTool(vision.id, unsafeName, {})).rejects.toMatchObject({
          code: 'CAPABILITY_DISABLED',
        });
      }
      // 形似 unsafe 但不在官方 tools/list：拒绝，不按前缀放行。
      await expect(adapter.callTool(vision.id, 'browser_mouse_fly_xy', { x: 1, y: 1 })).rejects.toMatchObject({
        code: 'CAPABILITY_DISABLED',
      });

      // confirm:true + 开关开启 → 真实执行 vision 工具。
      const navigate = await adapter.callTool(vision.id, 'browser_navigate', {
        url: `http://127.0.0.1:${server.port}/`,
      });
      expect(navigate.isError).toBe(false);
      const moved = await adapter.callTool(
        vision.id,
        'browser_mouse_move_xy',
        { x: 10, y: 10 },
        { confirm: true },
      );
      expect(moved.isError).toBe(false);

      // 开关关闭（即使 confirm:true）→ 一律拒绝。
      const noUnsafe = createMcpAdapter({
        allowedWorkDirRoots: [workDir],
        startupTimeoutMs: 60_000,
        unsafeToolsEnabled: false,
      });
      const blocked = await noUnsafe.createSession({
        headless: true,
        isolated: true,
        workDir,
        caps: [...MCP_DEFAULT_CAPS, 'vision'],
      });
      try {
        await expect(
          noUnsafe.callTool(blocked.id, 'browser_mouse_move_xy', { x: 1, y: 1 }, { confirm: true }),
        ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
        await expect(
          noUnsafe.callTool(blocked.id, 'browser_evaluate', { function: '() => 1' }, { confirm: true }),
        ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
      } finally {
        await noUnsafe.closeAll();
      }
    } finally {
      await adapter.closeSession(vision.id);
    }
  }, 180_000);

  it('closeSession：强杀进程树，会话状态可诊断', async () => {
    const pid = session.pid as number;
    const closed = await adapter.closeSession(session.id);
    expect(closed.status).toBe('closed');
    expect(closed.endedAt).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isProcessAlive(pid)).toBe(false);
    expect(adapter.getSession(session.id).status).toBe('closed');
    // 已关闭会话继续调用 → SESSION_NOT_READY
    await expect(adapter.callTool(session.id, 'browser_snapshot', {})).rejects.toMatchObject({
      code: 'SESSION_NOT_READY',
    });
  }, 60_000);

  it('官方入口不可用 → NOT_IMPLEMENTED（不伪造工具清单）', async () => {
    const unavailable = createMcpAdapter({ playwrightCliPath: 'C:\\no-such-dir\\playwright-cli.js' });
    let caught: unknown;
    try {
      await unavailable.createSession({ workDir });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AutomationError);
    expect((caught as AutomationError).code).toBe('NOT_IMPLEMENTED');
  });
});