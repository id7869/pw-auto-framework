import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AutomationError, createAgentsAdapter, type AgentsAdapter } from '../index.ts';
import { removeDirWithRetry } from './helpers/fs-cleanup.ts';

describe('agents/官方 init-agents 脚手架 · 离线集成', () => {
  let agentsRoot: string;
  let adapter: AgentsAdapter;

  beforeAll(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), 'pw-auto-agents-'));
    adapter = createAgentsAdapter({ agentsRoot });
  });

  afterAll(async () => {
    await removeDirWithRetry(agentsRoot);
  });

  it('6 种官方 loop', () => {
    const loops = adapter.listLoops();
    expect(loops.map((item) => item.loop)).toEqual([
      'claude',
      'codex',
      'copilot',
      'opencode',
      'vscode',
      'vscode-legacy',
    ]);
    expect(loops.every((item) => item.description.length > 0)).toBe(true);
  });

  it('claude --prompts：completed、files/sha256/missing、官方 prompts', async () => {
    const result = await adapter.scaffold({ scaffoldId: 'scf_claude', loop: 'claude', prompts: true });
    expect(result.status).toBe('completed');
    expect(result.error).toBeNull();
    expect(result.missing).toEqual([]);
    expect(result.targetDir).toBe(join(agentsRoot, 'scf_claude'));
    expect(result.command.slice(0, 3).map((arg) => arg.split(/[\\/]/).pop())).toEqual([
      'node.exe',
      'cli.js',
      'init-agents',
    ]);
    expect(result.command).toContain('--loop');
    expect(result.command).toContain('claude');
    expect(result.command).toContain('--prompts');

    const paths = result.files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'seed.spec.ts',
        'specs/README.md',
        '.mcp.json',
        '.claude/agents/playwright-test-planner.md',
        '.claude/agents/playwright-test-generator.md',
        '.claude/agents/playwright-test-healer.md',
        '.claude/prompts/playwright-test-plan.md',
        '.claude/prompts/playwright-test-generate.md',
        '.claude/prompts/playwright-test-heal.md',
        '.claude/prompts/playwright-test-coverage.md',
      ]),
    );
    for (const file of result.files) {
      expect(file.sizeBytes).toBeGreaterThan(0);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(result.promptTemplates.map((prompt) => prompt.key)).toEqual([
      'plan',
      'generate',
      'heal',
      'coverage',
    ]);
    expect(result.promptTemplates.every((prompt) => prompt.source === 'official')).toBe(true);
    expect(result.promptTemplates.every((prompt) => prompt.body.length > 0)).toBe(true);

    const workspace = await adapter.listWorkspace({ scaffoldId: 'scf_claude', path: 'specs' });
    expect(workspace.map((entry) => entry.path)).toEqual(['specs/README.md']);
  }, 120_000);

  it('opencode 无 --prompts：missing 为空且无官方提示词（回退框架模板）', async () => {
    const result = await adapter.scaffold({ scaffoldId: 'scf_opencode', loop: 'opencode', prompts: false });
    expect(result.status).toBe('completed');
    expect(result.missing).toEqual([]);
    expect(result.promptTemplates).toEqual([]);
    const paths = result.files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'opencode.json',
        '.opencode/prompts/playwright-test-planner.md',
        '.opencode/prompts/playwright-test-generator.md',
        '.opencode/prompts/playwright-test-healer.md',
      ]),
    );
    const prompts = await adapter.getPrompts({ scaffoldId: 'scf_opencode' });
    expect(prompts.map((prompt) => prompt.key)).toEqual(['plan', 'generate', 'heal', 'coverage']);
    expect(prompts.every((prompt) => prompt.source === 'framework')).toBe(true);
  }, 120_000);

  it('vscode-legacy --prompts：官方不产出提示词，warnings 明示（missing 仍为空）', async () => {
    const result = await adapter.scaffold({ scaffoldId: 'scf_legacy', loop: 'vscode-legacy', prompts: true });
    expect(result.status).toBe('completed');
    expect(result.missing).toEqual([]);
    expect(result.promptTemplates).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('未生成提示词'))).toBe(true);
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain('.github/chatmodes/ 🎭 planner.chatmode.md');
    expect(paths).toContain('.github/chatmodes/🎭 generator.chatmode.md');
  }, 120_000);

  it('路径防护：scaffoldId 穿越 → INVALID_PATH；workspace 越界 → PATH_FORBIDDEN', async () => {
    let caught: unknown;
    try {
      await adapter.scaffold({ scaffoldId: '../evil', loop: 'claude' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AutomationError);
    expect((caught as AutomationError).code).toBe('INVALID_PATH');

    await expect(adapter.listWorkspace({ scaffoldId: 'scf_claude', path: '../../' })).rejects.toMatchObject({
      code: 'PATH_FORBIDDEN',
    });
    await expect(adapter.listWorkspace({ scaffoldId: 'scf_claude', path: 'C:\\Windows' })).rejects.toMatchObject({
      code: 'PATH_FORBIDDEN',
    });
    await expect(adapter.listWorkspace({ scaffoldId: 'scf_claude', path: '不存在目录' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('官方入口不可用 → NOT_IMPLEMENTED；loop 非法 → VALIDATION_FAILED', async () => {
    const unavailable = createAgentsAdapter({ agentsRoot, playwrightCliPath: 'C:\\no-such-dir\\cli.js' });
    await expect(
      unavailable.scaffold({ scaffoldId: 'scf_x', loop: 'claude' }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(
      adapter.scaffold({ scaffoldId: 'scf_y', loop: 'not-a-loop' as never }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('getPrompts 无 scaffoldId → 框架模板（source=framework）', async () => {
    const prompts = await adapter.getPrompts();
    expect(prompts.map((prompt) => prompt.key)).toEqual(['plan', 'generate', 'heal', 'coverage']);
    expect(prompts.every((prompt) => prompt.source === 'framework')).toBe(true);
    expect(prompts.every((prompt) => !/已生成|已修复/.test(prompt.body))).toBe(true);
  });
});