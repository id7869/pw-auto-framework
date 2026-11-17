/**
 * 测试装配工具：临时数据目录 + 真实 HTTP 监听 + 静默日志 + fake 执行引擎。
 * 纪律：不访问外网、不使用真实浏览器、不写仓库目录（repoRoot 也指向临时目录）。
 */

import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionEngine } from '@pw-auto/automation';
import type { SurfaceBundle } from '@pw-auto/contracts';
import { createApplication, type Application } from '../app.ts';
import type { AppConfig } from '../config.ts';
import type { Logger } from '../services/container.ts';

export const silentLogger: Logger = () => {};

export function testConfig(dataDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    repoRoot: dataDir,
    dataDir,
    staticDir: null,
    bindHost: '127.0.0.1',
    port: 8787,
    corsOrigins: ['http://127.0.0.1:4173'],
    runTimeoutMs: 60000,
    caseTimeoutMs: 60000,
    maxConcurrentRuns: 1,
    browser: 'chromium',
    headed: false,
    keepRuns: 50,
    enableUnsafeTools: false,
    logLevel: 'error',
    queueLimit: 32,
    mcpMaxSessions: 2,
    bodyLimitBytes: 1024 * 1024,
    nlMaxLines: 200,
    nlMaxChars: 20000,
    nlMaxSteps: 200,
    nlGenerationTimeoutMs: 900000,
    nlLeaseTimeoutMs: 120000,
    nlRuleFallbackEnabled: false,
    ...overrides,
  };
}

export interface StartApiOptions {
  engine?: ExecutionEngine | null;
  surfaces?: SurfaceBundle;
  config?: Partial<AppConfig>;
  /** 覆盖官方 CLI 路径（注入无效路径以验证 meta fallback 语义） */
  playwrightCliPath?: string;
}

export interface TestApi {
  baseUrl: string;
  dataDir: string;
  app: Application;
  close(): Promise<void>;
}

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pw-auto-api-'));
}

export async function startApi(options: StartApiOptions = {}): Promise<TestApi> {
  return startApiIn(makeTempDir(), options);
}

/**
 * 监听临时端口并读取真实地址（review F3 / t14 集成修复）：
 * - 必须等 `listening` 事件后再读 `server.address()`（否则可能拿到 null）；
 * - 端口用 0（系统分配），若偶发 EADDRINUSE 则退避重试 ≤10 次；
 * - 系统分配到 fetch 禁用端口（bad port）时关闭后重试（见 FETCH_BLOCKED_PORTS）；
 * - 地址异常直接抛错，绝不返回 `http://127.0.0.1:undefined` 这类假 URL。
 */
/**
 * Node（undici）fetch 禁用端口列表：命中会抛 `TypeError: fetch failed / bad port`。
 * 系统分配的临时端口若落在该列表（Windows 动态端口范围可低于 49152），测试会偶发
 * `bad port`（t14 集成期实测 health-meta 2 个用例）。这里主动重试，避开不可 fetch 的端口。
 * 来源：Node.js 文档「fetch 会拒绝的端口」（undici badPorts 列表）。
 */
const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 13, 19, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port);
}

export async function listenOnEphemeralPort(server: Application['server']): Promise<number> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('未能读取监听地址（server.address() 返回空）');
      }
      const port = (address as AddressInfo).port;
      if (isFetchBlockedPort(port)) {
        // 系统分配到了 fetch 不可访问的端口：关闭后重试，避免测试出现 "bad port" 噪音。
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        lastError = new Error(`系统分配的端口 ${port} 在 fetch 禁用列表中，已重试`);
        continue;
      }
      return port;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'EADDRINUSE' && attempt < 10) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 50));
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('监听临时端口失败');
}

export async function startApiIn(dataDir: string, options: StartApiOptions = {}): Promise<TestApi> {
  const config = testConfig(dataDir, options.config ?? {});
  const app = createApplication({
    config,
    engine: options.engine,
    surfaces: options.surfaces,
    logger: silentLogger,
    ...(options.playwrightCliPath === undefined ? {} : { playwrightCliPath: options.playwrightCliPath }),
  });
  const port = await listenOnEphemeralPort(app.server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    app,
    async close() {
      await app.close();
    },
  };
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上偶发文件占用：忽略清理失败（临时目录随后由系统回收）
  }
}

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export interface CallOptions {
  headers?: Record<string, string>;
  method?: string;
  rawBody?: string;
  omitContentType?: boolean;
}

export async function call<T = unknown>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  options: CallOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const init: RequestInit = { method, headers };
  if (options.rawBody !== undefined) {
    if (!options.omitContentType) headers['content-type'] = 'application/json';
    init.body = options.rawBody;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, headers: response.headers, body: parsed as T, text };
}

export function dataOf<T>(response: ApiResponse<{ data: T }>): T {
  return response.body.data;
}

export function errorCodeOf(response: ApiResponse<{ error: { code: string; message: string } }>): string {
  return response.body.error.code;
}

export async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await fn();
    if (predicate(last)) return last;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

export function writeTextFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
}