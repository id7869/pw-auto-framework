/**
 * 官方入口定位与版本探测（供 /api/meta、运行诊断回显使用）。
 *
 * 依赖已冻结：`@playwright/test@1.65.0` 单包内置 test / cli / mcp / trace / init-agents。
 * 不在代码里调用 npx（architecture §4.2-4），一律用解析到的绝对路径。
 *
 * 版本策略（review F1）：
 * - 启动时执行一次 `node <cli.js> --version`，**仅当 exit status===0 且无 signal 时**解析 **stdout**；
 * - 解析采用严格 `Version x.y.z` 整串匹配（官方 `playwright --version` 输出形态）；
 * - 非零退出 / 超时 / 被信号终止 / spawn 失败 / 输出不匹配 → 一律返回冻结常量
 *   `version=PLAYWRIGHT_VERSION`、`source="fallback"`、非空 `error`（并在 meta 回显），
 *   绝不把常量伪装成探测结果。
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PLAYWRIGHT_VERSION } from '@pw-auto/contracts';

export function resolvePlaywrightCliPath(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('@playwright/test/cli.js');
  } catch {
    // 某些分发形态不导出 ./cli.js，退回包根目录定位
  }
  try {
    const packageJsonPath = require.resolve('@playwright/test/package.json');
    return join(dirname(packageJsonPath), 'cli.js');
  } catch {
    return '';
  }
}

export interface PlaywrightVersionInfo {
  /** 实际生效版本（cli 探测成功时为真实版本；否则为冻结常量） */
  version: string;
  /** cli = 真实执行 `node <cli.js> --version` 解析；fallback = 回退常量 */
  source: 'cli' | 'fallback';
  cliPath: string;
  /** 探测失败原因（source=fallback 时必有非空值） */
  error?: string;
  /** 契约常量（用于回显"期望版本"） */
  expectedVersion: string;
}

/** 严格匹配官方 `playwright --version` 输出：整串仅为 `Version x.y.z[-prerelease]` */
const STRICT_VERSION_PATTERN = /^Version\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function clip(text: string, maxLength = 160): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength)}…`;
}

/** spawnSync 结果的可测试子集（便于单测直接构造超时/信号等分支，避免 OS 差异） */
export interface PlaywrightProbeResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: { message?: string; code?: string } | null;
}

/**
 * 探测结果 → PlaywrightVersionInfo 的纯函数（可单测）。
 * 只有 status===0 且 signal===null 才解析 stdout；其余一律 fallback。
 */
export function interpretPlaywrightVersionProbe(
  result: PlaywrightProbeResult,
  cliPath: string,
): PlaywrightVersionInfo {
  const fallback = (error: string): PlaywrightVersionInfo => ({
    version: PLAYWRIGHT_VERSION,
    source: 'fallback',
    cliPath,
    error: error === '' ? '版本探测失败（原因未知）' : error,
    expectedVersion: PLAYWRIGHT_VERSION,
  });

  if (result.error) {
    const code = result.error.code ?? '';
    const reason = result.error.message ?? 'spawn 失败';
    return fallback(`执行 node <cli.js> --version 失败${code === '' ? '' : `（${code}）`}：${clip(reason)}`);
  }
  if (result.signal !== null && result.signal !== undefined) {
    return fallback(`node <cli.js> --version 被信号终止：${String(result.signal)}`);
  }
  if (result.status !== 0) {
    const stderr = clip(result.stderr ?? '', 120);
    return fallback(`node <cli.js> --version 退出码 ${String(result.status)}${stderr === '' ? '' : `：${stderr}`}`);
  }

  // 仅解析 stdout（不把 stderr 混入），且要求严格 Version x.y.z 整串
  const stdout = (result.stdout ?? '').trim();
  const match = STRICT_VERSION_PATTERN.exec(stdout);
  if (match === null || match[1] === undefined) {
    return fallback(`stdout 不匹配严格 "Version x.y.z"：${clip(stdout)}`);
  }
  return {
    version: match[1],
    source: 'cli',
    cliPath,
    expectedVersion: PLAYWRIGHT_VERSION,
  };
}

const infoCache = new Map<string, PlaywrightVersionInfo>();

/** 启动时调用一次即可（按 cliPath 进程内缓存；重复调用零成本） */
export function probePlaywrightVersion(cliPath: string = resolvePlaywrightCliPath(), timeoutMs = 15_000): PlaywrightVersionInfo {
  const cached = infoCache.get(cliPath);
  if (cached !== undefined) return cached;

  let info: PlaywrightVersionInfo;
  if (cliPath === '') {
    info = {
      version: PLAYWRIGHT_VERSION,
      source: 'fallback',
      cliPath,
      error: '未解析到 @playwright/test/cli.js（回退冻结常量）',
      expectedVersion: PLAYWRIGHT_VERSION,
    };
  } else {
    try {
      const result = spawnSync(process.execPath, [cliPath, '--version'], {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
      });
      info = interpretPlaywrightVersionProbe(
        {
          status: result.status,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
          error: result.error === undefined ? null : result.error,
        },
        cliPath,
      );
    } catch (error) {
      info = {
        version: PLAYWRIGHT_VERSION,
        source: 'fallback',
        cliPath,
        error: `版本探测异常：${error instanceof Error ? clip(error.message) : clip(String(error))}`,
        expectedVersion: PLAYWRIGHT_VERSION,
      };
    }
  }
  infoCache.set(cliPath, info);
  return info;
}

/** meta 响应中 versions 的版本相关字段（唯一构造点，测试可直接断言 fallback 字段） */
export interface MetaVersionFields {
  playwright: string;
  playwrightCliPath: string;
  playwrightSource: 'cli' | 'fallback';
  playwrightVersionError?: string;
}

export function metaVersionFields(info: PlaywrightVersionInfo): MetaVersionFields {
  return {
    playwright: info.version,
    playwrightCliPath: info.cliPath,
    playwrightSource: info.source,
    ...(info.source === 'fallback' ? { playwrightVersionError: info.error ?? '版本探测失败（原因未知）' } : {}),
  };
}

/** 运行环境指纹（api-contract §5.1 EnvironmentFingerprint）；playwright 取真实探测版本 */
export function baseEnvironment(browser: string): {
  node: string;
  playwright: string;
  browser: string;
  os: string;
  timezone: string;
} {
  return {
    node: process.versions.node,
    playwright: probePlaywrightVersion().version,
    browser,
    os: `${process.platform}-${process.arch}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
  };
}