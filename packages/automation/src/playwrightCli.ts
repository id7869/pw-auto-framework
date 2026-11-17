/**
 * 官方 Playwright CLI 定位与版本探测。
 *
 * 唯一允许的官方入口：`@playwright/test@1.65.0` 内置的 `cli.js`。
 * 定位方式（实测于 1.65.0）：
 * - `require.resolve('@playwright/test/cli')` 命中 package.json exports 的 `./cli` 子路径；
 * - `@playwright/test/cli.js` 未在 exports 中声明，直接 resolve 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED，
 *   因此仅作为二级回退：先 resolve `@playwright/test/package.json`，再拼 dirname/cli.js。
 *
 * 禁止使用 npx 字符串拼接与 shell；spawn 一律 `spawn(process.execPath, [cliPath, ...argv], { shell: false })`。
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLAYWRIGHT_VERSION } from '@pw-auto/contracts';

import { AutomationError } from './errors.ts';

const requireFromHere = createRequire(import.meta.url);

export const EXPECTED_PLAYWRIGHT_VERSION = PLAYWRIGHT_VERSION;

let cachedCliPath: string | null = null;

function existsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析官方 CLI 绝对路径。失败抛 NOT_IMPLEMENTED（api-contract §10：官方入口缺失）。
 */
export function resolvePlaywrightCli(explicitPath?: string): string {
  if (explicitPath !== undefined && explicitPath.trim() !== '') {
    const resolved = path.resolve(explicitPath);
    if (!existsFile(resolved)) {
      throw new AutomationError('NOT_IMPLEMENTED', `指定的 Playwright CLI 不存在：${resolved}`);
    }
    return resolved;
  }
  if (cachedCliPath !== null && existsFile(cachedCliPath)) return cachedCliPath;

  const attempts: string[] = [];
  // 官方 exports 子路径（首选）。
  try {
    const resolved = requireFromHere.resolve('@playwright/test/cli');
    attempts.push(`@playwright/test/cli -> ${resolved}`);
    if (existsFile(resolved)) {
      cachedCliPath = resolved;
      return resolved;
    }
  } catch (error) {
    attempts.push(`@playwright/test/cli -> ${(error as Error).message}`);
  }
  // 回退：package.json（官方 exports 中声明）→ 同目录 cli.js。
  try {
    const pkgPath = requireFromHere.resolve('@playwright/test/package.json');
    attempts.push(`@playwright/test/package.json -> ${pkgPath}`);
    const cliPath = path.join(path.dirname(pkgPath), 'cli.js');
    if (existsFile(cliPath)) {
      cachedCliPath = cliPath;
      return cliPath;
    }
    attempts.push(`${cliPath} 不存在`);
  } catch (error) {
    attempts.push(`@playwright/test/package.json -> ${(error as Error).message}`);
  }

  throw new AutomationError(
    'NOT_IMPLEMENTED',
    '未找到官方 @playwright/test 内置 CLI（1.65.0）。请先执行 pnpm install；如需人工自检可运行 node node_modules/@playwright/test/cli.js --version。',
    { detail: { attempts } },
  );
}

/** 本包（packages/automation）根目录；同时兼容 src/ 与 dist/ 运行。 */
export function findPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/playwrightCli.ts -> packages/automation；dist/playwrightCli.js -> packages/automation
  return path.resolve(here, '..');
}

/** 仓库根目录：向上寻找含 pnpm-workspace.yaml 的目录。找不到返回 null。 */
export function findRepoRoot(startDir?: string): string | null {
  let current = path.resolve(startDir ?? findPackageRoot());
  for (let depth = 0; depth < 6; depth += 1) {
    if (
      fs.existsSync(path.join(current, 'pnpm-workspace.yaml')) &&
      fs.existsSync(path.join(current, 'package.json'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export interface CliVersionInfo {
  cliPath: string;
  /** 官方 `--version` 输出的原始文本。 */
  raw: string;
  /** 解析出的语义版本；解析失败为 null。 */
  version: string | null;
}

const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

/** 解析官方 CLI `--version` 输出；纯函数，便于单测。 */
export function parsePlaywrightVersion(raw: string): string | null {
  const match = VERSION_PATTERN.exec(raw);
  return match?.[1] ?? null;
}

/** 解析 repository 根下的 node_modules（用于 workspace 在仓库外时的解析兜底）。 */
export function findRepoNodeModules(): string | null {
  const repoRoot = findRepoRoot();
  if (repoRoot === null) return null;
  const candidate = path.join(repoRoot, 'node_modules');
  return fs.existsSync(candidate) ? candidate : null;
}