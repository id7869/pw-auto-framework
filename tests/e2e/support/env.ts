/**
 * e2e 验收的运行环境常量（唯一来源）。
 *
 * 端口与路径来自 docs/architecture.md §5.5 / §7 与 docs/acceptance-plan.md §1：
 *   fixture 站点 127.0.0.1:4174 · 后端 API 127.0.0.1:8787 · 前端 Vite 127.0.0.1:4173
 * 数据目录固定在 tests/e2e/.tmp/data（config 启动前清空），证据落在 docs/verification/evidence/。
 */

import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 仓库根（tests/e2e/support → tests/e2e → tests → repo） */
export const REPO_ROOT = resolve(here, '..', '..', '..');
export const E2E_ROOT = join(REPO_ROOT, 'tests', 'e2e');

/**
 * 临时数据目录移出仓库（系统临时目录），避免被 Playwright 采集为测试文件
 * （captain F1：tests/e2e 下不得出现会被采集的生成物；docs/acceptance-plan.md §1 亦要求 <temp>/pw-e2e-*）。
 * 每轮验收在 playwright.config.ts 载入时清空；验收结束后由执行者删除。
 */
export const TMP_DIR = process.env['PW_E2E_TMP_DIR'] ?? join(tmpdir(), 'pw-e2e-acceptance');
/** 后端数据目录（db + runs + mcp + cli） */
export const DATA_DIR = join(TMP_DIR, 'data');
/** 独立验证用的临时工作区（不进入产品数据目录） */
export const WORK_DIR = join(TMP_DIR, 'work');
/** 验收证据目录（提交物，位于仓库内） */
export const EVIDENCE_DIR = join(REPO_ROOT, 'docs', 'verification', 'evidence');

/**
 * 端口：默认值来自 docs/architecture.md §5.5（8787 / 4173 / 4174，固定且 strictPort）。
 * 允许通过 PW_E2E_API_PORT / PW_E2E_WEB_PORT / PW_E2E_FIXTURE_PORT 覆盖，仅用于端口被他人占用时的
 * 受控替换（默认路径不变，保证根命令 `pnpm run test:e2e` 可复现）。
 */
export const API_PORT = Number(process.env['PW_E2E_API_PORT'] ?? '8787');
export const WEB_PORT = Number(process.env['PW_E2E_WEB_PORT'] ?? '4173');
export const FIXTURE_PORT = Number(process.env['PW_E2E_FIXTURE_PORT'] ?? '4174');

export const API_BASE = `http://127.0.0.1:${API_PORT}`;
export const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;
export const FIXTURE_BASE = `http://127.0.0.1:${FIXTURE_PORT}`;
/** 独立启动第二个后端实例（重启持久化场景）用的端口 */
export const API_ALT_PORT = Number(process.env['PW_E2E_API_ALT_PORT'] ?? '8788');
export const API_ALT_BASE = `http://127.0.0.1:${API_ALT_PORT}`;

/** 植入到 API 进程环境变量的假密钥：任何响应/前端/产物中都不应出现其值 */
export const PLANTED_SECRET_NAME = 'PW_E2E_SECRET';
export const PLANTED_SECRET_VALUE = 'pw-e2e-planted-secret-9f3c2b';

/** 官方 @playwright/test 内置 CLI（1.65.0）绝对路径；可用 PW_E2E_CLI_PATH 覆盖 */
export function resolvePlaywrightCli(): string {
  const explicit = process.env['PW_E2E_CLI_PATH'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  const requireFromHere = createRequire(import.meta.url);
  return requireFromHere.resolve('@playwright/test/cli');
}

export const PLAYWRIGHT_VERSION = '1.65.0';