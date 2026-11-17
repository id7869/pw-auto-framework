import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiErrorInfo, ApiResult } from '../api/http.ts';
import type { PageResult } from '../api/types.ts';

export interface PagedList<T> {
  items: T[];
  loading: boolean;
  loadingMore: boolean;
  error: ApiErrorInfo | null;
  hasMore: boolean;
  nextCursor: string | null;
  reload: () => void;
  loadMore: () => void;
}

interface PagedState<T> {
  items: T[];
  loading: boolean;
  loadingMore: boolean;
  error: ApiErrorInfo | null;
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * 游标分页列表（api-contract §0：limit 1..100 + cursor → { items, nextCursor, hasMore }）。
 * 只实现「加载更多」，不回退上一页（游标分页不保存历史游标栈）。
 */
export function usePagedList<T>(
  fetchPage: (cursor: string | null) => Promise<ApiResult<PageResult<T>>>,
  deps: readonly unknown[],
): PagedList<T> {
  const [state, setState] = useState<PagedState<T>>({
    items: [],
    loading: true,
    loadingMore: false,
    error: null,
    hasMore: false,
    nextCursor: null,
  });
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestSeq = useRef(0);
  // deps 序列化：依赖变化时清空旧列表，避免展示上一个用例/筛选条件的数据
  const depsKey = JSON.stringify(deps);
  const prevDepsKey = useRef(depsKey);

  const loadFirst = useCallback(() => {
    const seq = ++requestSeq.current;
    setState((prev) => ({ ...prev, loading: true, loadingMore: false, error: null }));
    void fetchRef.current(null).then((result) => {
      if (seq !== requestSeq.current) return;
      if (result.ok) {
        setState({
          items: result.data.items,
          nextCursor: result.data.nextCursor,
          hasMore: result.data.hasMore,
          loading: false,
          loadingMore: false,
          error: null,
        });
      } else {
        setState((prev) => ({ ...prev, loading: false, loadingMore: false, error: result.error }));
      }
    });
  }, []);

  useEffect(() => {
    if (prevDepsKey.current !== depsKey) {
      prevDepsKey.current = depsKey;
      requestSeq.current += 1;
      setState((prev) => ({ ...prev, items: [], nextCursor: null, hasMore: false }));
    }
    loadFirst();
  }, [depsKey, tick, loadFirst]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (current.loading || current.loadingMore || !current.hasMore || current.nextCursor === null) return;
    const cursor = current.nextCursor;
    const seq = ++requestSeq.current;
    setState((prev) => ({ ...prev, loadingMore: true, error: null }));
    void fetchRef.current(cursor).then((result) => {
      if (seq !== requestSeq.current) return;
      if (result.ok) {
        setState((prev) => ({
          ...prev,
          items: [...prev.items, ...result.data.items],
          nextCursor: result.data.nextCursor,
          hasMore: result.data.hasMore,
          loadingMore: false,
        }));
      } else {
        setState((prev) => ({ ...prev, loadingMore: false, error: result.error }));
      }
    });
  }, []);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  return { ...state, reload, loadMore };
}