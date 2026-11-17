import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, posix } from 'node:path';

const repo = process.cwd();
const label = process.argv[2] ?? 'before';
// 输出目录可通过 PW_FREEZE_OUT 覆盖（t14 集成验收写入 docs/acceptance/evidence；t21 复验写入 docs/verification/evidence/reverification）
const outDir = process.env['PW_FREEZE_OUT'] !== undefined && process.env['PW_FREEZE_OUT'] !== ''
  ? join(repo, process.env['PW_FREEZE_OUT'])
  : join(repo, 'docs', 'verification', 'evidence', 'reverification');
mkdirSync(outDir, { recursive: true });

const sourceRoots = ['apps/api/src', 'apps/web/src', 'packages/contracts/src', 'packages/automation/src', 'tests/e2e'];
const contractFiles = [
  'package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'pnpm-workspace.yaml',
  'apps/api/package.json', 'apps/web/package.json', 'packages/contracts/package.json', 'packages/automation/package.json', 'tests/e2e/package.json',
  'docs/PRD.md', 'docs/architecture.md', 'docs/api-contract.md', 'docs/traceability.md', 'docs/acceptance-plan.md',
  'README.md', 'AGENTS.md', 'docs/USER_GUIDE.md', 'docs/AGENT_INTEGRATION.md', 'docs/OPERATIONS.md',
];
const EXCLUDE = /(^|[\\/])(node_modules|\.data|dist|test-results|playwright-report|\.tmp|coverage|\.playwright-mcp|agents)([\\/]|$)/;

function walk(rootRel, acc) {
  const abs = join(repo, rootRel);
  let entries;
  try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const rel = posix.join(rootRel.split('\\').join('/'), entry.name);
    const absChild = join(repo, rel);
    if (EXCLUDE.test(rel)) continue;
    if (entry.isDirectory()) { walk(rel, acc); continue; }
    if (!entry.isFile()) continue;
    const buf = readFileSync(absChild);
    acc.push({ path: rel.split('\\').join('/'), sha256: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.byteLength });
  }
}

const files = [];
for (const root of sourceRoots) walk(root, files);
for (const rel of contractFiles) {
  try {
    const buf = readFileSync(join(repo, rel));
    files.push({ path: rel.split('\\').join('/'), sha256: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.byteLength });
  } catch { /* 文件缺失也应在清单中体现 */ files.push({ path: rel, sha256: 'MISSING', sizeBytes: 0 }); }
}
files.sort((a, b) => a.path.localeCompare(b.path));
const manifestDigest = createHash('sha256').update(files.map((f) => `${f.path}:${f.sha256}`).join('\n')).digest('hex');
const payload = {
  label,
  generatedAt: new Date().toISOString(),
  repoRoot: repo,
  sourceRoots,
  contractFiles,
  excluded: ['node_modules', '.data', 'dist', 'test-results', 'playwright-report', '.tmp', 'coverage', '.playwright-mcp', 'agents', 'docs/verification (本任务输出，另行留存)'],
  fileCount: files.length,
  manifestDigest,
  files,
};
writeFileSync(join(outDir, `freeze-${label}.json`), JSON.stringify(payload, null, 2), 'utf8');
console.log(JSON.stringify({ label, fileCount: files.length, manifestDigest, generatedAt: payload.generatedAt, outFile: `docs/verification/evidence/reverification/freeze-${label}.json` }));
