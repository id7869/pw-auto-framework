/**
 * 子进程执行与进程树清理（Windows 优先）。
 *
 * 纪律（docs/architecture.md §8）：
 * - 一律 `spawn(exe, argv, { shell: false })`，不拼命令字符串；
 * - 取消/超时统一 `taskkill /F /T /PID`（Windows）或进程组 kill（POSIX），并登记 pid 台账；
 * - 只等 `exit` 事件，不等 `close`：官方 CLI 的浏览器 daemon 会继承 stdout/stderr 句柄，
 *   等 close 会永久挂起（实测）。
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

import { AutomationError } from '../errors.ts';

export interface ProcessRegistration {
  pid: number;
  label: string;
  startedAt: string;
}

/** pid 台账：便于取消、关停与收尾清理。 */
export class ProcessRegistry {
  private readonly entries = new Map<number, ProcessRegistration>();

  register(pid: number, label: string): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    this.entries.set(pid, { pid, label, startedAt: new Date().toISOString() });
  }

  unregister(pid: number): void {
    this.entries.delete(pid);
  }

  list(): ProcessRegistration[] {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  /** 强杀所有登记进程（进程树）；失败忽略，返回处理数量。 */
  async killAll(): Promise<number> {
    const snapshot = this.list();
    await Promise.all(snapshot.map((entry) => killProcessTree(entry.pid)));
    this.clear();
    return snapshot.length;
  }
}

/** 判断进程是否仍存在（仅供诊断/测试；Windows 下 process.kill(pid,0) 可用）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 强杀进程树。
 * Windows：taskkill /F /T /PID（官方系统工具，无 shell）。
 * POSIX：优先杀进程组（spawn 时 detached=true），回退单 pid。
 */
export async function killProcessTree(pid: number, timeoutMs = 10_000): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        const timer = setTimeout(() => {
          try {
            killer.kill();
          } catch {
            // 忽略：超时后仅保证不阻塞调用方。
          }
          finish();
        }, timeoutMs);
        timer.unref?.();
        killer.on('exit', () => {
          clearTimeout(timer);
          finish();
        });
        killer.on('error', () => {
          clearTimeout(timer);
          // taskkill 不可用时回退单 pid。
          try {
            process.kill(pid);
          } catch {
            // 进程可能已退出。
          }
          finish();
        });
      } catch {
        try {
          process.kill(pid);
        } catch {
          // 进程可能已退出。
        }
        finish();
      }
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程可能已退出。
    }
  }
}

export interface ProcessRunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** 硬超时：到点杀进程树，结果 timedOut=true。 */
  timeoutMs?: number;
  /** 外部取消：abort 后杀进程树，结果 aborted=true。 */
  signal?: AbortSignal;
  /** 单个流（stdout/stderr）保留上限，默认 2 MiB。 */
  maxBufferBytes?: number;
  label?: string;
  registry?: ProcessRegistry;
}

export interface ProcessRunResult {
  pid: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  spawnError: string | null;
}

interface BoundedBuffer {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function appendBounded(buffer: BoundedBuffer, chunk: Buffer, maxBytes: number): void {
  if (buffer.bytes >= maxBytes) {
    buffer.truncated = true;
    return;
  }
  const remaining = maxBytes - buffer.bytes;
  if (chunk.length <= remaining) {
    buffer.chunks.push(chunk);
    buffer.bytes += chunk.length;
    return;
  }
  buffer.chunks.push(chunk.subarray(0, remaining));
  buffer.bytes += remaining;
  buffer.truncated = true;
}

function bufferText(buffer: BoundedBuffer): string {
  return Buffer.concat(buffer.chunks).toString('utf8');
}

/**
 * 执行一个外部进程并等待其退出。
 * - 不抛“非零退出”错误：退出码是结果的一部分；
 * - spawn 失败（ENOENT 等）→ spawnError 非空，exitCode=null；
 * - 超时/取消 → 杀进程树，尽力等待退出（最多 5s 宽限），保证不挂住调用方。
 */
export async function runProcess(
  executable: string,
  argv: string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  const maxBytes = options.maxBufferBytes ?? 2 * 1024 * 1024;
  const stdoutBuffer: BoundedBuffer = { chunks: [], bytes: 0, truncated: false };
  const stderrBuffer: BoundedBuffer = { chunks: [], bytes: 0, truncated: false };

  let child;
  try {
    child = spawn(executable, argv, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv | undefined,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    return {
      pid: -1,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      aborted: false,
      spawnError: (error as Error).message,
    };
  }

  const pid = child.pid ?? -1;
  if (pid > 0) options.registry?.register(pid, options.label ?? executable);

  let timedOut = false;
  let aborted = false;
  let killed = false;
  let settled = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnError: string | null = null;

  let hardTimer: NodeJS.Timeout | null = null;
  let forceTimer: NodeJS.Timeout | null = null;

  const promise = new Promise<ProcessRunResult>((resolve) => {
    const finalize = (): void => {
      if (settled) return;
      settled = true;
      if (hardTimer !== null) clearTimeout(hardTimer);
      if (forceTimer !== null) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (pid > 0) options.registry?.unregister(pid);
      // 释放管道句柄，避免 browser daemon 继承的句柄拖住事件循环。
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        pid,
        exitCode,
        signal: exitSignal,
        stdout: bufferText(stdoutBuffer),
        stderr: bufferText(stderrBuffer),
        stdoutTruncated: stdoutBuffer.truncated,
        stderrTruncated: stderrBuffer.truncated,
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted,
        spawnError,
      });
    };

    const requestKill = (): void => {
      if (killed) return;
      killed = true;
      void killProcessTree(pid).then(() => {
        // taskkill /T 一般会在毫秒级返回；给 5s 宽限等待 exit，避免永久挂起。
        forceTimer = setTimeout(() => {
          finalize();
        }, 5_000);
        forceTimer.unref?.();
      });
    };

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      requestKill();
    };

    child.stdout?.on('data', (chunk: Buffer) => appendBounded(stdoutBuffer, chunk, maxBytes));
    child.stderr?.on('data', (chunk: Buffer) => appendBounded(stderrBuffer, chunk, maxBytes));

    child.on('error', (error) => {
      spawnError = error.message;
      // spawn 失败不会触发 exit，直接收尾。
      finalize();
    });

    // 只监听 exit，不监听 close（daemon 会继承管道导致 close 永不触发）。
    child.on('exit', (code, signalName) => {
      exitCode = code;
      exitSignal = signalName ?? null;
      finalize();
    });

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      hardTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        requestKill();
      }, options.timeoutMs);
      hardTimer.unref?.();
    }

    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  return promise;
}

/** 便捷：执行官方 CLI 并断言退出码（用于 --version 等只读探测）。 */
export async function runCliOrThrow(
  executable: string,
  argv: string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const result = await runProcess(executable, argv, options);
  if (result.spawnError !== null) {
    throw new AutomationError('NOT_IMPLEMENTED', `无法启动官方入口：${result.spawnError}`, {
      detail: { command: [executable, ...argv] },
    });
  }
  return result;
}