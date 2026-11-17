/**
 * 官方能力适配面装配（MCP / CLI / init-agents）。
 *
 * 唯一执行方是 `packages/automation`（architecture §3.1 硬规则 1）。本文件做两件事：
 * 1) 按其导出名发现适配器工厂（`createAgentsAdapter` / `createMcpAdapter` / `createCliAdapter`）；
 * 2) 把适配器方法**结构化适配**为 `@pw-auto/contracts` 的 SurfaceBundle（纯胶水，不实现官方能力）。
 *
 * 找不到适配器时对应能力返回 501 NOT_IMPLEMENTED，绝不伪造成功。
 */

import {
  createAgentsAdapter,
  createCliAdapter,
  createMcpAdapter,
  type AgentsAdapter,
  type CliAdapter,
  type McpAdapter,
} from '@pw-auto/automation';
import {
  SURFACE_FACTORY_NAMES,
  type AgentPrompt,
  type AgentSurface,
  type CliSurface,
  type McpCap,
  type McpSessionHandle,
  type McpSurface,
  type McpTool,
  type McpToolCallResponse,
  type ScaffoldExecutionResult,
  type SurfaceBundle,
} from '@pw-auto/contracts';
import { join } from 'node:path';

export interface LoadSurfacesOptions {
  repoRoot: string;
  dataDir: string;
  enableUnsafeTools: boolean;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 发现工厂：automation 的导出必须仍是函数（便于升级时显式降级而不是崩溃） */
function isFactory(value: unknown): boolean {
  return typeof value === 'function';
}

function buildAgentsSurface(adapter: AgentsAdapter): AgentSurface {
  return {
    async runScaffold(input): Promise<ScaffoldExecutionResult> {
      const result = await adapter.scaffold({
        scaffoldId: input.scaffoldId,
        loop: input.loop,
        prompts: input.prompts,
      });
      return {
        command: result.command,
        files: result.files,
        missing: result.missing,
        status: result.status,
        error: result.error,
      };
    },
    async readPrompts(): Promise<AgentPrompt[]> {
      // 官方 --prompts 产物由适配器按磁盘/记录读取；后端另有本地扫描兜底
      const templates = await adapter.getPrompts({});
      return templates.map((template) => ({
        key: template.key as AgentPrompt['key'],
        title: template.title,
        body: template.body,
        source: template.source,
      }));
    },
  };
}

function buildMcpSurface(adapter: McpAdapter): McpSurface {
  return {
    async createSession(input): Promise<McpSessionHandle> {
      const info = await adapter.createSession({
        id: input.sessionId,
        caps: input.caps as string[],
        headless: input.headless,
        isolated: input.isolated,
        ...(input.browser !== undefined ? { browser: input.browser as 'chromium' } : {}),
        workDir: input.workDir,
      });
      return {
        serverInfo: info.serverInfo,
        protocolVersion: info.protocolVersion,
        tools: info.tools as McpTool[],
        pid: info.pid,
      };
    },
    async callTool(input): Promise<McpToolCallResponse> {
      const result = await adapter.callTool(input.sessionId, input.tool, input.arguments, {
        timeoutMs: input.timeoutMs,
        ...(input.confirm !== undefined ? { confirm: input.confirm } : {}),
      });
      return { content: result.content, isError: result.isError, durationMs: result.durationMs };
    },
    async closeSession(sessionId): Promise<void> {
      await adapter.closeSession(sessionId);
    },
  };
}

function buildCliSurface(adapter: CliAdapter): CliSurface {
  return {
    async exec(input) {
      const result = await adapter.exec({
        argv: input.argv,
        ...(input.session !== undefined ? { session: input.session } : {}),
        workDir: input.workDir,
        timeoutMs: input.timeoutMs,
        confirm: input.allowUnsafe,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        json: result.json,
        parsed: result.parsed,
        durationMs: result.durationMs,
        artifacts: result.artifacts.map((artifact) => ({ kind: artifact.kind, path: artifact.path })),
      };
    },
  };
}

export function loadSurfaces(options: LoadSurfacesOptions): SurfaceBundle {
  const reasons: Record<string, string> = {};

  let agents: AgentSurface | null = null;
  try {
    if (!isFactory(createAgentsAdapter)) {
      reasons['agents'] = `@pw-auto/automation 未导出适配工厂（${SURFACE_FACTORY_NAMES.agents.join(' / ')}）`;
    } else {
      const adapter = createAgentsAdapter({ agentsRoot: join(options.repoRoot, 'agents') });
      agents = buildAgentsSurface(adapter);
    }
  } catch (error) {
    reasons['agents'] = `init-agents 适配器初始化失败：${reasonOf(error)}`;
  }

  let mcp: McpSurface | null = null;
  try {
    if (!isFactory(createMcpAdapter)) {
      reasons['mcp'] = `@pw-auto/automation 未导出适配工厂（${SURFACE_FACTORY_NAMES.mcp.join(' / ')}）`;
    } else {
      const adapter = createMcpAdapter({
        unsafeToolsEnabled: options.enableUnsafeTools,
        allowedWorkDirRoots: [join(options.dataDir, 'mcp')],
      });
      mcp = buildMcpSurface(adapter);
    }
  } catch (error) {
    reasons['mcp'] = `MCP 适配器初始化失败：${reasonOf(error)}`;
  }

  let cli: CliSurface | null = null;
  try {
    if (!isFactory(createCliAdapter)) {
      reasons['cli'] = `@pw-auto/automation 未导出适配工厂（${SURFACE_FACTORY_NAMES.cli.join(' / ')}）`;
    } else {
      const adapter = createCliAdapter({
        defaultWorkDir: join(options.dataDir, 'cli'),
        allowedWorkDirRoots: [join(options.dataDir, 'cli')],
        unsafeToolsEnabled: options.enableUnsafeTools,
      });
      cli = buildCliSurface(adapter);
    }
  } catch (error) {
    reasons['cli'] = `CLI 适配器初始化失败：${reasonOf(error)}`;
  }

  return { agents, mcp, cli, reasons };
}

/** 测试用：占位能力面（显式声明全部不可用） */
export function unavailableSurfaces(reason: string): SurfaceBundle {
  return { agents: null, mcp: null, cli: null, reasons: { agents: reason, mcp: reason, cli: reason } };
}

export type { McpCap };