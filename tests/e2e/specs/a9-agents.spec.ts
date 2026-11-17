/**
 * A9 Agent 交接（R2/R7）：三 harness 入口 + 官方 `init-agents` 脚手架 + 路径防护 + 不调用模型。
 *
 * 对应 docs/acceptance-plan.md §3 A9 与 §3.1 N0（R7）：
 *  - GET /agents/harnesses 恰 3 项（claude/codex/deepseek；deepseek.officialLoop=null、requiresMcp=false、skillPaths）；
 *  - /agents/loops 已移除：任意方法 → 404 NOT_FOUND；
 *  - POST /agents/scaffolds：只接受 entry=claude|codex|deepseek；缺失/非三值/旧 loop → 422 HARNESS_NOT_SUPPORTED；
 *  - deepseek 不执行 init-agents（command=[]、loop=null、4 个 prompt 模板）；
 *  - claude/codex 真实执行官方 init-agents，产物索引完整、missing=[]；
 *  - 缺 confirm → 428；幂等重放；workspace 越界拒绝；无模型端点/密钥；
 *  - 另在独立临时工作区直接跑一次官方 init-agents，交叉核对产物清单。
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  createScaffold,
  errorCodeOf,
  getAgentPrompts,
  getAgentWorkspace,
  getHarnesses,
  http,
  unwrap,
} from '../support/api.ts';
import { saveJson, saveText } from '../support/evidence.ts';
import { PLAYWRIGHT_VERSION, REPO_ROOT, WORK_DIR } from '../support/env.ts';
import { initAgentsDirect } from '../support/official.ts';
import type { HarnessInfo, Scaffold } from '../support/types.ts';

const SCENARIO = 'a9-agents';

const EXPECTED_AGENT_FILES = [
  '.claude/agents/playwright-test-planner.md',
  '.claude/agents/playwright-test-generator.md',
  '.claude/agents/playwright-test-healer.md',
  'seed.spec.ts',
  'specs/README.md',
];

const EXPECTED_CODEX_FILES = [
  '.codex/agents/playwright_test_planner.toml',
  '.codex/agents/playwright_test_generator.toml',
  '.codex/agents/playwright_test_healer.toml',
  'seed.spec.ts',
  'specs/README.md',
];

function cleanupScaffold(scaffold: Scaffold): void {
  const scaffoldRoot = scaffold.targetDir;
  if (relative(join(REPO_ROOT, 'agents'), scaffoldRoot).startsWith('..') === false) {
    rmSync(scaffoldRoot, { recursive: true, force: true });
  }
}

test.describe('A9 Agent 交接（三 harness + 官方 init-agents）', () => {
  test('A9-1 三入口与脚手架：harnesses=3、loops 任意方法 404、entry 校验、deepseek 不执行 init-agents', async () => {
    // 1) 三 harness 入口（R7）
    const harnesses = await getHarnesses();
    expect(harnesses.status).toBe(200);
    const harnessItems = unwrap<{ items: HarnessInfo[] }>(harnesses).items;
    expect(harnessItems.map((item) => item.entry)).toEqual(['claude', 'codex', 'deepseek']);
    for (const item of harnessItems) {
      expect(item.requiresMcp).toBe(false);
      expect(item.skillPaths.length).toBeGreaterThanOrEqual(1);
      expect(item).not.toHaveProperty('installed');
      expect(item).not.toHaveProperty('installTargets');
    }
    expect(harnessItems.find((item) => item.entry === 'deepseek')?.officialLoop).toBeNull();
    expect(harnessItems.find((item) => item.entry === 'claude')?.officialLoop).toBe('claude');
    expect(harnessItems.find((item) => item.entry === 'codex')?.officialLoop).toBe('codex');

    // 2) /agents/loops 已移除：任意方法 → 404 NOT_FOUND（不得含 6 loop/旧入口）
    const loopProbes = [
      await http('GET', '/api/v1/agents/loops'),
      await http('POST', '/api/v1/agents/loops', { body: {} }),
      await http('PUT', '/api/v1/agents/loops', { body: {} }),
      await http('DELETE', '/api/v1/agents/loops'),
    ];
    for (const probe of loopProbes) {
      expect(probe.status).toBe(404);
      expect(errorCodeOf(probe)).toBe('NOT_FOUND');
    }
    const loopBodies = JSON.stringify(loopProbes.map((probe) => probe.body));
    for (const legacy of ['copilot', 'opencode', 'vscode', 'vscode-legacy']) {
      expect(loopBodies).not.toContain(legacy);
    }

    // 3) 缺 confirm → 428
    const noConfirm = await createScaffold({ entry: 'claude', prompts: true });
    expect(noConfirm.status).toBe(428);
    expect(errorCodeOf(noConfirm)).toBe('CONFIRM_REQUIRED');

    // 4) 非三 entry / 缺失 entry / 旧 loop → 422 HARNESS_NOT_SUPPORTED
    const legacyEntry = await createScaffold({ entry: 'copilot', confirm: true });
    expect(legacyEntry.status).toBe(422);
    expect(errorCodeOf(legacyEntry)).toBe('HARNESS_NOT_SUPPORTED');
    const missingEntry = await createScaffold({ prompts: true, confirm: true });
    expect(missingEntry.status).toBe(422);
    expect(errorCodeOf(missingEntry)).toBe('HARNESS_NOT_SUPPORTED');
    const legacyLoop = await createScaffold({ loop: 'claude', confirm: true });
    expect(legacyLoop.status).toBe(422);
    expect(errorCodeOf(legacyLoop)).toBe('HARNESS_NOT_SUPPORTED');

    // 5) claude：真实官方 init-agents → 201 completed
    const idempotencyKey = `scaffold-e2e-${String(Date.now())}`;
    const created = await createScaffold({ entry: 'claude', prompts: true, confirm: true }, idempotencyKey);
    expect(created.status).toBe(201);
    expect(created.headers.get('idempotency-key')).toBe(idempotencyKey);
    const scaffold = unwrap<Scaffold>(created);
    expect(scaffold.id).toMatch(/^scf_[0-9a-f]{32}$/);
    expect(scaffold.entry).toBe('claude');
    expect(scaffold.loop).toBe('claude');
    expect(scaffold.officialLoop).toBe('claude');
    expect(scaffold.prompts).toBe(true);
    expect(scaffold.status).toBe('completed');
    expect(scaffold.error).toBeNull();
    expect(scaffold.targetDir.startsWith(join(REPO_ROOT, 'agents'))).toBe(true);
    expect(existsSync(scaffold.targetDir)).toBe(true);

    const filePaths = scaffold.files.map((file) => file.path);
    for (const expectedPath of EXPECTED_AGENT_FILES) expect(filePaths).toContain(expectedPath);
    expect(filePaths).toContain('.mcp.json');
    expect(scaffold.missing).toEqual([]);
    for (const file of scaffold.files) {
      expect(file.sizeBytes).toBeGreaterThan(0);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // 6) command 回显官方 init-agents argv（无模型调用）
    expect(scaffold.command.length).toBeGreaterThanOrEqual(4);
    expect(scaffold.command).toContain('init-agents');
    expect(scaffold.command).toContain('--loop');
    expect(scaffold.command).toContain('claude');
    expect(scaffold.command).toContain('--prompts');
    expect(scaffold.command[0]).toMatch(/node\.exe|node$/);
    expect(scaffold.command.some((arg) => arg.includes('@playwright') && arg.includes('cli.js'))).toBe(true);

    const scaffoldJson = JSON.stringify(scaffold);
    expect(scaffoldJson).not.toMatch(/api\.openai\.com|api\.anthropic\.com|ANTHROPIC_API_KEY|OPENAI_API_KEY/i);
    expect(scaffoldJson).not.toMatch(/sk-[A-Za-z0-9]{8,}/);

    // 7) codex：真实官方 init-agents（loop=codex）
    const codex = unwrap<Scaffold>(await createScaffold({ entry: 'codex', confirm: true }));
    expect(codex.status).toBe('completed');
    expect(codex.entry).toBe('codex');
    expect(codex.officialLoop).toBe('codex');
    expect(codex.loop).toBe('codex');
    expect(codex.missing).toEqual([]);
    for (const expectedPath of EXPECTED_CODEX_FILES) expect(codex.files.map((file) => file.path)).toContain(expectedPath);
    expect(codex.command).toContain('codex');

    // 8) deepseek：不执行 init-agents；写入 4 个 prompts 模板
    const deepseek = unwrap<Scaffold>(await createScaffold({ entry: 'deepseek', prompts: true, confirm: true }));
    expect(deepseek.status).toBe('completed');
    expect(deepseek.entry).toBe('deepseek');
    expect(deepseek.loop).toBeNull();
    expect(deepseek.officialLoop).toBeNull();
    expect(deepseek.command).toEqual([]);
    expect(deepseek.missing).toEqual([]);
    expect(deepseek.notes).toBeTruthy();
    const deepseekPrompts = deepseek.files.filter((file) => file.path.startsWith('prompts/'));
    expect(deepseekPrompts.map((file) => file.path).sort()).toEqual([
      'prompts/coverage.md',
      'prompts/generate.md',
      'prompts/heal.md',
      'prompts/plan.md',
    ]);
    for (const file of deepseekPrompts) expect(file.sizeBytes).toBeGreaterThan(0);

    // 9) 官方 --prompts 产物 → source=official（claude 脚手架已带 --prompts）
    const prompts = await getAgentPrompts();
    expect(prompts.status).toBe(200);
    const promptItems = unwrap<{ items: { key: string; title: string; body: string; source: string }[] }>(prompts).items;
    for (const expectedKey of ['plan', 'generate', 'heal']) expect(promptItems.map((item) => item.key)).toContain(expectedKey);
    expect(promptItems.filter((item) => item.source === 'official').length).toBeGreaterThanOrEqual(3);

    // 10) 受控目录浏览：specs/ 可读；越界拒绝
    const specsDir = await getAgentWorkspace(
      `?path=${encodeURIComponent('specs/')}&scaffoldId=${encodeURIComponent(scaffold.id)}`,
    );
    expect(specsDir.status).toBe(200);
    const specsEntries = unwrap<{ items: { path: string }[] }>(specsDir).items;
    expect(specsEntries.map((entry) => entry.path)).toContain('specs/README.md');

    const traversal = await getAgentWorkspace(
      `?path=${encodeURIComponent('../../')}&scaffoldId=${encodeURIComponent(scaffold.id)}`,
    );
    expect([400, 403]).toContain(traversal.status);
    expect(['INVALID_PATH', 'PATH_FORBIDDEN']).toContain(errorCodeOf(traversal));
    expect(traversal.text).not.toContain('pw-auto-framework');

    const absolutePath = await getAgentWorkspace(
      `?path=${encodeURIComponent('C:\\Windows')}&scaffoldId=${encodeURIComponent(scaffold.id)}`,
    );
    expect([400, 403]).toContain(absolutePath.status);

    // 11) 幂等重放
    const replay = await createScaffold({ entry: 'claude', prompts: true, confirm: true }, idempotencyKey);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(unwrap<Scaffold>(replay).id).toBe(scaffold.id);
    const differentBody = await createScaffold({ entry: 'claude', prompts: false, confirm: true }, idempotencyKey);
    expect(differentBody.status).toBe(409);
    expect(errorCodeOf(differentBody)).toBe('IDEMPOTENCY_CONFLICT');

    // 12) 官方产物内容片段（证明非框架伪造）
    const seed = readFileSync(join(scaffold.targetDir, 'seed.spec.ts'), 'utf8');
    const planner = readFileSync(join(scaffold.targetDir, '.claude/agents/playwright-test-planner.md'), 'utf8');
    expect(seed).toContain('@playwright/test');
    expect(planner.toLowerCase()).toContain('planner');

    saveJson(SCENARIO, 'scaffold.json', scaffold);
    saveJson(SCENARIO, 'harnesses.json', harnessItems);
    saveJson(SCENARIO, 'loops-404.json', loopProbes.map((probe) => ({ status: probe.status, body: probe.body })));
    saveJson(SCENARIO, 'scaffold-deepseek.json', deepseek);
    saveJson(SCENARIO, 'scaffold-codex.json', codex);
    saveJson(SCENARIO, 'prompts.json', promptItems.map((item) => ({ key: item.key, source: item.source, title: item.title })));
    saveJson(SCENARIO, 'workspace-specs.json', specsEntries);
    saveJson(SCENARIO, 'negative.json', {
      confirm: noConfirm.body,
      legacyEntry: legacyEntry.body,
      missingEntry: missingEntry.body,
      legacyLoop: legacyLoop.body,
      traversal: { status: traversal.status, body: traversal.body },
      absolutePath: { status: absolutePath.status, body: absolutePath.body },
      idempotencyConflict: differentBody.body,
    });
    saveText(SCENARIO, 'seed.spec.ts', seed);
    saveText(SCENARIO, 'planner.md', planner);

    cleanupScaffold(scaffold);
    cleanupScaffold(codex);
    cleanupScaffold(deepseek);
  });

  test('A9-2 独立官方 init-agents（临时工作区）：planner/generator/healer + seed 产物齐备', async () => {
    const cwd = join(WORK_DIR, `init-agents-${String(Date.now())}`);
    const result = await initAgentsDirect(cwd, 'claude', true);
    expect(result.exitCode).toBe(0);

    const files = readdirSync(cwd, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(cwd, join(entry.parentPath, entry.name)).split('\\').join('/'))
      .sort();

    for (const expectedPath of EXPECTED_AGENT_FILES) expect(files).toContain(expectedPath);
    expect(files).toContain('.mcp.json');

    const mcpConfig = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    const serverEntries = Object.values(mcpConfig.mcpServers ?? {});
    expect(serverEntries.length).toBeGreaterThanOrEqual(1);
    const playwrightEntry = serverEntries.find((entry) => (entry.args ?? []).some((arg) => arg.includes('run-test-mcp-server')));
    expect(playwrightEntry).toBeDefined();

    saveJson(SCENARIO, 'official-init-agents.json', {
      cwd,
      command: result.command,
      exitCode: result.exitCode,
      files,
      mcpServers: mcpConfig.mcpServers,
      stdoutTail: result.stdout.slice(-800),
    });

    rmSync(cwd, { recursive: true, force: true });

    // @playwright/test 仍是唯一官方承重依赖
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
    expect(pkg.devDependencies?.['@playwright/test']).toBe(PLAYWRIGHT_VERSION);
  });
});
