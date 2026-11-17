import { describe, expect, it } from 'vitest';

import {
  createEngine,
  detectAutomationCapabilities,
  MCP_DEFAULT_ALLOWED_TOOLS,
  MCP_DEFAULT_CAPS,
} from '../index.ts';

describe('capabilities · 官方入口探测', () => {
  it('detectAutomationCapabilities：Playwright 1.65.0、MCP/CLI/Agents 可用', async () => {
    const capabilities = await detectAutomationCapabilities({ unsafeToolsEnabled: false });
    expect(capabilities.playwright.available).toBe(true);
    expect(capabilities.playwright.version).toBe('1.65.0');
    expect(capabilities.playwright.cliPath?.endsWith('cli.js')).toBe(true);
    expect(capabilities.playwright.expectedVersion).toBe('1.65.0');
    expect(capabilities.mcp.available).toBe(true);
    expect(capabilities.mcp.defaultCaps).toEqual([...MCP_DEFAULT_CAPS]);
    expect(capabilities.mcp.allowedTools).toEqual([...MCP_DEFAULT_ALLOWED_TOOLS]);
    expect(capabilities.mcp.protocolVersion).toBe('2025-06-18');
    expect(capabilities.cli.available).toBe(true);
    expect(capabilities.cli.allowedCommands).toContain('open');
    expect(capabilities.cli.allowedCommands).toContain('snapshot');
    expect(capabilities.cli.denied).toEqual(expect.arrayContaining(['install', 'install-browser', 'attach']));
    expect(capabilities.cli.unsafeEnabled).toBe(false);
    expect(capabilities.agents.available).toBe(true);
    expect(capabilities.agents.loops).toHaveLength(6);
    expect(capabilities.unsafeToolsEnabled).toBe(false);
  }, 60_000);

  it('CLI 路径不可用 → available=false + error（不抛异常）', async () => {
    const capabilities = await detectAutomationCapabilities({
      playwrightCliPath: 'C:\\no-such-dir\\playwright-cli.js',
    });
    expect(capabilities.playwright.available).toBe(false);
    expect(capabilities.playwright.cliPath).toBeNull();
    expect(capabilities.playwright.error).toBeTruthy();
    expect(capabilities.mcp.available).toBe(false);
    expect(capabilities.cli.available).toBe(false);
    expect(capabilities.agents.available).toBe(false);
  });

  it('engine.getPlaywrightInfo 与 detect 口径一致', async () => {
    const engine = createEngine();
    const info = await engine.getPlaywrightInfo?.();
    expect(info?.available).toBe(true);
    expect(info?.version).toBe('1.65.0');
    await engine.shutdown?.();
  }, 60_000);
});