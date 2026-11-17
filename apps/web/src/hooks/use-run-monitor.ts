/**
 * 运行监控：轮询（api-contract §0.4 的 MUST）+ 可选 SSE 增强。
 * - 轮询退避 1s→2s→5s→10s，终态停止；轮询失败时保留最后状态并提示"状态未知，正在重试"
 * - SSE 仅在 /api/v1/meta 的 capabilities.sse=true 时启用，事件只作为"立即刷新"触发器
 *   （合同只定义了事件名，未定义 data 形态，因此不解析 payload，避免虚构协议）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../api/context.tsx';
import type { ApiErrorInfo } from '../api/http.ts';
import type { Run } from '../api/types.ts';
import { useApiResource } from './use-api-resource.ts';
import { RUN_SSE_EVENTS, isTerminalStatus, pollRunUntilTerminal } from '../lib/polling.ts';

export type SseState = 'off' | 'connecting' | 'open' | 'failed';

export interface RunMonitorState {
  run: Run | null;
  loading: boolean;
  /** 最近一次轮询的错误（有 run 时表示"状态未知，正在重试"） */
  error: ApiErrorInfo | null;
  sse: SseState;
  refresh: () => void;
}

export function useRunMonitor(runId: string | null): RunMonitorState {
  const api = useApi();
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(runId !== null);
  const [error, setError] = useState<ApiErrorInfo | null>(null);
  const [sse, setSse] = useState<SseState>('off');
  const runRef = useRef<Run | null>(null);
  runRef.current = run;

  const meta = useApiResource(() => api.meta(), []);
  const sseEnabled = meta.data?.capabilities.sse === true;

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRun(null);

    void pollRunUntilTerminal<Run>({
      fetchRun: () => api.getRun(runId),
      signal: controller.signal,
      onUpdate: (result) => {
        if (cancelled) return;
        setLoading(false);
        if (result.ok) {
          setRun(result.data);
          setError(null);
        } else {
          setError(result.error);
        }
      },
    }).then((outcome) => {
      if (cancelled) return;
      setLoading(false);
      if (outcome.data) setRun(outcome.data);
      if (outcome.error) setError(outcome.error);
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, runId]);

  const refresh = useCallback(() => {
    if (!runId) return;
    void api.getRun(runId).then((result) => {
      if (result.ok) {
        setRun(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
    });
  }, [api, runId]);

  const terminal = run !== null && isTerminalStatus(run.status);

  useEffect(() => {
    if (!runId || !sseEnabled || typeof EventSource === 'undefined' || terminal) {
      setSse('off');
      return;
    }
    const source = new EventSource(api.runEventsUrl(runId));
    setSse('connecting');
    const onOpen = (): void => setSse('open');
    const onError = (): void => {
      setSse('failed');
      source.close();
    };
    const onSignal = (): void => refresh();
    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);
    for (const eventName of RUN_SSE_EVENTS) source.addEventListener(eventName, onSignal);
    return () => {
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onError);
      for (const eventName of RUN_SSE_EVENTS) source.removeEventListener(eventName, onSignal);
      source.close();
    };
  }, [api, refresh, runId, sseEnabled, terminal]);

  return { run, loading, error, sse, refresh };
}