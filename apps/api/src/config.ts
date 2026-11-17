/**
 * 运行时配置（环境变量，见 docs/architecture.md §7）。
 * 纪律：全部有默认值；非法值立即失败并给出中文指引（不允许静默降级）。
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSERS, type BrowserName } from '@pw-auto/contracts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const BODY_LIMIT_BYTES = 1024 * 1024;
export const QUEUE_LIMIT = 32;
export const MCP_MAX_SESSIONS = 2;

export interface AppConfig {
  repoRoot: string;
  dataDir: string;
  staticDir: string | null;
  bindHost: string;
  port: number;
  corsOrigins: string[];
  runTimeoutMs: number;
  caseTimeoutMs: number;
  maxConcurrentRuns: number;
  browser: BrowserName;
  headed: boolean;
  keepRuns: number;
  enableUnsafeTools: boolean;
  logLevel: LogLevel;
  queueLimit: number;
  mcpMaxSessions: number;
  bodyLimitBytes: number;
  nlMaxLines: number;
  nlMaxChars: number;
  nlMaxSteps: number;
  nlGenerationTimeoutMs: number;
  nlLeaseTimeoutMs: number;
  nlRuleFallbackEnabled: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 从模块位置向上查找 `pnpm-workspace.yaml`：源码直跑与 dist 运行深度一致，均可命中 */
export function findRepoRoot(startDir?: string): string {
  let current = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // 兜底：工作目录（e2e 与 dev 均从仓库内的目录启动）
  let cwd = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(cwd, 'pnpm-workspace.yaml'))) return cwd;
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  throw new ConfigError('无法定位仓库根（未找到 pnpm-workspace.yaml），请设置 PW_DATA_DIR 为绝对路径');
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} 必须是 ${min}..${max} 的整数，当前值：${raw}`);
  }
  return value;
}

function readBool01(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new ConfigError(`${name} 只接受 0/1，当前值：${raw}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const repoRoot = env['PW_REPO_ROOT'] ? resolve(env['PW_REPO_ROOT']) : findRepoRoot();
  const dataDir = env['PW_DATA_DIR'] ? resolve(env['PW_DATA_DIR']) : join(repoRoot, '.data');
  const staticDirRaw = env['PW_STATIC_DIR'];
  const staticDir = staticDirRaw && staticDirRaw.trim() !== '' ? resolve(staticDirRaw) : null;

  const port = readInt(env, 'PW_PORT', 8787, 1, 65535);
  const browser = (env['PW_BROWSER'] ?? 'chromium') as BrowserName;
  if (!(BROWSERS as readonly string[]).includes(browser)) {
    throw new ConfigError(`PW_BROWSER 只接受官方 5 个取值：${BROWSERS.join(' / ')}，当前值：${browser}`);
  }

  const logLevelRaw = (env['PW_LOG_LEVEL'] ?? 'info') as LogLevel;
  if (!(LOG_LEVELS as readonly string[]).includes(logLevelRaw)) {
    throw new ConfigError(`PW_LOG_LEVEL 只接受 debug/info/warn/error，当前值：${logLevelRaw}`);
  }

  const corsOrigins = (env['PW_CORS_ORIGINS'] ?? 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return {
    repoRoot,
    dataDir,
    staticDir,
    bindHost: env['PW_BIND_HOST'] ?? '127.0.0.1',
    port,
    corsOrigins,
    runTimeoutMs: readInt(env, 'PW_RUN_TIMEOUT_MS', 600000, 5000, 86_400_000),
    caseTimeoutMs: readInt(env, 'PW_CASE_TIMEOUT_MS', 60000, 1000, 3_600_000),
    maxConcurrentRuns: readInt(env, 'PW_MAX_CONCURRENT_RUNS', 1, 1, 2),
    browser,
    headed: readBool01(env, 'PW_HEADED', false),
    keepRuns: readInt(env, 'PW_KEEP_RUNS', 50, 5, 100_000),
    enableUnsafeTools: readBool01(env, 'PW_ENABLE_UNSAFE_TOOLS', false),
    logLevel: logLevelRaw,
    queueLimit: QUEUE_LIMIT,
    mcpMaxSessions: MCP_MAX_SESSIONS,
    bodyLimitBytes: BODY_LIMIT_BYTES,
    nlMaxLines: readInt(env, 'PW_NL_MAX_LINES', 200, 1, 1000),
    nlMaxChars: readInt(env, 'PW_NL_MAX_CHARS', 20000, 100, 200000),
    nlMaxSteps: readInt(env, 'PW_NL_MAX_STEPS', 200, 1, 500),
    nlGenerationTimeoutMs: readInt(env, 'PW_NL_GENERATION_TIMEOUT_MS', 900000, 5000, 3_600_000),
    nlLeaseTimeoutMs: readInt(env, 'PW_NL_LEASE_TIMEOUT_MS', 120000, 5000, 600000),
    nlRuleFallbackEnabled: readBool01(env, 'PW_ENABLE_NL_RULE_FALLBACK', false),
  };
}