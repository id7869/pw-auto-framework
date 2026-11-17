/**
 * HTTP 应用装配（唯一 server 创建点）。
 *
 * 处理链：requestId → CORS → OPTIONS → 静态托管（可选）→ 路由 → 统一错误信封 → 日志。
 * 约束（architecture §3.3）：不使用 Web 框架；请求体 JSON only 且 ≤ 1 MiB；
 * 校验失败 422；未知路径 404；方法不允许 405（带 Allow）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ExecutionEngine } from '@pw-auto/automation';
import type { SurfaceBundle } from '@pw-auto/contracts';
import { loadConfig, type AppConfig } from './config.ts';
import { AppError, isAppError } from './errors.ts';
import { sendError, type ResponseHeaders } from './http/respond.ts';
import { createRequestContext, newRequestId, Router } from './http/router.ts';
import { tryServeStatic } from './http/static.ts';
import { registerCaseRoutes } from './routes/cases.ts';
import { registerMetaRoutes } from './routes/meta.ts';
import { registerNlRoutes } from './routes/nl.ts';
import { registerRegressionRoutes } from './routes/regression.ts';
import { registerRunRoutes } from './routes/runs.ts';
import { registerSurfaceRoutes } from './routes/surfaces.ts';
import { registerSuiteRoutes } from './routes/suites.ts';
import { createConsoleLogger, createServices, type AppServices, type Logger } from './services/container.ts';

export interface AppOptions {
  /** 显式配置（测试用临时 dataDir）；缺省按环境变量加载 */
  config?: AppConfig;
  /** 显式环境变量（便于测试） */
  env?: NodeJS.ProcessEnv;
  /** 注入执行引擎（null = 不可用；undefined = 按 automation 包装配） */
  engine?: ExecutionEngine | null;
  /** 注入官方能力适配面 */
  surfaces?: SurfaceBundle;
  logger?: Logger;
  /** 覆盖官方 CLI 路径（测试注入无效路径以验证 meta fallback 语义） */
  playwrightCliPath?: string;
  /** 覆盖 CORS 白名单（默认取 config.corsOrigins） */
  corsOrigins?: readonly string[];
}

export interface Application {
  server: Server;
  services: AppServices;
  config: AppConfig;
  close(): Promise<void>;
}

function applyCors(req: IncomingMessage, res: ServerResponse, origins: readonly string[]): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,idempotency-key,if-match,x-actor,range');
    res.setHeader('access-control-expose-headers', 'x-request-id,idempotent-replay,content-range,accept-ranges,allow');
  }
}

function logError(logger: Logger, requestId: string, error: unknown): void {
  if (error instanceof Error) {
    logger('error', `requestId=${requestId} ${error.stack ?? error.message}`);
    return;
  }
  logger('error', `requestId=${requestId} ${String(error)}`);
}

export function createApplication(options: AppOptions = {}): Application {
  const config = options.config ?? loadConfig(options.env ?? process.env);
  const logger = options.logger ?? createConsoleLogger(config.logLevel);
  const handle = createServices({
    config,
    engine: options.engine,
    surfaces: options.surfaces,
    logger,
    ...(options.playwrightCliPath === undefined ? {} : { playwrightCliPath: options.playwrightCliPath }),
  });

  const router = new Router();
  registerMetaRoutes(router, handle.services);
  registerCaseRoutes(router, handle.services);
  registerNlRoutes(router, handle.services);
  registerSuiteRoutes(router, handle.services);
  registerRunRoutes(router, handle.services);
  registerRegressionRoutes(router, handle.services);
  registerSurfaceRoutes(router, handle.services);

  const corsOrigins = options.corsOrigins ?? config.corsOrigins;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = newRequestId();
    applyCors(req, res, corsOrigins);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'x-request-id': requestId, 'cache-control': 'no-store' });
      res.end();
      return;
    }

    let pathname = '/';
    let rawPath = '/';
    let url: URL;
    try {
      const rawUrl = req.url ?? '/';
      // 静态层用「未归一化的原始路径」判穿越，避免 URL 归一化把 `../` 吃掉后失去证据
      rawPath = rawUrl.startsWith('/') ? (rawUrl.split('?')[0] ?? '/') : rawUrl;
      url = new URL(rawUrl, 'http://127.0.0.1');
      pathname = url.pathname;
    } catch {
      sendError(res, 'INVALID_PATH', '请求路径非法（无法解析为 URL）', requestId);
      return;
    }

    if (config.staticDir && tryServeStatic(req, res, config.staticDir, rawPath, requestId)) return;

    const method = req.method ?? 'GET';
    let resolution;
    try {
      resolution = router.resolve(method, pathname);
    } catch (error) {
      if (isAppError(error)) {
        sendError(res, error.code, error.message, requestId, error.details);
      } else {
        logError(logger, requestId, error);
        sendError(res, 'INTERNAL_ERROR', '服务器内部错误（已记录日志）', requestId);
      }
      return;
    }

    if (resolution.type === 'not-found') {
      sendError(res, 'NOT_FOUND', `接口不存在：${method} ${pathname}`, requestId);
      return;
    }
    if (resolution.type === 'method-not-allowed') {
      const allow = resolution.allowed.join(', ');
      const extra: ResponseHeaders = { allow };
      sendError(res, 'METHOD_NOT_ALLOWED', `该端点仅支持：${allow}`, requestId, undefined, extra);
      return;
    }

    const ctx = createRequestContext({
      req,
      res,
      url,
      params: resolution.params,
      requestId,
      bodyLimitBytes: config.bodyLimitBytes,
    });

    try {
      await resolution.handler(ctx);
    } catch (error) {
      if (res.headersSent) {
        // SSE/流式响应已开始，无法再写错误信封：直接断开，避免半截响应
        try {
          res.destroy();
        } catch {
          // 忽略重复销毁
        }
        if (!isAppError(error)) logError(logger, requestId, error);
        return;
      }
      if (isAppError(error)) {
        sendError(res, error.code, error.message, requestId, error.details);
        logger('warn', `requestId=${requestId} ${error.code} ${error.message}`);
        return;
      }
      logError(logger, requestId, error);
      sendError(res, 'INTERNAL_ERROR', '服务器内部错误（已记录日志）', requestId);
    }
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        try {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误', requestId: 'req_unhandled' } }));
        } catch {
          // 忽略
        }
      }
      if (!isAppError(error)) logError(logger, 'req_unhandled', error);
    });
  });

  return {
    server,
    services: handle.services,
    config,
    close: async () => {
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        // 长连接（SSE）不会自动关闭，给 3s 宽限后强制断开
        setTimeout(() => resolve(), 3000).unref();
      });
      await handle.close();
    },
  };
}

/** 兼容旧骨架的便捷工厂（只返回 Server；需要关闭 DB 请用 createApplication） */
export function createApp(options: AppOptions = {}): Server {
  return createApplication(options).server;
}

export function errorEnvelopeFor(error: AppError, requestId: string): Record<string, unknown> {
  return { error: { code: error.code, message: error.message, details: error.details, requestId } };
}