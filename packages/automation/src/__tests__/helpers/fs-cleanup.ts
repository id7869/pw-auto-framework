import { rmSync } from 'node:fs';

/**
 * 删除测试临时目录（t14 集成期最小修复，仅测试清理，不改变任何断言/产品行为）。
 *
 * 背景：Windows 上 Chromium/MCP/CLI 子进程退出后，文件句柄释放有延迟；
 * 取消/超时类用例在 afterEach/afterAll 立即 `rmSync` 会偶发
 * `EPERM: Permission denied`（t14 实测 engine.integration「AbortSignal 取消」，
 * 用例主体通过、清理阶段失败）。这里只对「可重试」错误做短退避重试，
 * 超过预算仍失败则抛出——既避免噪音 flake，也不掩盖真实泄漏。
 */
export async function removeDirWithRetry(dir: string, attempts = 30, delayMs = 100): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EACCES';
      if (!retryable || index === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}