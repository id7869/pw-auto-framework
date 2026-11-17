import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiErrorInfo, ApiResult } from '../api/http.ts';

export interface ApiResource<T> {
  data: T | null;
  error: ApiErrorInfo | null;
  loading: boolean;
  /** 重新请求（保留旧数据，用于手动刷新） */
  reload: () => void;
}

/**
 * 单资源加载：返回加载/错误/数据三态与重试入口。
 * deps 长度必须在多次渲染间保持稳定（与 useEffect 依赖一致）。
 */
export function useApiResource<T>(load: () => Promise<ApiResult<T>>, deps: readonly unknown[]): ApiResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiErrorInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void loadRef.current().then((result) => {
      if (!alive) return;
      if (result.ok) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
    // 依赖由调用方传入（长度稳定）；tick 用于手动 reload
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, loading, reload };
}