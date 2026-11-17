#!/usr/bin/env node
/**
 * pw-auto-test · 只读自检。
 *
 * 检查：框架 health / meta（版本溯源）/ harnesses（3 入口）+ 本 skill 文件是否就位 + 无安装器/安装 API。
 * 严格只读：不复制、不写入、不删除任何文件（包括 harness 的 skills 目录）。
 *
 * 用法：
 *   node verify.mjs [--api-base=http://127.0.0.1:8787] [--allow-fallback] [--json]
 *
 * 退出码：0 全部通过；1 有失败项；2 参数错误。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, PwAutoApi } from './api.mjs';

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPECTED_PLAYWRIGHT = '1.65.0';

function parseArgs(argv) {
  const options = {
    apiBase: process.env.PW_API_BASE ?? 'http://127.0.0.1:8787',
    allowFallback: false,
    json: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--api-base=')) options.apiBase = arg.slice('--api-base='.length);
    else if (arg === '--allow-fallback') options.allowFallback = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node verify.mjs [--api-base=URL] [--allow-fallback] [--json]');
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function check(checks, name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail ?? '' });
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readText(path) {
  return readFile(path, 'utf8');
}

async function checkSkillFiles(checks) {
  const required = [
    'SKILL.md',
    'references/harness-matrix.md',
    'references/nl-to-case.md',
    'references/api-cheatsheet.md',
    'references/data-driven.md',
    'references/agent-handoff.md',
    'references/troubleshooting.md',
    'scripts/api.mjs',
    'scripts/verify.mjs',
    'scripts/agent-loop.mjs',
    'templates/plan.md',
    'templates/generate.md',
    'templates/heal.md',
    'templates/coverage.md',
    'templates/seed.spec.ts',
  ];
  for (const relative of required) {
    check(checks, `skill-file:${relative}`, await fileExists(join(SKILL_DIR, relative)), join(SKILL_DIR, relative));
  }

  const forbidden = ['install.mjs', 'scripts/install.mjs', 'manifest.json', '.pw-auto-skill.json', 'install'];
  for (const relative of forbidden) {
    check(checks, `no-installer:${relative}`, !(await fileExists(join(SKILL_DIR, relative))), '应为静态资产（无安装器/清单）');
  }

  const skillMd = await readText(join(SKILL_DIR, 'SKILL.md')).catch(() => '');
  const lines = skillMd.split(/\r?\n/);
  check(checks, 'SKILL.md:<=400-lines', lines.length <= 400, `实际 ${lines.length} 行`);
  check(checks, 'SKILL.md:frontmatter', lines[0]?.trim() === '---' && /^name:\s*pw-auto-test\s*$/m.test(skillMd), '需要 --- frontmatter 且 name: pw-auto-test');
  check(checks, 'SKILL.md:description', /^description:\s*\S+/m.test(skillMd), '需要 description');
  check(
    checks,
    'SKILL.md:playwrightVersion-pin',
    skillMd.includes(`playwrightVersion: ${EXPECTED_PLAYWRIGHT}`),
    `需要声明 playwrightVersion: ${EXPECTED_PLAYWRIGHT}`,
  );

  // 静态资产自证：目录下不得出现 .js 安装脚本以外的构建/安装产物（本包只允许 3 个脚本）。
  const scriptFiles = (await readdir(join(SKILL_DIR, 'scripts')).catch(() => [])).filter((name) => name.endsWith('.mjs'));
  check(
    checks,
    'scripts:exactly-3',
    scriptFiles.sort().join(',') === 'agent-loop.mjs,api.mjs,verify.mjs',
    `实际：${scriptFiles.sort().join(',')}`,
  );
}

async function checkFramework(checks, apiBase, allowFallback) {
  const api = new PwAutoApi({ baseUrl: apiBase, timeoutMs: 15_000 });

  try {
    const health = await api.health();
    check(checks, 'framework:health', health?.status === 'ok', JSON.stringify(health));
  } catch (error) {
    check(checks, 'framework:health', false, error instanceof Error ? error.message : String(error));
  }

  try {
    const meta = await api.meta();
    const versions = meta?.versions ?? {};
    const source = versions.playwrightSource;
    check(checks, 'framework:meta', meta?.app?.name === 'pw-auto-framework', meta?.app?.name ?? '');
    check(
      checks,
      'framework:playwrightSource=cli',
      source === 'cli' || (allowFallback === true && source === 'fallback'),
      source === 'cli' ? 'cli（真实探测）' : `source=${source}${versions.playwrightVersionError ? `；error=${versions.playwrightVersionError}` : ''}`,
    );
    check(checks, 'framework:playwright-version-nonempty', typeof versions.playwright === 'string' && versions.playwright.length > 0, versions.playwright ?? '');
  } catch (error) {
    check(checks, 'framework:meta', false, error instanceof Error ? error.message : String(error));
  }

  try {
    const harnesses = await api.harnesses();
    const items = Array.isArray(harnesses?.items) ? harnesses.items : [];
    const entries = items.map((item) => item.entry);
    check(checks, 'framework:harnesses-3', items.length === 3, `entries=${entries.join(',')}`);
    check(
      checks,
      'framework:harnesses-entries',
      ['claude', 'codex', 'deepseek'].every((entry) => entries.includes(entry)),
      entries.join(','),
    );
    const deepseek = items.find((item) => item.entry === 'deepseek');
    check(checks, 'framework:deepseek-officialLoop-null', deepseek?.officialLoop === null, String(deepseek?.officialLoop));
    check(
      checks,
      'framework:requiresMcp-false',
      items.every((item) => item.requiresMcp === false),
      JSON.stringify(items.map((item) => [item.entry, item.requiresMcp])),
    );
    check(
      checks,
      'framework:no-install-state',
      items.every((item) => !('installed' in item) && !('installTargets' in item)),
      'harnesses 不得含 installed/installTargets',
    );
  } catch (error) {
    check(checks, 'framework:harnesses', false, error instanceof Error ? error.message : String(error));
  }

  // 设计裁定：不存在任何 skill 安装 API；GET /api/v1/skills 应为 404。
  try {
    await api.raw('GET', '/api/v1/skills');
    check(checks, 'framework:no-skills-api', false, 'GET /api/v1/skills 不应存在');
  } catch (error) {
    check(
      checks,
      'framework:no-skills-api',
      error instanceof ApiError && error.status === 404,
      error instanceof ApiError ? `HTTP ${error.status}` : String(error),
    );
  }

  // t47 durable 裁定：/agents/loops 已永久移除（任何方法 404）；唯一入口是 /agents/harnesses。
  for (const method of ['GET', 'POST']) {
    try {
      await api.raw(method, '/api/v1/agents/loops');
      check(checks, `framework:no-agents-loops-${method}`, false, `${method} /api/v1/agents/loops 不应存在`);
    } catch (error) {
      check(
        checks,
        `framework:no-agents-loops-${method}`,
        error instanceof ApiError && error.status === 404,
        error instanceof ApiError ? `HTTP ${error.status}` : String(error),
      );
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const checks = [];
  await checkSkillFiles(checks);
  await checkFramework(checks, options.apiBase, options.allowFallback);
  const failed = checks.filter((item) => !item.ok);
  const report = {
    ok: failed.length === 0,
    skillDir: SKILL_DIR,
    apiBase: options.apiBase,
    checkedAt: new Date().toISOString(),
    checks,
    failed: failed.map((item) => item.name),
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`pw-auto-test verify · skill=${SKILL_DIR} · api=${options.apiBase}`);
    for (const item of checks) console.log(`${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    console.log(report.ok ? '结论：通过（只读自检）' : `结论：失败 ${failed.length} 项`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

await main();