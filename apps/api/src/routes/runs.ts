/**
 * §5 运行与结果路由（含产物流式下载与 SSE）。
 *
 * 安全：产物内容只按「DB 登记 + 工作区前缀」定位（见 RunService.artifactFile），
 * 绝不按请求参数拼路径；支持单段 Range（大 trace/录屏可拖动播放）。
 */

import { createReadStream, statSync } from 'node:fs';
import {
  artifactListQuerySchema,
  createRunRequestSchema,
  runItemListQuerySchema,
  runListQuerySchema,
  type ArtifactListQuery,
  type CreateRunRequest,
  type RunItemListQuery,
  type RunListQuery,
} from '@pw-auto/contracts';
import { AppError } from '../errors.ts';
import { sendData } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { openSseStream } from '../http/sse.ts';
import type { AppServices } from '../services/container.ts';
import { idempotencyHeaders, idempotencyKeyOf, param } from './helpers.ts';

export function registerRunRoutes(router: Router, services: AppServices): void {
  router.post('/api/v1/runs', async (ctx) => {
    const key = idempotencyKeyOf(ctx);
    const body = await ctx.json<CreateRunRequest>(createRunRequestSchema);
    const result = services.runs.create(body, key, ctx.actor);
    sendData(ctx.res, result.replayed ? 200 : 202, result.run, ctx.requestId, idempotencyHeaders(key, result.replayed));
  });

  router.get('/api/v1/runs', (ctx) => {
    const query = ctx.query<RunListQuery>(runListQuerySchema);
    sendData(ctx.res, 200, services.runs.list(query), ctx.requestId);
  });

  router.get('/api/v1/runs/:runId', (ctx) => {
    sendData(ctx.res, 200, services.runs.requireRun(param(ctx, 'runId')), ctx.requestId);
  });

  router.post('/api/v1/runs/:runId/cancel', async (ctx) => {
    const result = await services.runs.cancel(param(ctx, 'runId'), ctx.actor);
    sendData(ctx.res, result.replayed ? 200 : 202, result.run, ctx.requestId);
  });

  router.get('/api/v1/runs/:runId/items', (ctx) => {
    const query = ctx.query<RunItemListQuery>(runItemListQuerySchema);
    sendData(ctx.res, 200, services.runs.items(param(ctx, 'runId'), query), ctx.requestId);
  });

  router.get('/api/v1/runs/:runId/items/:itemKey', (ctx) => {
    sendData(ctx.res, 200, services.runs.item(param(ctx, 'runId'), param(ctx, 'itemKey')), ctx.requestId);
  });

  router.get('/api/v1/runs/:runId/artifacts', (ctx) => {
    const query = ctx.query<ArtifactListQuery>(artifactListQuerySchema);
    sendData(ctx.res, 200, services.runs.artifacts(param(ctx, 'runId'), query), ctx.requestId);
  });

  router.get('/api/v1/runs/:runId/artifacts/:artifactId/content', (ctx) => {
    const { artifact, absolutePath } = services.runs.artifactFile(param(ctx, 'runId'), param(ctx, 'artifactId'));

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absolutePath);
    } catch {
      throw new AppError('NOT_FOUND', '产物已登记但磁盘文件缺失（可能被保留策略清理）');
    }
    if (!stat.isFile()) throw new AppError('NOT_FOUND', '产物不是普通文件');

    const headers: Record<string, string | number> = {
      'content-type': artifact.contentType,
      'cache-control': 'no-store',
      'x-request-id': ctx.requestId,
      'accept-ranges': 'bytes',
    };

    const range = ctx.header('range');
    if (range === undefined || range.trim() === '') {
      ctx.res.writeHead(200, { ...headers, 'content-length': stat.size });
      createReadStream(absolutePath).pipe(ctx.res);
      return;
    }

    const parsed = parseSingleRange(range, stat.size);
    if (parsed === null) {
      ctx.res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` });
      ctx.res.end();
      return;
    }
    ctx.res.writeHead(206, {
      ...headers,
      'content-length': parsed.end - parsed.start + 1,
      'content-range': `bytes ${parsed.start}-${parsed.end}/${stat.size}`,
    });
    createReadStream(absolutePath, { start: parsed.start, end: parsed.end }).pipe(ctx.res);
  });

  // SSE（可选增强）：轮询始终可用；断线不影响状态
  router.get('/api/v1/runs/:runId/events', (ctx) => {
    const runId = param(ctx, 'runId');
    const run = services.runs.requireRun(runId);

    let cleanup = (): void => {};
    const stream = openSseStream(ctx.res, ctx.requestId, () => cleanup());
    const unsubscribe = services.runs.subscribe(runId, (frame) => stream.send(frame.event, frame.data));
    const heartbeat = setInterval(() => stream.send('heartbeat', { at: new Date().toISOString() }), 15000);
    heartbeat.unref();
    cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    ctx.req.on('close', () => cleanup());
    stream.send('run.updated', run);
  });
}

/** 只支持单段 Range：`bytes=start-end`、`bytes=start-`、`bytes=-suffix` */
function parseSingleRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (startRaw === '' && endRaw === '') return null;

  let start: number;
  let end: number;
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Number(endRaw);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= size || start > end) return null;
  return { start, end: Math.min(end, size - 1) };
}