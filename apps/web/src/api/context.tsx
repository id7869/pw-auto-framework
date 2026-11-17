import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { Api } from './endpoints.ts';
import { defaultApi } from './endpoints.ts';

const ApiContext = createContext<Api | null>(null);

export function ApiProvider({ api, children }: { api: Api; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

/** 页面统一从上下文取 API；未包裹 Provider 视为编码错误 */
export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error('缺少 ApiProvider：页面必须在 <ApiProvider> 内渲染');
  return api;
}

export { defaultApi };