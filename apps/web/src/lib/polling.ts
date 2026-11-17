/**
 * 运行轮询：与 api-contract §0.4/§0.5 的状态机一致。
 * - 建议退避 1s → 2s → 5s → 10s（之后固定 10s）
 * - 终态（passed/failed/cancelled/error）立即停止
 * - 错误（网络/后端暂不可达）不改变运行状态，只继续退避重试
 * 该模块为纯逻辑，方便单测（可注入 sleep 与 fetch 结果）。
 */
import { isTerminalRunStatus } from '@pw-auto/contracts';
import type { ApiErrorInfo, ApiResult } from '../api/http.ts';
import type { RunStatus } from '../api/types.ts';

export const RUN_POLL_DELAYS_MS = [1000, 2000, 5000, 10000] as const;
export const RUN_POLL_MAX_DELAY_MS = 10000;

export function nextPollDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) return RUN_POLL_DELAYS_MS[0] ?? 1000;
  const index = Math.min(attempt, RUN_POLL_DELAYS_MS.length - 1);
  return RUN_POLL_DELAYS_MS[index] ?? RUN_POLL_MAX_DELAY_MS;
}

export function isTerminalStatus(status: string): boolean {
  return isTerminalRunStatus(status as RunStatus);
}

/** 状态的中文类别（用于 UI 展示"排队中/运行中/已结束"） */
export function runPhase(status: string): 'queue' | 'active' | 'terminal' | 'unknown' {
  if (status === 'queued') return 'queue';
  if (status === 'running') return 'active';
  if (isTerminalStatus(status)) return 'terminal';
  return 'unknown';
}

export type PollStopReason = 'terminal' | 'max-attempts' | 'cancelled';

export interface PollOutcome<T> {
  data: T | null;
  error: ApiErrorInfo | null;
  attempts: number;
  stopReason: PollStopReason;
}

export interface PollRunOptions<T extends { status: RunStatus }> {
  fetchRun: () => Promise<ApiResult<T>>;
  /** 默认按 6 态状态机判断 */
  isTerminal?: (run: T) => boolean;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** 上限保护（测试/调试用），默认无限（由 signal 或终态结束） */
  maxAttempts?: number;
  onUpdate?: (result: ApiResult<T>, attempt: number) => void;
}

/**
 * 轮询一次运行直到终态。调用方负责在组件卸载时 abort（signal）。
 */
export async function pollRunUntilTerminal<T extends { status: RunStatus }>(
  options: PollRunOptions<T>,
): Promise<PollOutcome<T>> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isTerminal = options.isTerminal ?? ((run: T) => isTerminalStatus(run.status));
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;

  let lastData: T | null = null;
  let lastError: ApiErrorInfo | null = null;
  let attempts = 0;

  while (attempts < maxAttempts) {
    if (options.signal?.aborted) {
      return { data: lastData, error: lastError, attempts, stopReason: 'cancelled' };
    }
    const result = await options.fetchRun();
    attempts += 1;
    options.onUpdate?.(result, attempts - 1);

    if (result.ok) {
      lastData = result.data;
      lastError = null;
      if (isTerminal(result.data)) {
        return { data: lastData, error: null, attempts, stopReason: 'terminal' };
      }
    } else {
      lastError = result.error;
      if (result.error.code === 'CANCELLED') {
        return { data: lastData, error: lastError, attempts, stopReason: 'cancelled' };
      }
    }

    if (attempts >= maxAttempts) break;
    await sleep(nextPollDelayMs(attempts - 1));
  }

  return { data: lastData, error: lastError, attempts, stopReason: 'max-attempts' };
}

/** SSE 是否可作为增强（浏览器支持 + 后端声明可用）；否则纯轮询 */
export function canUseSse(hasEventSource: boolean, backendSseEnabled: boolean): boolean {
  return hasEventSource && backendSseEnabled;
}

/** SSE 事件名严格来自 api-contract §0.4（data 形态未定义，只用作刷新触发器） */
export const RUN_SSE_EVENTS = ['run.updated', 'item.updated', 'run.log', 'heartbeat'] as const;