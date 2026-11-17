/**
 * 运行事件总线（SSE：GET /api/v1/runs/{runId}/events，api-contract §0.4 可选增强）。
 * 只做进程内 fan-out，不落库；轮询端点始终是 MUST，SSE 断线不影响状态一致性。
 */

import type { RunEventName } from '@pw-auto/contracts';

export interface RunEventFrame {
  event: RunEventName;
  data: unknown;
}

export type RunEventListener = (frame: RunEventFrame) => void;

export class RunEventBus {
  private readonly listeners = new Map<string, Set<RunEventListener>>();

  subscribe(runId: string, listener: RunEventListener): () => void {
    const set = this.listeners.get(runId) ?? new Set<RunEventListener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  publish(runId: string, event: RunEventName, data: unknown): void {
    const set = this.listeners.get(runId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener({ event, data });
      } catch {
        // 单个订阅者异常不得影响运行编排
      }
    }
  }

  listenerCount(runId: string): number {
    return this.listeners.get(runId)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}