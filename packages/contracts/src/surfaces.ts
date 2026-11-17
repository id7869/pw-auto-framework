/**
 * 官方能力适配面（`packages/automation` 与 `apps/api` 的交接契约）。
 *
 * 背景：架构 §3.1 规定「只有 packages/automation 允许 spawn 子进程 / 触碰 Playwright」，
 * 因此 MCP / CLI / init-agents 三面的**执行**必须由 automation 提供；apps/api 只做
 * 编排、校验、持久化与索引。
 *
 * 现状（2026-11-11）：
 * - automation 已实现 `createAgentsAdapter()` / `createMcpAdapter()` / `createCliAdapter()`
 *   （类方法名分别为 scaffold / getPrompts / createSession / callTool / exec 等）；
 * - apps/api 的 `surfaces.ts` 负责把它们**结构化适配**到本文件定义的 `SurfaceBundle`
 *   （薄胶水层，不复制任何官方能力）；本接口因此保持与 apps/api 服务层一致的形状，
 *   便于单测注入 fake 实现。
 *
 * 发现规则：从 `@pw-auto/automation` 导出中按候选名查找工厂，找不到则该能力返回
 * 501 NOT_IMPLEMENTED（不得伪造成功）。
 */

import type { AgentLoop, AgentPrompt, ScaffoldFile, ScaffoldStatus } from './agent.ts';
import type { CliExecResponse } from './cli.ts';
import type { McpCap, McpTool, McpToolCallResponse } from './mcp.ts';

/** automation 模块中允许的工厂导出名（apps/api 逐个尝试，取第一个函数） */
export const SURFACE_FACTORY_NAMES = {
  agents: ['createAgentsAdapter', 'createAgentSurface', 'createAgentAdapter'],
  mcp: ['createMcpAdapter', 'createMcpSurface', 'createMcpClient'],
  cli: ['createCliAdapter', 'createCliSurface', 'createCliRunner'],
} as const;

export interface ScaffoldExecutionInput {
  /** 后端生成的脚手架 id，用于受控目录命名 */
  scaffoldId: string;
  loop: AgentLoop;
  /** 是否附加官方 `--prompts` */
  prompts: boolean;
  /** 受控绝对目录：<repo>/agents/<scaffoldId>，由后端创建 */
  targetDir: string;
  /** 仓库根，供官方命令定位配置 */
  repoRoot: string;
}

export interface ScaffoldExecutionResult {
  /** 官方命令 argv 全量回显（不含密钥） */
  command: string[];
  files: ScaffoldFile[];
  /** 期望但缺失的产物（相对 targetDir，只做结构结论） */
  missing: string[];
  status: ScaffoldStatus;
  error: { code: string; message: string } | null;
}

export interface AgentSurface {
  runScaffold(input: ScaffoldExecutionInput): Promise<ScaffoldExecutionResult>;
  /** 读取官方 `--prompts` 产物；无产物返回空数组（后端据此回退框架模板） */
  readPrompts?(input: { targetDir: string }): Promise<AgentPrompt[]>;
}

export interface McpSessionHandle {
  serverInfo: { name: string; version: string } | null;
  protocolVersion: string | null;
  tools: McpTool[];
  pid: number | null;
}

export interface McpSessionCreateInput {
  sessionId: string;
  caps: McpCap[];
  headless: boolean;
  browser?: string;
  isolated: boolean;
  /** 受控工作目录，由后端创建 */
  workDir: string;
}

export interface McpSurface {
  createSession(input: McpSessionCreateInput): Promise<McpSessionHandle>;
  callTool(input: {
    sessionId: string;
    tool: string;
    arguments: Record<string, unknown>;
    timeoutMs: number;
    /** unsafe 段工具必须显式确认（后端已按 PW_ENABLE_UNSAFE_TOOLS 计算） */
    confirm?: boolean;
  }): Promise<McpToolCallResponse>;
  closeSession(sessionId: string): Promise<void>;
}

export interface CliExecInput {
  argv: string[];
  session?: string;
  /** 受控工作目录（已由后端校验） */
  workDir: string;
  timeoutMs: number;
  /** 是否允许 unsafe 命令（由后端按 PW_ENABLE_UNSAFE_TOOLS 与 confirm 计算） */
  allowUnsafe: boolean;
}

export interface CliSurface {
  exec(input: CliExecInput): Promise<CliExecResponse>;
}

/** 三个面的可用性（缺面为 null，并在 reasons 里给出中文原因） */
export interface SurfaceBundle {
  agents: AgentSurface | null;
  mcp: McpSurface | null;
  cli: CliSurface | null;
  reasons: Record<string, string>;
}

/** 工厂签名（structural）：参数为实现自定，apps/api 以选项对象调用 */
export type SurfaceFactory<T> = (options?: Record<string, unknown>) => T;