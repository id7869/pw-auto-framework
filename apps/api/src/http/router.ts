/**
 * 请求上下文与最小路由（architecture §3.3：方法 + 精确路径 + `:param`）。
 *
 * 设计要点：
 * - 路由表集中注册；未匹配 → 404 NOT_FOUND；路径存在但方法不允许 → 405（带 Allow 头）；
 * - `ctx.json(schema)` / `ctx.query(schema)` 内部走 zod，失败统一 422 VALIDATION_FAILED（中文 details）；
 * - 请求体只读一次并缓存；Content-Type/大小校验在首次读取时完成。
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ErrorDetail } from '@pw-auto/contracts';
import { AppError } from '../errors.ts';
import { assertJsonContentType, parseJsonBody, readRawBody } from './body.ts';

export interface Parseable {
  parse(input: unknown): unknown;
}

export function parseSchema<T>(schema: Parseable, value: unknown, label: string): T {
  try {
    return schema.parse(value) as T;
  } catch (error) {
    const issues = (error as { issues?: { path?: unknown[]; message?: string }[] }).issues;
    if (Array.isArray(issues)) {
      const details: ErrorDetail[] = issues.map((issue) => ({
        path: (issue.path ?? []).map((segment) => String(segment)).join('.') || '(root)',
        message: issue.message ?? '格式不正确',
      }));
      throw new AppError('VALIDATION_FAILED', `${label}校验失败：${details[0]?.message ?? '格式不正确'}`, details);
    }
    throw error;
  }
}

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly requestId: string;
  readonly actor: string;
  json<T>(schema: Parseable): Promise<T>;
  query<T>(schema: Parseable): T;
  header(name: string): string | undefined;
  /** 已读请求体的原始字节（写审计/幂等哈希时可用） */
  rawBody(): Promise<Buffer>;
}

export interface RequestContextOptions {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  requestId: string;
  bodyLimitBytes: number;
}

export function createRequestContext(options: RequestContextOptions): RequestContext {
  let bodyPromise: Promise<Buffer> | null = null;
  let cachedBody: Buffer | null = null;

  const rawBody = (): Promise<Buffer> => {
    if (bodyPromise === null) {
      bodyPromise = readRawBody(options.req, options.bodyLimitBytes).then((buffer) => {
        cachedBody = buffer;
        return buffer;
      });
    }
    return bodyPromise;
  };

  const actorHeader = options.req.headers['x-actor'];
  const actor = typeof actorHeader === 'string' && actorHeader.trim() !== '' ? actorHeader.trim().slice(0, 80) : 'user';

  return {
    req: options.req,
    res: options.res,
    method: options.req.method ?? 'GET',
    url: options.url,
    params: options.params,
    requestId: options.requestId,
    actor,
    header(name: string): string | undefined {
      const value = options.req.headers[name.toLowerCase()];
      if (Array.isArray(value)) return value[0];
      return value;
    },
    rawBody,
    async json<T>(schema: Parseable): Promise<T> {
      const buffer = await rawBody();
      assertJsonContentType(options.req, buffer.byteLength > 0 || cachedBody !== null);
      const parsed = parseJsonBody(buffer);
      return parseSchema<T>(schema, parsed, '请求参数');
    },
    query<T>(schema: Parseable): T {
      const raw: Record<string, string> = {};
      for (const [key, value] of options.url.searchParams) {
        if (!(key in raw)) raw[key] = value;
      }
      return parseSchema<T>(schema, raw, '查询参数');
    },
  };
}

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'OPTIONS';

export type RouteHandler = (ctx: RequestContext) => Promise<void> | void;

interface RouteEntry {
  method: HttpMethod;
  segments: string[];
  handler: RouteHandler;
}

export type RouteResolution =
  | { type: 'match'; handler: RouteHandler; params: Record<string, string> }
  | { type: 'method-not-allowed'; allowed: HttpMethod[] }
  | { type: 'not-found' };

function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new AppError('INVALID_PATH', `路径中存在非法转义：${segment}`);
      }
    });
}

export class Router {
  private readonly routes: RouteEntry[] = [];

  add(method: HttpMethod, pattern: string, handler: RouteHandler): void {
    this.routes.push({ method, segments: splitPath(pattern), handler });
  }

  get(pattern: string, handler: RouteHandler): void {
    this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): void {
    this.add('POST', pattern, handler);
  }

  patch(pattern: string, handler: RouteHandler): void {
    this.add('PATCH', pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): void {
    this.add('PUT', pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): void {
    this.add('DELETE', pattern, handler);
  }

  resolve(method: string, pathname: string): RouteResolution {
    const requested = splitPath(pathname);
    const allowed = new Set<HttpMethod>();

    for (const route of this.routes) {
      const params = matchSegments(route.segments, requested);
      if (params === null) continue;
      if (route.method === method) return { type: 'match', handler: route.handler, params };
      allowed.add(route.method);
    }
    if (allowed.size > 0) return { type: 'method-not-allowed', allowed: [...allowed].sort() };
    return { type: 'not-found' };
  }

  /** 某路径是否已注册（供 404/405 判定与调试） */
  hasPath(pathname: string): boolean {
    const requested = splitPath(pathname);
    return this.routes.some((route) => matchSegments(route.segments, requested) !== null);
  }
}

function matchSegments(pattern: string[], requested: string[]): Record<string, string> | null {
  if (pattern.length !== requested.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i];
    const actual = requested[i];
    if (expected === undefined || actual === undefined) return null;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = actual;
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export type HttpServer = Server;