/**
 * HTTP 客户端：严格按 docs/api-contract.md §0 实现。
 * - 成功信封 `{ data, meta? }` → 只把 `data` 交给调用方
 * - 错误信封 `{ error: { code, message, details?, requestId } }` → 结构化中文错误
 * - GET 自动重试 2 次（网络错误 / 超时 / 5xx），15 秒超时
 * - 204 视为成功且无内容
 *
 * 该模块不依赖 DOM/localStorage，可在 Node 环境下被 vitest 直接测试。
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface ApiErrorDetail {
  path: string;
  message: string;
}

export interface ApiErrorInfo {
  /** 固定错误码（api-contract §10）；网络/超时等前端侧错误使用大写常量 */
  code: string;
  /** 中文可展示文案 */
  message: string;
  details?: ApiErrorDetail[];
  requestId?: string;
  httpStatus?: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiErrorInfo };

export interface ApiRequestOptions {
  method?: HttpMethod;
  body?: unknown;
  query?: QueryParams;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 仅对幂等请求（GET）生效；默认取客户端配置的 2 次 */
  retries?: number;
}

export interface ApiClientOptions {
  /** 同源部署时留空；开发态由 Vite 代理 /api */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  getRetries?: number;
  retryDelayMs?: number;
  /** 便于单测注入（默认真实 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_GET_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 400;

/** HTTP 状态码兜底文案（后端未给 message 时使用） */
export const HTTP_STATUS_MESSAGES: Record<number, string> = {
  400: '请求格式不正确',
  403: '操作被拒绝（能力未启用或路径受控）',
  404: '资源不存在或已删除',
  405: '接口不支持该请求方法',
  409: '存在冲突（版本或幂等键不一致）',
  413: '请求体过大',
  415: '请求内容类型不受支持',
  422: '提交内容未通过校验',
  428: '该操作需要二次确认',
  429: '请求过于频繁或排队已满，请稍后再试',
  500: '服务器内部错误',
  501: '该能力尚未实现',
  502: '官方子进程或执行引擎出错',
  504: '调用超时，请稍后重试',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDetails(value: unknown): ApiErrorDetail[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const details: ApiErrorDetail[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item['path'] === 'string' && typeof item['message'] === 'string') {
      details.push({ path: item['path'], message: item['message'] });
    }
  }
  return details.length > 0 ? details : undefined;
}

function isRetriable(error: ApiErrorInfo): boolean {
  if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') return true;
  const status = error.httpStatus;
  return status !== undefined && status >= 500 && status !== 501;
}

function cancelledError(): ApiErrorInfo {
  return { code: 'CANCELLED', message: '请求已取消' };
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getRetries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/u, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.getRetries = options.getRetries ?? DEFAULT_GET_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get<T>(path: string, options: Omit<ApiRequestOptions, 'method'> = {}): Promise<ApiResult<T>> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options: Omit<ApiRequestOptions, 'method' | 'body'> = {}): Promise<ApiResult<T>> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown, options: Omit<ApiRequestOptions, 'method' | 'body'> = {}): Promise<ApiResult<T>> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  put<T>(path: string, body?: unknown, options: Omit<ApiRequestOptions, 'method' | 'body'> = {}): Promise<ApiResult<T>> {
    return this.request<T>(path, { ...options, method: 'PUT', body });
  }

  /** DELETE 成功通常是 204，返回 void */
  delete<T = void>(path: string, options: Omit<ApiRequestOptions, 'method'> = {}): Promise<ApiResult<T>> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResult<T>> {
    const method = options.method ?? 'GET';
    const retryBudget = options.retries ?? (method === 'GET' ? this.getRetries : 0);
    const url = this.buildUrl(path, options.query);

    let lastError: ApiErrorInfo | null = null;
    for (let attempt = 0; attempt <= retryBudget; attempt += 1) {
      if (options.signal?.aborted) return { ok: false, error: cancelledError() };
      const result = await this.attempt<T>(url, method, options);
      if (result.ok) return result;
      lastError = result.error;
      const canRetry =
        attempt < retryBudget &&
        isRetriable(result.error) &&
        (options.signal === undefined || !options.signal.aborted);
      if (!canRetry) return result;
      await this.sleep(this.retryDelayMs * (attempt + 1));
    }
    return { ok: false, error: lastError ?? { code: 'UNKNOWN_ERROR', message: '请求失败，请稍后重试' } };
  }

  /** 拼接查询串（跳过 undefined/null/空字符串，见合同 §0） */
  buildUrl(path: string, query?: QueryParams): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const base = this.baseUrl;
    if (!query) return `${base}${normalized}`;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && value === '') continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `${base}${normalized}?${qs}` : `${base}${normalized}`;
  }

  private async attempt<T>(url: string, method: HttpMethod, options: ApiRequestOptions): Promise<ApiResult<T>> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const external = options.signal;
    const onExternalAbort = (): void => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort);
    }

    try {
      const headers = new Headers(options.headers ?? {});
      headers.set('Accept', 'application/json');
      let body: string | undefined;
      if (options.body !== undefined) {
        headers.set('Content-Type', 'application/json; charset=utf-8');
        body = JSON.stringify(options.body);
      }

      const response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        cache: 'no-store',
      });
      return await this.toResult<T>(response);
    } catch {
      if (timedOut) {
        return {
          ok: false,
          error: { code: 'TIMEOUT', message: `请求超时（${Math.round(this.timeoutMs / 1000)} 秒），请稍后重试` },
        };
      }
      if (external?.aborted) return { ok: false, error: cancelledError() };
      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: '无法连接后端服务，请确认 API 已启动（开发态默认 http://127.0.0.1:8787）',
        },
      };
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    }
  }

  private async toResult<T>(response: Response): Promise<ApiResult<T>> {
    if (response.status === 204) {
      return { ok: true, data: undefined as unknown as T };
    }
    const text = await response.text();
    let parsed: unknown;
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) {
          return {
            ok: false,
            error: {
              code: 'INVALID_RESPONSE',
              message: '后端返回了非 JSON 响应，无法解析',
              httpStatus: response.status,
            },
          };
        }
      }
    }

    if (!response.ok) {
      return { ok: false, error: this.parseError(parsed, response.status) };
    }

    const data = isRecord(parsed) && 'data' in parsed ? parsed['data'] : parsed;
    return { ok: true, data: data as T };
  }

  private parseError(parsed: unknown, status: number): ApiErrorInfo {
    const fallbackMessage = HTTP_STATUS_MESSAGES[status] ?? `请求失败（HTTP ${status}）`;
    if (isRecord(parsed)) {
      const envelope = parsed['error'];
      if (isRecord(envelope)) {
        const code = typeof envelope['code'] === 'string' && envelope['code'] !== '' ? envelope['code'] : `HTTP_${status}`;
        const message =
          typeof envelope['message'] === 'string' && envelope['message'] !== '' ? envelope['message'] : fallbackMessage;
        const requestId = typeof envelope['requestId'] === 'string' ? envelope['requestId'] : undefined;
        const details = parseDetails(envelope['details']);
        return { code, message, details, requestId, httpStatus: status };
      }
    }
    return { code: `HTTP_${status}`, message: fallbackMessage, httpStatus: status };
  }
}

/** 生成幂等键（api-contract §0.3）；非安全上下文时降级为随机串 */
export function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `pw-${cryptoApi.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2);
  return `pw-${Date.now().toString(36)}-${random}`;
}
