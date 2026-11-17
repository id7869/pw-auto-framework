/**
 * A17 通用 skill 与官方入口安全（R7；N5/N6/N8）。
 *
 * 覆盖：
 *  - 静态包完整性（SKILL.md/references/scripts/templates；无安装器/manifest/安装记录）；
 *  - 3 个脚本 `node --check` 通过；全仓代码 grep 无模型端点/密钥/安装器；
 *  - verify.mjs 只读自检（exit 0；运行前后 skills 文件列表与 mtime 不变）；
 *  - agent-loop.mjs 确定性模拟 agent：full（NL→claim→MCP→submit→accept→validate→run passed）与 data（逐行）；
 *  - 确定性 heal 路径：失败 errorHash → 新 generation → accept → 重跑 passed；
 *  - /skills* 全部 404；/agents/loops 任意方法 404；无安装状态；CLI unsafe 仍拒绝；bindHost=127.0.0.1。
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  acceptNlGeneration,
  createCase,
  claimNlGeneration,
  errorCodeOf,
  getHarnesses,
  getMeta,
  http,
  listRunItems,
  startRun,
  submitNlGeneration,
  unwrap,
  waitRun,
} from '../support/api.ts';
import { saveJson, saveText } from '../support/evidence.ts';
import { API_BASE, FIXTURE_BASE, REPO_ROOT, WORK_DIR } from '../support/env.ts';
import { createGeneration, readCase } from '../support/nl-agent.ts';
import { runProcess } from '../support/process.ts';
import type { CaseStep, HarnessInfo, NlGeneration, RunItem } from '../support/types.ts';

const SCENARIO = 'a17-skill-harness';
const SKILL_DIR = join(REPO_ROOT, 'skills', 'pw-auto-test');
const SKILLS_ROOT = join(REPO_ROOT, 'skills');

interface FileStamp {
  path: string;
  size: number;
  mtimeMs: number;
}

function snapshotTree(root: string): FileStamp[] {
  const acc: FileStamp[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = statSync(full);
      acc.push({ path: relative(root, full).split('\\').join('/'), size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(root);
  return acc.sort((a, b) => a.path.localeCompare(b.path));
}

function treeDigest(files: readonly FileStamp[]): string {
  return createHash('sha256')
    .update(files.map((file) => `${file.path}:${String(file.size)}:${String(file.mtimeMs)}`).join('\n'))
    .digest('hex');
}

function scanHits(
  roots: readonly string[],
  patterns: readonly RegExp[],
  skipTests = true,
): { pattern: string; file: string; line: string }[] {
  const hits: { pattern: string; file: string; line: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        if (skipTests && (entry.name === '__tests__' || entry.name === 'test')) continue;
        walk(full);
        continue;
      }
      if (skipTests && /\.test\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
      if (!/\.(ts|tsx|mjs|js|json|md)$/.test(entry.name)) continue;
      const text = readFileSync(full, 'utf8');
      for (const pattern of patterns) {
        const match = text.match(new RegExp(pattern.source, pattern.flags.includes('m') ? pattern.flags : `${pattern.flags}m`));
        if (match === null) continue;
        const matchedLine = text.slice(0, match.index ?? 0).split(/\r?\n/).at(-1) ?? '';
        hits.push({ pattern: String(pattern), file: relative(REPO_ROOT, full), line: matchedLine.trim().slice(0, 240) });
      }
    }
  };
  for (const root of roots) walk(root);
  return hits;
}

function jsonFromOutput(stdout: string): unknown {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`未找到 JSON 输出：${stdout.slice(0, 300)}`);
  return JSON.parse(stdout.slice(start));
}

test.describe('A17 通用 skill 与官方入口安全', () => {
  test('A17-1 静态包完整性 + 脚本 --check + 无模型/密钥/安装器', async () => {
    // 1) 必备文件
    for (const rel of [
      'SKILL.md',
      'references/nl-to-case.md',
      'references/api-cheatsheet.md',
      'references/data-driven.md',
      'references/agent-handoff.md',
      'references/troubleshooting.md',
      'references/harness-matrix.md',
      'scripts/api.mjs',
      'scripts/verify.mjs',
      'scripts/agent-loop.mjs',
      'templates/plan.md',
      'templates/generate.md',
      'templates/heal.md',
      'templates/coverage.md',
      'templates/seed.spec.ts',
    ]) {
      expect(existsSync(join(SKILL_DIR, rel)), `缺少 ${rel}`).toBe(true);
    }
    const skillMd = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
    expect(skillMd).toMatch(/name:\s*pw-auto-test/);
    expect(skillMd).toMatch(/playwrightVersion:\s*"?1\.65\.0"?/);
    expect(skillMd).toMatch(/不调用任何模型/);

    // 2) 无安装器/安装记录
    const allSkills = readdirSync(SKILLS_ROOT, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(SKILLS_ROOT, join(entry.parentPath, entry.name)));
    for (const forbidden of ['install.mjs', '.pw-auto-skill.json', 'manifest.json']) {
      expect(allSkills.some((file) => file.endsWith(forbidden))).toBe(false);
    }

    // 3) node --check
    const checkResults: Record<string, number | null> = {};
    for (const script of ['api.mjs', 'verify.mjs', 'agent-loop.mjs']) {
      const result = await runProcess(process.execPath, ['--check', join(SKILL_DIR, 'scripts', script)], {
        cwd: REPO_ROOT,
        timeoutMs: 30_000,
      });
      checkResults[script] = result.exitCode;
      expect(result.exitCode, `${script} --check 失败：${result.stderr}`).toBe(0);
    }

    // 4) 代码目录 grep：无模型端点/SDK 密钥/安装 API/安装表
    const patterns = [
      /api\.openai\.com/i,
      /api\.anthropic\.com/i,
      /api\.deepseek\.com/i,
      /OPENAI_API_KEY/,
      /ANTHROPIC_API_KEY/,
      /DEEPSEEK_API_KEY/,
      /\/skills\/install/,
      /skill_installations/,
      /install\.mjs/,
      /from ['"]openai['"]/,
      /from ['"]@anthropic-ai\//,
    ];
    const hits = scanHits([join(REPO_ROOT, 'apps'), join(REPO_ROOT, 'packages'), SKILLS_ROOT], patterns);
    // 产品代码（apps/packages）必须零命中（测试代码中的负向断言已按 skipTests 排除）
    const productHits = hits.filter((hit) => !hit.file.startsWith('skills'));
    expect(productHits, `产品代码发现疑似模型/安装器引用：${JSON.stringify(productHits)}`).toEqual([]);
    // skill 文档/脚本允许「不存在/禁止」的负向提及（如 verify.mjs 的 forbidden 列表），但必须是否定语境
    const skillInstallHits = hits.filter((hit) => hit.file.startsWith('skills') && hit.pattern.includes('install'));
    for (const hit of skillInstallHits) expect(hit.line).toMatch(/无|不|禁止|不存在|forbidden|没有|不得/);
    const skillModelHits = hits.filter((hit) => hit.file.startsWith('skills') && !hit.pattern.includes('install'));
    expect(skillModelHits, `skill 中发现模型引用：${JSON.stringify(skillModelHits)}`).toEqual([]);

    // 5) 无安装 API：/skills* 全部 404
    const probes = [
      await http('GET', '/api/v1/skills'),
      await http('POST', '/api/v1/skills/install', { body: { skill: 'pw-auto-test' } }),
      await http('GET', '/api/v1/skills/pw-auto-test'),
      await http('DELETE', '/api/v1/skills/pw-auto-test'),
    ];
    for (const probe of probes) {
      expect(probe.status).toBe(404);
      expect(errorCodeOf(probe)).toBe('NOT_FOUND');
    }

    // 6) harnesses 无 installed/installTargets；/agents/loops 任意方法 404（唯一入口 harnesses）
    const harnessItems = unwrap<{ items: HarnessInfo[] }>(await getHarnesses()).items;
    expect(harnessItems.map((item) => item.entry)).toEqual(['claude', 'codex', 'deepseek']);
    for (const item of harnessItems) {
      expect(item.requiresMcp).toBe(false);
      expect(item).not.toHaveProperty('installed');
      expect(item).not.toHaveProperty('installTargets');
    }
    const loopsProbes = [
      await http('GET', '/api/v1/agents/loops'),
      await http('POST', '/api/v1/agents/loops', { body: {} }),
      await http('DELETE', '/api/v1/agents/loops'),
    ];
    for (const probe of loopsProbes) {
      expect(probe.status).toBe(404);
      expect(errorCodeOf(probe)).toBe('NOT_FOUND');
    }
    expect(JSON.stringify(loopsProbes.map((probe) => probe.body))).not.toContain('copilot');

    // 7) CLI unsafe 仍拒绝；meta.bindHost 本地
    const cliCommands = await http('GET', '/api/v1/cli/commands');
    expect(cliCommands.status).toBe(200);
    const commands = unwrap<{ allow: string[]; needsConfirm: string[]; deny: string[] }>(cliCommands);
    expect(commands.allow.length).toBe(72);
    expect(commands.needsConfirm.length).toBe(2);
    expect(commands.deny.length).toBe(4);
    const unsafeCli = await http('POST', '/api/v1/cli/exec', { body: { argv: ['run-code', 'console.log(1)'] } });
    expect(unsafeCli.status).toBe(403);
    expect(errorCodeOf(unsafeCli)).toBe('CAPABILITY_DISABLED');
    const meta = await getMeta();
    expect(meta.env.bindHost).toBe('127.0.0.1');

    saveJson(SCENARIO, 'static-package.json', {
      files: allSkills,
      scriptCheck: checkResults,
      grepHits: { product: productHits, skillInstallNegativeMentions: skillInstallHits, skillModelHits },
      loopsProbes: loopsProbes.map((probe) => ({ status: probe.status, code: errorCodeOf(probe) })),
      skillsProbes: probes.map((probe) => ({ status: probe.status, code: errorCodeOf(probe) })),
      cli: { allow: commands.allow.length, confirm: commands.needsConfirm.length, deny: commands.deny.length },
      harnesses: harnessItems,
    });
  });

  test('A17-2 verify.mjs 只读自检：exit 0、检查项全过、skills 文件列表/mtime 不变', async () => {
    const before = snapshotTree(SKILL_DIR);
    const beforeDigest = treeDigest(before);
    const result = await runProcess(process.execPath, [join(SKILL_DIR, 'scripts', 'verify.mjs'), '--json', `--api-base=${API_BASE}`], {
      cwd: REPO_ROOT,
      timeoutMs: 120_000,
    });
    expect(result.exitCode, `verify.mjs 失败：${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { name: string; ok: boolean; detail?: string }[];
      failed: string[];
    };
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.checks.length).toBeGreaterThanOrEqual(20);
    expect(report.checks.some((check) => check.name === 'framework:no-skills-api' && check.ok)).toBe(true);
    expect(report.checks.some((check) => check.name === 'framework:no-install-state' && check.ok)).toBe(true);

    const after = snapshotTree(SKILL_DIR);
    expect(treeDigest(after)).toBe(beforeDigest);

    saveText(SCENARIO, 'verify.json', result.stdout);
    saveJson(SCENARIO, 'verify-tree.json', {
      before: before.length,
      after: after.length,
      digestBefore: beforeDigest,
      digestAfter: treeDigest(after),
      unchanged: treeDigest(after) === beforeDigest,
    });
  });

  test('A17-3 agent-loop full/data 确定性跑通 + heal 路径', async () => {
    const before = snapshotTree(SKILL_DIR);
    const beforeDigest = treeDigest(before);

    // full：NL→claim→MCP 探索→submit→accept→validate→run passed
    const full = await runProcess(
      process.execPath,
      [
        join(SKILL_DIR, 'scripts', 'agent-loop.mjs'),
        '--scenario=full',
        '--json',
        `--api-base=${API_BASE}`,
        `--base-url=${FIXTURE_BASE}/`,
      ],
      { cwd: REPO_ROOT, timeoutMs: 240_000 },
    );
    expect(full.exitCode, `agent-loop full 失败：${full.stderr}`).toBe(0);
    const fullReport = jsonFromOutput(full.stdout) as {
      scenario: string;
      caseId: string;
      generationId: string;
      runId: string;
      status: string;
      stats: { expected: number; unexpected: number };
      acceptedSteps: number;
      items: { itemKey: string; outcome: string }[];
      artifacts: { kind: string }[];
      mcp?: { sessionId?: string };
    };
    expect(fullReport.scenario).toBe('full');
    expect(fullReport.status).toBe('passed');
    expect(fullReport.stats.expected).toBe(1);
    expect(fullReport.stats.unexpected).toBe(0);
    expect(fullReport.acceptedSteps).toBeGreaterThanOrEqual(3);
    expect(fullReport.items.length).toBe(1);
    expect(fullReport.items[0]?.itemKey).toBe(fullReport.caseId);
    expect(fullReport.items[0]?.outcome).toBe('expected');
    expect(fullReport.artifacts.length).toBeGreaterThanOrEqual(3);
    expect(fullReport.mcp?.sessionId ?? '').not.toBe('');

    // data：数据集 2 行 + 逐行 rowIndex/itemKey/title
    const data = await runProcess(
      process.execPath,
      [
        join(SKILL_DIR, 'scripts', 'agent-loop.mjs'),
        '--scenario=data',
        '--json',
        `--api-base=${API_BASE}`,
        `--base-url=${FIXTURE_BASE}/`,
      ],
      { cwd: REPO_ROOT, timeoutMs: 240_000 },
    );
    expect(data.exitCode, `agent-loop data 失败：${data.stderr}`).toBe(0);
    const dataReport = jsonFromOutput(data.stdout) as {
      scenario: string;
      caseId: string;
      status: string;
      stats: { expected: number };
      dataset: { rowsCount: number; columns: string[] };
      items: { itemKey: string; rowIndex: number | null; title: string; outcome: string }[];
    };
    expect(dataReport.scenario).toBe('data');
    expect(dataReport.status).toBe('passed');
    expect(dataReport.dataset.rowsCount).toBe(2);
    expect(dataReport.stats.expected).toBe(2);
    expect(dataReport.items.length).toBe(2);
    expect(dataReport.items.map((item) => item.itemKey)).toEqual([
      `${dataReport.caseId}#row:0`,
      `${dataReport.caseId}#row:1`,
    ]);
    for (const item of dataReport.items) expect(item.title).toContain(`[row:${String(item.rowIndex)}]`);

    // heal 路径（确定性模拟 agent；非模型）：失败 → errorHash → 新 generation → accept → 重跑 passed
    const healCase = await createCase({
      name: `A17-Heal-${String(Date.now())}`,
      mode: 'steps',
      nl: { text: [`打开 ${FIXTURE_BASE}/`, '页面上应该出现文本「你好，自动化」'].join('\n') },
    });
    const brokenSteps: CaseStep[] = [
      { id: 'h1', action: 'goto', url: `${FIXTURE_BASE}/`, label: '打开演示站' },
      { id: 'h2', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '错误文案', label: '错误断言' },
    ];
    const brokenGen = await createGeneration(healCase.id);
    const brokenClaim = unwrap<NlGeneration>(await claimNlGeneration(brokenGen.id));
    await submitNlGeneration(brokenGen.id, {
      leaseId: brokenClaim.leaseId ?? '',
      steps: brokenSteps,
      stepOrigin: { h1: { nlLine: 1 }, h2: { nlLine: 2 } },
      generatorVersion: 'pw-e2e-agent/1.0.0',
    });
    const brokenAccept = await acceptNlGeneration(healCase.id, brokenGen.id);
    expect(brokenAccept.status).toBe(200);
    const brokenRun = await waitRun(unwrap<{ id: string }>(await startRun({ target: { kind: 'case', caseId: healCase.id } })).id);
    expect(brokenRun.status).toBe('failed');
    const brokenItems = await listRunItems(brokenRun.id);
    const firstAttempt = brokenItems.items[0]?.attempts[0];
    expect(firstAttempt?.status).toBe('failed');
    expect(firstAttempt?.errorHash ?? '').not.toBe('');

    // heal：同一 NL 文本重新生成 → 修正断言 → accept（新 generation）→ 重跑 passed
    const healGen = await createGeneration(healCase.id);
    const healClaim = unwrap<NlGeneration>(await claimNlGeneration(healGen.id));
    const healSubmitted = await submitNlGeneration(healGen.id, {
      leaseId: healClaim.leaseId ?? '',
      steps: [
        { id: 'h1', action: 'goto', url: `${FIXTURE_BASE}/`, label: '打开演示站' },
        { id: 'h2', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '你好，自动化', label: '修正断言' },
      ],
      stepOrigin: { h1: { nlLine: 1 }, h2: { nlLine: 2 } },
      generatorVersion: 'pw-e2e-agent/1.0.0',
    });
    expect(healSubmitted.status).toBe(200);
    const healAccept = await acceptNlGeneration(healCase.id, healGen.id);
    expect(healAccept.status).toBe(200);
    const healedCase = await readCase(healCase.id);
    expect(healedCase.steps.length).toBe(2);
    const healedRun = await waitRun(unwrap<{ id: string }>(await startRun({ target: { kind: 'case', caseId: healCase.id } })).id);
    expect(healedRun.status).toBe('passed');
    const healedItems = await listRunItems(healedRun.id);
    expect((healedItems.items[0] as RunItem).outcome).toBe('expected');

    // 框架不写 skills 目录：所有 skill 文件 size/mtime 不变
    const after = snapshotTree(SKILL_DIR);
    expect(treeDigest(after)).toBe(beforeDigest);

    saveJson(SCENARIO, 'agent-loop.json', {
      full: fullReport,
      data: dataReport,
      heal: {
        caseId: healCase.id,
        brokenRun: brokenRun.status,
        brokenErrorHash: firstAttempt?.errorHash,
        healedRun: healedRun.status,
        healedOutcome: healedItems.items[0]?.outcome,
      },
      skillsTree: { before: before.length, after: after.length, unchanged: treeDigest(after) === beforeDigest },
    });
  });

  test('A17-4 手工放置（用户动作）：harness 目录出现同一份 skill；verify 只读不写任何 harness 目录', async () => {
    const harnessRoot = join(WORK_DIR, `harness-skills-${String(Date.now())}`);
    const placed = join(harnessRoot, '.claude', 'skills', 'pw-auto-test');
    cpSync(SKILL_DIR, placed, { recursive: true });

    const before = snapshotTree(harnessRoot);
    expect(before.some((file) => file.path === '.claude/skills/pw-auto-test/SKILL.md')).toBe(true);
    const beforeDigest = treeDigest(before);

    const result = await runProcess(process.execPath, [join(SKILL_DIR, 'scripts', 'verify.mjs'), '--json', `--api-base=${API_BASE}`], {
      cwd: REPO_ROOT,
      timeoutMs: 120_000,
    });
    expect(result.exitCode, `verify.mjs 失败：${result.stderr}`).toBe(0);
    const report = jsonFromOutput(result.stdout) as { ok: boolean; failed: string[] };
    expect(report.ok).toBe(true);

    const after = snapshotTree(harnessRoot);
    expect(treeDigest(after)).toBe(beforeDigest);

    saveJson(SCENARIO, 'placement.json', {
      harnessRoot,
      placed,
      filesBefore: before.length,
      digestBefore: beforeDigest,
      digestAfter: treeDigest(after),
      verifyOk: report.ok,
      unchangedByVerify: treeDigest(after) === beforeDigest,
    });

    rmSync(harnessRoot, { recursive: true, force: true });
  });
});