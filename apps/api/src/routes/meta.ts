/**
 * §1 健康与元信息路由。
 * - `GET /api/health`（webServer 探活，例外不带 v1）
 * - `GET /api/v1/meta`（前端设置页 / e2e 断言）
 */

import { AGENT_ENTRIES, APP_NAME, APP_VERSION, type HealthResponse, type MetaResponse } from '@pw-auto/contracts';
import { BODY_LIMIT_BYTES } from '../config.ts';
import { sendData } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { metaVersionFields } from '../official.ts';
import type { AppServices } from '../services/container.ts';

const startedAt = Date.now();

export function registerMetaRoutes(router: Router, services: AppServices): void {
  router.get('/api/health', (ctx) => {
    const db = services.healthCheck();
    const payload: HealthResponse = {
      status: db === 'ok' ? 'ok' : 'degraded',
      uptimeMs: Date.now() - startedAt,
      db,
      version: APP_VERSION,
    };
    sendData(ctx.res, 200, payload, ctx.requestId);
  });

  router.get('/api/v1/meta', (ctx) => {
    const config = services.config;
    // 启动时已探测并缓存（createServices 预热）；这里只读缓存，不重复 spawn 子进程。
    // 版本来源（cli|fallback）与失败原因由 metaVersionFields 统一构造，fallback 时必带 playwrightVersionError。
    const versionFields = metaVersionFields(services.playwrightInfo);
    const payload: MetaResponse = {
      app: { name: APP_NAME },
      versions: {
        node: process.versions.node,
        ...versionFields,
        browser: { name: config.browser },
        os: `${process.platform}-${process.arch}-${process.release?.name ?? 'unknown'}`,
      },
      limits: {
        runTimeoutMs: config.runTimeoutMs,
        caseTimeoutMs: config.caseTimeoutMs,
        maxConcurrentRuns: config.maxConcurrentRuns,
        keepRuns: config.keepRuns,
        bodyLimitBytes: BODY_LIMIT_BYTES,
      },
      env: {
        bindHost: config.bindHost,
        port: config.port,
        dataDir: config.dataDir,
        // 前端类型为 string；未启用静态托管时给空串（不虚构路径）
        staticDir: config.staticDir ?? '',
        corsOrigins: [...config.corsOrigins],
      },
      capabilities: {
        mcp: { enabled: services.surfaces.mcp !== null, sessions: services.mcp.activeSessionCount() },
        cli: { enabled: services.surfaces.cli !== null, unsafeEnabled: config.enableUnsafeTools },
        agents: { entries: [...AGENT_ENTRIES] },
        sse: true,
        unsafeTools: config.enableUnsafeTools,
      },
    };
    sendData(ctx.res, 200, payload, ctx.requestId);
  });
}