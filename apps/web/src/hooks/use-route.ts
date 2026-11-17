import { useEffect, useState } from 'react';
import type { Route } from '../lib/hash-router.ts';
import { buildHref, parseRoute } from '../lib/hash-router.ts';

/** 监听 hashchange 的路由 hook（SSR 时退化为用例页） */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? { name: 'cases', query: {} } : parseRoute(window.location.hash),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

/** 导航：只改 hash，不整页刷新 */
export function navigate(path: string, query?: Record<string, string | number | boolean | null | undefined>): void {
  if (typeof window === 'undefined') return;
  window.location.hash = buildHref(path, query);
}

/** 文档标题（中文）；SSR 时跳过 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = title === '' ? 'pw-auto-framework' : `${title} · pw-auto-framework`;
  }, [title]);
}