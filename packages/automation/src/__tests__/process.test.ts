import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  isProcessAlive,
  killProcessTree,
  ProcessRegistry,
  runProcess,
} from '../index.ts';

describe('process/process-tree · 子进程与进程树清理', () => {
  it('捕获 stdout/stderr/退出码，不因非零退出而抛错', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', "process.stdout.write('out');process.stderr.write('err');process.exitCode=3"],
      { timeoutMs: 30_000 },
    );
    expect(result.spawnError).toBeNull();
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('超时 → taskkill /F /T 并返回 timedOut，不挂起调用方', async () => {
    const startedAt = Date.now();
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      timeoutMs: 600,
      label: 'timeout-test',
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    if (result.pid > 0) {
      expect(isProcessAlive(result.pid)).toBe(false);
    }
  });

  it('AbortSignal → aborted，进程被清理', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      signal: controller.signal,
    });
    clearTimeout(timer);
    expect(result.aborted).toBe(true);
    if (result.pid > 0) expect(isProcessAlive(result.pid)).toBe(false);
  });

  it('spawn 失败返回 spawnError（由上层映射 NOT_IMPLEMENTED/SUBPROCESS_ERROR）', async () => {
    const result = await runProcess('C:\\definitely-not-exists\\pw-auto-no-such-binary.exe', [], {
      timeoutMs: 5_000,
    });
    expect(result.spawnError).not.toBeNull();
    expect(result.exitCode).toBeNull();
  });

  it('ProcessRegistry 登记/注销，killAll 清理', async () => {
    const registry = new ProcessRegistry();
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      registry,
      timeoutMs: 500,
      label: 'registry-test',
    });
    expect(result.timedOut).toBe(true);
    expect(registry.size()).toBe(0);
    expect(registry.list()).toEqual([]);

    // 直接登记一个真实进程后 killAll。
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (child.pid !== undefined) {
      registry.register(child.pid, 'manual');
      expect(registry.size()).toBe(1);
      await registry.killAll();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(isProcessAlive(child.pid)).toBe(false);
    }
  });

  it('killProcessTree 可直接终止进程树', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (child.pid !== undefined) {
      await killProcessTree(child.pid);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(isProcessAlive(child.pid)).toBe(false);
    }
  });
});