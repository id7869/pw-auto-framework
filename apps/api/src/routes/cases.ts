/**
 * §2 用例路由 + §3 数据集路由。
 */

import {
  caseListQuerySchema,
  createCaseRequestSchema,
  createDatasetRequestSchema,
  datasetRowListQuerySchema,
  paginationQuerySchema,
  patchCaseRequestSchema,
  patchDatasetRequestSchema,
  putDatasetRowsRequestSchema,
  validateCaseRequestSchema,
  type CaseListQuery,
  type CreateCaseRequest,
  type CreateDatasetRequest,
  type DatasetRowListQuery,
  type PaginationQuery,
  type PatchCaseRequest,
  type PatchDatasetRequest,
  type PutDatasetRowsRequest,
  type ValidateCaseRequest,
} from '@pw-auto/contracts';
import { AppError } from '../errors.ts';
import { sendData, sendNoContent } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import type { AppServices } from '../services/container.ts';
import { ifMatchOf, param } from './helpers.ts';

export function registerCaseRoutes(router: Router, services: AppServices): void {
  // ── 用例 ────────────────────────────────────────────────────────────────
  router.get('/api/v1/cases', (ctx) => {
    const query = ctx.query<CaseListQuery>(caseListQuerySchema);
    sendData(ctx.res, 200, services.cases.list(query), ctx.requestId);
  });

  router.post('/api/v1/cases', async (ctx) => {
    const body = await ctx.json<CreateCaseRequest>(createCaseRequestSchema);
    const created = services.cases.create(body, ctx.actor);
    sendData(ctx.res, 201, created, ctx.requestId);
  });

  router.get('/api/v1/cases/:caseId', (ctx) => {
    sendData(ctx.res, 200, services.cases.get(param(ctx, 'caseId')), ctx.requestId);
  });

  router.patch('/api/v1/cases/:caseId', async (ctx) => {
    const version = ifMatchOf(ctx);
    const patch = await ctx.json<PatchCaseRequest>(patchCaseRequestSchema);
    const updated = services.cases.patch(param(ctx, 'caseId'), version, patch, ctx.actor);
    sendData(ctx.res, 200, updated, ctx.requestId);
  });

  router.delete('/api/v1/cases/:caseId', (ctx) => {
    services.cases.remove(param(ctx, 'caseId'), ctx.actor);
    sendNoContent(ctx.res, ctx.requestId);
  });

  router.post('/api/v1/cases/:caseId/validate', async (ctx) => {
    const body = await ctx.json<ValidateCaseRequest>(validateCaseRequestSchema);
    const result = await services.cases.validate(param(ctx, 'caseId'), body.datasetId);
    sendData(ctx.res, 200, result, ctx.requestId);
  });

  // ── 数据集（case 级） ──────────────────────────────────────────────────
  router.get('/api/v1/cases/:caseId/datasets', (ctx) => {
    const query = ctx.query<PaginationQuery>(paginationQuerySchema);
    sendData(ctx.res, 200, services.datasets.listForCase(param(ctx, 'caseId'), query), ctx.requestId);
  });

  router.post('/api/v1/cases/:caseId/datasets', async (ctx) => {
    const body = await ctx.json<CreateDatasetRequest>(createDatasetRequestSchema);
    const created = services.datasets.create(param(ctx, 'caseId'), body, ctx.actor);
    sendData(ctx.res, 201, created, ctx.requestId);
  });

  // ── 数据集（独立资源） ─────────────────────────────────────────────────
  router.get('/api/v1/datasets/:datasetId', (ctx) => {
    sendData(ctx.res, 200, services.datasets.get(param(ctx, 'datasetId')), ctx.requestId);
  });

  router.patch('/api/v1/datasets/:datasetId', async (ctx) => {
    const body = await ctx.json<PatchDatasetRequest>(patchDatasetRequestSchema);
    const name = body.name;
    if (name === undefined) {
      // schema 已 refine 拦截；这里保留显式防御，避免未来放宽 schema 时静默变成空操作
      throw new AppError('VALIDATION_FAILED', '至少提供一个待更新字段（name）', [
        { path: 'name', message: '至少提供一个待更新字段' },
      ]);
    }
    const updated = services.datasets.rename(param(ctx, 'datasetId'), name, ctx.actor);
    sendData(ctx.res, 200, updated, ctx.requestId);
  });

  router.delete('/api/v1/datasets/:datasetId', (ctx) => {
    services.datasets.remove(param(ctx, 'datasetId'), ctx.actor);
    sendNoContent(ctx.res, ctx.requestId);
  });

  router.get('/api/v1/datasets/:datasetId/rows', (ctx) => {
    const query = ctx.query<DatasetRowListQuery>(datasetRowListQuerySchema);
    sendData(ctx.res, 200, services.datasets.rows(param(ctx, 'datasetId'), query), ctx.requestId);
  });

  router.put('/api/v1/datasets/:datasetId/rows', async (ctx) => {
    const body = await ctx.json<PutDatasetRowsRequest>(putDatasetRowsRequestSchema);
    const updated = services.datasets.replaceRows(param(ctx, 'datasetId'), body, ctx.actor);
    sendData(ctx.res, 200, updated, ctx.requestId);
  });
}