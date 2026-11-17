/**
 * 子进程与进程树工具（Windows 优先，跨平台降级）。
 *
 * 用途：
 * - 独立启动官方 CLI / MCP / init-agents（验证官方入口本身）；
 * - 独立启动第二个后端实例（重启持久化场景）；
 * - 进程计数与清理断言（反作弊条款 §4.6）。
 *
 * 纪律：一律 `spawn(exe, argv, { shell: false })`（architecture §8：禁止命令拼接）；
 * 杀进程用 `taskkill /F /T /PID`（Windows 只杀父进程会留孤儿）。
 */

import { spawn, spawnSync } from 'node:child_process';

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** 写入 stdin 后关闭（用于 MCP/CLI 的交互式入口时留空） */
  input?: string;
}

/** 一次性执行并收集输出（超时会强杀进程树） */
export function runProcess(command: string, args: readonly string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            if (child.pid !== undefined) killTree(child.pid);
            else child.kill('SIGKILL');
          }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${String(error)}`, durationMs: Date.now() - startedAt, timedOut });
    });
    child.on('close', (code) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

/** 强制结束进程树（Windows: taskkill /F /T；其它平台: kill -9 进程组尽力而为） */
export function killTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程已退出
    }
  }
}

export interface ServerHandle {
  pid: number;
  stop(): void;
  stdout(): string;
  stderr(): string;
}

/** 启动一个长期运行的服务进程（API 实例等），由调用方负责 stop() */
export function spawnServer(command: string, args: readonly string[], options: RunProcessOptions): ServerHandle {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const pid = child.pid ?? 0;
  return {
    pid,
    stop: () => killTree(pid),
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/** 轮询 HTTP 端点直到 200（或超时抛错） */
export async function waitForHttp(url: string, timeoutMs = 60_000, intervalMs = 300): Promise<void> {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      lastError = `HTTP ${String(response.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待 ${url} 就绪超时（${timeoutMs}ms）：${lastError}`);
}

/** 统计 chrome.exe / msedge.exe 进程数（Windows）；其它平台返回 0 */
export function countBrowserProcesses(): number {
  if (process.platform !== 'win32') return 0;
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const lines = (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith('"chrome.exe"'));
  return lines.length;
}

export interface NodeProcessInfo {
  pid: number;
  commandLine: string;
}

/** 列出 node.exe 进程（含命令行），用于「本套件启动的子进程已清理」断言 */
export function listNodeProcesses(): NodeProcessInfo[] {
  if (process.platform !== 'win32') return [];
  const script = [
    '$ErrorActionPreference="SilentlyContinue";',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |',
    ' Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  const raw = (result.stdout ?? '').trim();
  if (raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .map((item) => item as { ProcessId?: number; CommandLine?: string })
      .filter((item) => typeof item.ProcessId === 'number')
      .map((item) => ({ pid: item.ProcessId as number, commandLine: item.CommandLine ?? '' }));
  } catch {
    return [];
  }
}

/** 统计命令行包含 marker 的 node 进程数（例如本套件的数据目录） */
export function countNodeProcessesWithMarker(marker: string): NodeProcessInfo[] {
  const normalized = marker.toLowerCase().replaceAll('\\', '/');
  return listNodeProcesses().filter((item) => item.commandLine.toLowerCase().replaceAll('\\', '/').includes(normalized));
}

export interface BrowserProcessInfo {
  pid: number;
  commandLine: string;
}

/**
 * 列出浏览器进程（含命令行）。
 *
 * 用途：只统计「本套件自己启动的浏览器」——Playwright 的 chromium 进程命令行含
 * `--user-data-dir=<profile>`，而 MCP/CLI/运行工作区都在本套件的数据目录下，
 * 因此按数据目录前缀过滤可以排除测试 runner 自身浏览器与用户浏览器，避免进程数抖动误判。
 */
export function listBrowserProcesses(): BrowserProcessInfo[] {
  if (process.platform !== 'win32') return [];
  const script = [
    '$ErrorActionPreference="SilentlyContinue";',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\' OR Name=\'msedge.exe\'" |',
    ' Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  const raw = (result.stdout ?? '').trim();
  if (raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .map((item) => item as { ProcessId?: number; CommandLine?: string })
      .filter((item) => typeof item.ProcessId === 'number')
      .map((item) => ({ pid: item.ProcessId as number, commandLine: item.CommandLine ?? '' }));
  } catch {
    return [];
  }
}

/** 统计命令行包含 marker 的浏览器进程（本套件启动的 MCP/CLI/运行浏览器） */
export function countBrowserProcessesWithMarker(marker: string): BrowserProcessInfo[] {
  const normalized = marker.toLowerCase().replaceAll('\\', '/');
  return listBrowserProcesses().filter((item) => item.commandLine.toLowerCase().replaceAll('\\', '/').includes(normalized));
}