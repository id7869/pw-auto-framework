/**
 * §4 套件路由。
 */

import {
  createSuiteRequestSchema,
  patchSuiteRequestSchema,
  putSuiteCasesRequestSchema,
  suiteListQuerySchema,
  type CreateSuiteRequest,
  type PatchSuiteRequest,
  type PutSuiteCasesRequest,
  type SuiteListQuery,
} from '@pw-auto/contracts';
import { sendData, sendNoContent } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import type { AppServices } from '../services/container.ts';
import { param } from './helpers.ts';

export function registerSuiteRoutes(router: Router, services: AppServices): void {
  router.get('/api/v1/suites', (ctx) => {
    const query = ctx.query<SuiteListQuery>(suiteListQuerySchema);
    sendData(ctx.res, 200, services.suites.list(query), ctx.requestId);
  });

  router.post('/api/v1/suites', async (ctx) => {
    const body = await ctx.json<CreateSuiteRequest>(createSuiteRequestSchema);
    const created = services.suites.create(body, ctx.actor);
    sendData(ctx.res, 201, created, ctx.requestId);
  });

  router.get('/api/v1/suites/:suiteId', (ctx) => {
    sendData(ctx.res, 200, services.suites.get(param(ctx, 'suiteId')), ctx.requestId);
  });

  router.patch('/api/v1/suites/:suiteId', async (ctx) => {
    const body = await ctx.json<PatchSuiteRequest>(patchSuiteRequestSchema);
    const updated = services.suites.patch(param(ctx, 'suiteId'), body, ctx.actor);
    sendData(ctx.res, 200, updated, ctx.requestId);
  });

  router.put('/api/v1/suites/:suiteId/cases', async (ctx) => {
    const body = await ctx.json<PutSuiteCasesRequest>(putSuiteCasesRequestSchema);
    const updated = services.suites.putCases(param(ctx, 'suiteId'), body, ctx.actor);
    sendData(ctx.res, 200, updated, ctx.requestId);
  });

  router.delete('/api/v1/suites/:suiteId', (ctx) => {
    services.suites.remove(param(ctx, 'suiteId'), ctx.actor);
    sendNoContent(ctx.res, ctx.requestId);
  });
}