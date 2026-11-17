/**
 * §12 NL 用例与生成任务路由（R6）。
 *
 * 端点：
 * - GET/PUT/DELETE /api/v1/cases/{caseId}/nl
 * - POST/GET      /api/v1/cases/{caseId}/nl/generations
 * - GET           /api/v1/cases/{caseId}/nl/generations/{generationId}
 * - GET           /api/v1/nl/generations（harness 领取队列）
 * - POST          /api/v1/nl/generations/{generationId}/claim|submit
 * - POST          /api/v1/cases/{caseId}/nl/generations/{generationId}/accept|reject|cancel
 * - GET           /api/v1/cases/{caseId}/spec?preview=1（只读编译预览）
 *
 * 纪律：本路由不提供任何 skill 安装端点；不写 harness skills 目录。
 */

import {
  acceptNlGenerationRequestSchema,
  claimNlGenerationRequestSchema,
  createNlGenerationRequestSchema,
  nlGenerationListQuerySchema,
  nlGenerationQueueQuerySchema,

  putNlRequestSchema,
  rejectNlGenerationRequestSchema,
  submitNlGenerationRequestSchema,
  type AcceptNlGenerationRequest,
  type ClaimNlGenerationRequest,
  type CreateNlGenerationRequest,
  type NlGenerationListQuery,
  type NlGenerationQueueQuery,
  type PutNlRequest,
  type RejectNlGenerationRequest,
  type SubmitNlGenerationRequest,
} from '@pw-auto/contracts';
import { AppError } from '../errors.ts';
import { sendData, sendNoContent } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import type { AppServices } from '../services/container.ts';
import { param } from './helpers.ts';

export function registerNlRoutes(router: Router, services: AppServices): void {
  router.get('/api/v1/cases/:caseId/nl', (ctx) => {
    sendData(ctx.res, 200, services.nl.get(param(ctx, 'caseId')), ctx.requestId);
  });

  router.put('/api/v1/cases/:caseId/nl', async (ctx) => {
    const body = await ctx.json<PutNlRequest>(putNlRequestSchema);
    sendData(ctx.res, 200, services.nl.put(param(ctx, 'caseId'), body.text, ctx.actor), ctx.requestId);
  });

  router.delete('/api/v1/cases/:caseId/nl', (ctx) => {
    services.nl.remove(param(ctx, 'caseId'), ctx.actor);
    sendNoContent(ctx.res, ctx.requestId);
  });

  // ── 生成任务 ────────────────────────────────────────────────────────────

  router.post('/api/v1/cases/:caseId/nl/generations', async (ctx) => {
    const body = await ctx.json<CreateNlGenerationRequest>(createNlGenerationRequestSchema);
    const created = services.nlGenerations.create(param(ctx, 'caseId'), body, ctx.actor);
    sendData(ctx.res, 202, created, ctx.requestId);
  });

  router.get('/api/v1/cases/:caseId/nl/generations', (ctx) => {
    const query = ctx.query<NlGenerationListQuery>(nlGenerationListQuerySchema);
    sendData(ctx.res, 200, services.nlGenerations.listForCase(param(ctx, 'caseId'), query), ctx.requestId);
  });

  router.get('/api/v1/cases/:caseId/nl/generations/:generationId', (ctx) => {
    const generation = services.nlGenerations.require(param(ctx, 'caseId'), param(ctx, 'generationId'));
    sendData(ctx.res, 200, generation, ctx.requestId);
  });

  router.get('/api/v1/nl/generations', (ctx) => {
    const query = ctx.query<NlGenerationQueueQuery>(nlGenerationQueueQuerySchema);
    sendData(ctx.res, 200, services.nlGenerations.queue(query), ctx.requestId);
  });

  router.post('/api/v1/nl/generations/:generationId/claim', async (ctx) => {
    const body = await ctx.json<ClaimNlGenerationRequest>(claimNlGenerationRequestSchema);
    sendData(ctx.res, 200, services.nlGenerations.claim(param(ctx, 'generationId'), body, ctx.actor), ctx.requestId);
  });

  router.post('/api/v1/nl/generations/:generationId/submit', async (ctx) => {
    const body = await ctx.json<SubmitNlGenerationRequest>(submitNlGenerationRequestSchema);
    sendData(ctx.res, 200, services.nlGenerations.submit(param(ctx, 'generationId'), body, ctx.actor), ctx.requestId);
  });

  router.post('/api/v1/cases/:caseId/nl/generations/:generationId/accept', async (ctx) => {
    const body = await ctx.json<AcceptNlGenerationRequest>(acceptNlGenerationRequestSchema);
    const result = services.nlGenerations.accept(param(ctx, 'caseId'), param(ctx, 'generationId'), body, ctx.actor);
    sendData(ctx.res, 200, result, ctx.requestId);
  });

  router.post('/api/v1/cases/:caseId/nl/generations/:generationId/reject', async (ctx) => {
    const body = await ctx.json<RejectNlGenerationRequest>(rejectNlGenerationRequestSchema);
    sendData(
      ctx.res,
      200,
      services.nlGenerations.reject(param(ctx, 'caseId'), param(ctx, 'generationId'), body, ctx.actor),
      ctx.requestId,
    );
  });

  router.post('/api/v1/cases/:caseId/nl/generations/:generationId/cancel', (ctx) => {
    sendData(ctx.res, 200, services.nlGenerations.cancel(param(ctx, 'caseId'), param(ctx, 'generationId'), ctx.actor), ctx.requestId);
  });

  // ── 只读代码视图（§12.5）──────────────────────────────────────────────

  router.get('/api/v1/cases/:caseId/spec', async (ctx) => {
    const raw = ctx.url.searchParams.get('preview');
    if (raw !== '1') {
      throw new AppError('VALIDATION_FAILED', '该端点只读：必须带 ?preview=1（避免被误当作源码下载）', [
        { path: 'preview', message: '必填且只能为 1' },
      ]);
    }
    const preview = await services.nl.specPreview(param(ctx, 'caseId'));
    sendData(ctx.res, 200, preview, ctx.requestId);
  });
}