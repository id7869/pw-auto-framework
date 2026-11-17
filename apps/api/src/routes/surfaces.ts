/**
 * §7 Agent 交接 / §8 MCP 会话 / §9 CLI 执行 路由。
 *
 * 纪律：需要装配外部能力的端点，在适配面不可用时统一 501 NOT_IMPLEMENTED（带中文原因）；
 * 绝不返回伪造的成功结果。
 */

import {
  agentPromptsQuerySchema,
  agentWorkspaceQuerySchema,
  createMcpSessionRequestSchema,
  createScaffoldRequestSchema,
  cliExecRequestSchema,
  mcpToolCallRequestSchema,
  paginationQuerySchema,
  type AgentPromptsQuery,
  type AgentWorkspaceQuery,
  type CliExecRequest,
  type CreateMcpSessionRequest,
  type CreateScaffoldRequest,
  type McpToolCallRequest,
  type PaginationQuery,
} from '@pw-auto/contracts';
import { sendData, sendNoContent } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import type { AppServices } from '../services/container.ts';
import { idempotencyHeaders, idempotencyKeyOf, param } from './helpers.ts';

export function registerSurfaceRoutes(router: Router, services: AppServices): void {
  // ── §7 Agent 交接（官方 init-agents；三 harness 入口） ────────────────
  // 用户 durable 裁定：删除 loops 路由（任意方法 404），不再提供 3 等价或 6 loop。

  /** 三 harness 推荐入口（无 installed/installTargets；框架不安装 skill） */
  router.get('/api/v1/agents/harnesses', (ctx) => {
    sendData(ctx.res, 200, { items: services.agents.harnesses() }, ctx.requestId);
  });

  router.post('/api/v1/agents/scaffolds', async (ctx) => {
    const key = idempotencyKeyOf(ctx);
    const body = await ctx.json<CreateScaffoldRequest>(createScaffoldRequestSchema);
    const result = await services.agents.createScaffold(body, key, ctx.actor);
    sendData(ctx.res, result.replayed ? 200 : 201, result.scaffold, ctx.requestId, idempotencyHeaders(key, result.replayed));
  });

  router.get('/api/v1/agents/scaffolds', (ctx) => {
    const query = ctx.query<PaginationQuery>(paginationQuerySchema);
    sendData(ctx.res, 200, services.agents.listScaffolds(query), ctx.requestId);
  });

  router.get('/api/v1/agents/scaffolds/:scaffoldId', (ctx) => {
    sendData(ctx.res, 200, services.agents.getScaffold(param(ctx, 'scaffoldId')), ctx.requestId);
  });

  router.get('/api/v1/agents/prompts', (ctx) => {
    const query = ctx.query<AgentPromptsQuery>(agentPromptsQuerySchema);
    sendData(ctx.res, 200, { items: services.agents.prompts(query.entry) }, ctx.requestId);
  });

  router.get('/api/v1/agents/workspace', (ctx) => {
    const query = ctx.query<AgentWorkspaceQuery>(agentWorkspaceQuerySchema);
    const items = services.agents.workspace({ path: query.path, scaffoldId: query.scaffoldId });
    sendData(ctx.res, 200, { items }, ctx.requestId);
  });

  // ── §8 MCP 会话（官方 playwright mcp 子进程） ──────────────────────────
  router.get('/api/v1/mcp/sessions', (ctx) => {
    sendData(ctx.res, 200, { items: services.mcp.list() }, ctx.requestId);
  });

  router.post('/api/v1/mcp/sessions', async (ctx) => {
    const body = await ctx.json<CreateMcpSessionRequest>(createMcpSessionRequestSchema);
    const session = await services.mcp.create(body, ctx.actor);
    sendData(ctx.res, 201, session, ctx.requestId);
  });

  router.get('/api/v1/mcp/sessions/:sessionId', (ctx) => {
    sendData(ctx.res, 200, services.mcp.get(param(ctx, 'sessionId')), ctx.requestId);
  });

  router.post('/api/v1/mcp/sessions/:sessionId/calls', async (ctx) => {
    const body = await ctx.json<McpToolCallRequest>(mcpToolCallRequestSchema);
    const result = await services.mcp.callTool(param(ctx, 'sessionId'), body, ctx.actor);
    sendData(ctx.res, 200, result, ctx.requestId);
  });

  router.delete('/api/v1/mcp/sessions/:sessionId', async (ctx) => {
    await services.mcp.close(param(ctx, 'sessionId'), ctx.actor);
    sendNoContent(ctx.res, ctx.requestId);
  });

  // ── §9 CLI 执行（官方 playwright cli 子进程） ──────────────────────────
  router.get('/api/v1/cli/commands', (ctx) => {
    sendData(ctx.res, 200, services.cli.commands(), ctx.requestId);
  });

  router.post('/api/v1/cli/exec', async (ctx) => {
    const body = await ctx.json<CliExecRequest>(cliExecRequestSchema);
    const result = await services.cli.exec(body, ctx.actor);
    sendData(ctx.res, 200, result, ctx.requestId);
  });
}