/**
 * §6 回归路由：基线（Baseline）与对比（Comparison）。
 * 说明：`POST /comparisons` 的 data 是 Comparison 的超集（额外带 items 第一页），
 * 与 api-contract §6.2「201 Comparison（含 items 第一页）」一致；GET 单独返回 ComparisonDetail。
 */

import {
  baselineConfirmRequestSchema,
  baselineListQuerySchema,
  comparisonDetailQuerySchema,
  comparisonListQuerySchema,
  createBaselineRequestSchema,
  createComparisonRequestSchema,
  type BaselineConfirmRequest,
  type BaselineListQuery,
  type ComparisonDetailQuery,
  type ComparisonListQuery,
  type CreateBaselineRequest,
  type CreateComparisonRequest,
} from '@pw-auto/contracts';
import { sendData } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import type { AppServices } from '../services/container.ts';
import { param } from './helpers.ts';

export function registerRegressionRoutes(router: Router, services: AppServices): void {
  router.get('/api/v1/baselines', (ctx) => {
    const query = ctx.query<BaselineListQuery>(baselineListQuerySchema);
    sendData(ctx.res, 200, services.baselines.list(query), ctx.requestId);
  });

  router.post('/api/v1/baselines', async (ctx) => {
    const body = await ctx.json<CreateBaselineRequest>(createBaselineRequestSchema);
    const created = services.baselines.create(body, ctx.actor);
    sendData(ctx.res, 201, created, ctx.requestId);
  });

  router.get('/api/v1/baselines/:baselineId', (ctx) => {
    sendData(ctx.res, 200, services.baselines.get(param(ctx, 'baselineId')), ctx.requestId);
  });

  router.post('/api/v1/baselines/:baselineId/default', (ctx) => {
    const updated = services.baselines.setDefault(param(ctx, 'baselineId'), ctx.actor);
    sendData(ctx.res, 200, updated, ctx.requestId);
  });

  router.post('/api/v1/baselines/:baselineId/archive', async (ctx) => {
    const body = await ctx.json<BaselineConfirmRequest>(baselineConfirmRequestSchema);
    const updated = services.baselines.archive(param(ctx, 'baselineId'), body.confirm, ctx.actor);
    sendData(ctx.res, 200, updated, ctx.requestId);
  });

  router.get('/api/v1/comparisons', (ctx) => {
    const query = ctx.query<ComparisonListQuery>(comparisonListQuerySchema);
    sendData(ctx.res, 200, services.comparisons.list(query), ctx.requestId);
  });

  router.post('/api/v1/comparisons', async (ctx) => {
    const body = await ctx.json<CreateComparisonRequest>(createComparisonRequestSchema);
    const detail = services.comparisons.create(body, ctx.actor);
    sendData(
      ctx.res,
      201,
      { ...detail.comparison, items: detail.items, nextCursor: detail.nextCursor, hasMore: detail.hasMore },
      ctx.requestId,
    );
  });

  router.get('/api/v1/comparisons/:comparisonId', (ctx) => {
    const query = ctx.query<ComparisonDetailQuery>(comparisonDetailQuerySchema);
    const detail = services.comparisons.get(param(ctx, 'comparisonId'), {
      itemsLimit: query.itemsLimit,
      itemsCursor: query.itemsCursor,
    });
    sendData(ctx.res, 200, detail, ctx.requestId);
  });
}