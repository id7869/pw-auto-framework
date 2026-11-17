/**
 * 执行引擎装配（官方承重由 packages/automation 提供；本文件只做装配与失败原因记录）。
 *
 * 纪律：apps/api **不 spawn 子进程、不 import Playwright**，只通过 ExecutionEngine 接口调用。
 * 单测注入 fake 引擎；真实引擎由 t7 在 `@pw-auto/automation` 的 `createEngine()` 中交付。
 */

import { createEngine, type ExecutionEngine } from '@pw-auto/automation';

export interface EngineHandle {
  engine: ExecutionEngine | null;
  /** 不可用原因（中文，进入 /api/meta 与运行错误信息） */
  reason: string | null;
}

export function bootstrapEngine(): EngineHandle {
  try {
    const engine = createEngine();
    if (
      !engine ||
      typeof engine.run !== 'function' ||
      typeof engine.cancel !== 'function' ||
      typeof engine.compile !== 'function'
    ) {
      return { engine: null, reason: '执行引擎接口不完整（缺少 run/cancel/compile）' };
    }
    return { engine, reason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { engine: null, reason: `执行引擎初始化失败：${message}` };
  }
}

export function unavailableEngine(reason: string): EngineHandle {
  return { engine: null, reason };
}