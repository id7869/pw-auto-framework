/**
 * 官方 Playwright MCP 适配器（stdio）。
 *
 * 官方入口：`node <resolved @playwright/test/cli.js> mcp [--headless] [--isolated] [--browser ...] [--caps ...]`
 * 协议实现：@modelcontextprotocol/sdk@1.32.2 的 Client + StdioClientTransport（不手写分帧）。
 *
 * 合同（docs/api-contract.md §8）：
 * - 默认 caps = ["testing","storage","network"]；
 * - 工具名必须来自实测 tools/list，且落在默认白名单；未知/未授权 → CAPABILITY_DISABLED；
 * - unsafe 工具（browser_run_code_unsafe / browser_evaluate / *_xy）需 PW_ENABLE_UNSAFE_TOOLS=1 + confirm:true；
 * - 会话可诊断：workDir、pid、serverInfo、protocolVersion、时间与错误；
 * - 关闭时强杀进程树。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { AutomationError } from '../errors.ts';
import { killProcessTree, ProcessRegistry } from '../process/process-tree.ts';
import { resolvePlaywrightCli } from '../playwrightCli.ts';
import {
  isDefaultAllowedMcpTool,
  isUnsafeMcpTool,
  MCP_DEFAULT_ALLOWED_TOOLS,
  MCP_DEFAULT_CAPS,
} from './whitelist.ts';

/** 官方 MCP 协议版本（api-contract §8.1 期望值；服务端会回显客户端请求版本）。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

const MCP_REQUEST_TIMEOUT_CODE = -32001;
const MCP_CONNECTION_CLOSED_CODE = -32000;

export const MCP_SESSION_STATUSES = ['starting', 'ready', 'closing', 'closed', 'error'] as const;
export type McpSessionStatus = (typeof MCP_SESSION_STATUSES)[number];

export interface McpSessionInfo {
  id: string;
  status: McpSessionStatus;
  serverInfo: { name: string; version: string } | null;
  protocolVersion: string | null;
  caps: string[];
  tools: { name: string; description?: string }[];
  headless: boolean;
  isolated: boolean;
  workDir: string;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  error: { code: string; message: string } | null;
}

export interface McpAdapterOptions {
  playwrightCliPath?: string;
  registry?: ProcessRegistry;
  /** initialize + listTools 的启动超时，默认 30000ms。 */
  startupTimeoutMs?: number;
  /** 默认 ["testing","storage","network"]。 */
  defaultCaps?: string[];
  /** 覆盖默认工具白名单（仍要求来自 tools/list）。 */
  allowedTools?: readonly string[];
  /** 默认读取 PW_ENABLE_UNSAFE_TOOLS=1。 */
  unsafeToolsEnabled?: boolean;
  /** 配置后强制 workDir 位于这些目录之下（防穿越）。 */
  allowedWorkDirRoots?: string[];
}

export interface McpCreateSessionInput {
  id?: string;
  caps?: string[];
  headless?: boolean;
  isolated?: boolean;
  /** chromium 为官方默认；chrome/msedge/firefox/webkit 映射为 --browser。 */
  browser?: 'chromium' | 'chrome' | 'msedge' | 'firefox' | 'webkit';
  workDir: string;
}

export interface McpCallOptions {
  confirm?: boolean;
  timeoutMs?: number;
}

export interface McpCallResult {
  content: unknown[];
  isError: boolean;
  durationMs: number;
  structuredContent?: unknown;
}

interface SessionRecord {
  info: McpSessionInfo;
  client: Client | null;
  transport: StdioClientTransport | null;
  stderr: string;
}

type RequestLike = { method: string; params?: Record<string, unknown> };
type RequestFn = (request: RequestLike, schema?: unknown, options?: unknown) => Promise<unknown>;

function isInside(rootDir: string, targetPath: string): boolean {
  const relative = path.relative(rootDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toErrorCode(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'number') {
    return (error as { code: number }).code;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createSessionId(): string {
  return `mcps_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function cloneSession(info: McpSessionInfo): McpSessionInfo {
  return {
    ...info,
    serverInfo: info.serverInfo === null ? null : { ...info.serverInfo },
    caps: [...info.caps],
    tools: info.tools.map((tool) => ({ ...tool })),
    error: info.error === null ? null : { ...info.error },
  };
}

export class McpAdapter {
  private readonly options: McpAdapterOptions;
  private readonly registry: ProcessRegistry;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly allowedTools: ReadonlySet<string>;
  private readonly unsafeToolsEnabled: boolean;
  private readonly defaultCaps: string[];

  constructor(options: McpAdapterOptions = {}) {
    this.options = options;
    this.registry = options.registry ?? new ProcessRegistry();
    this.allowedTools = new Set(options.allowedTools ?? MCP_DEFAULT_ALLOWED_TOOLS);
    this.unsafeToolsEnabled = options.unsafeToolsEnabled ?? process.env['PW_ENABLE_UNSAFE_TOOLS'] === '1';
    this.defaultCaps = options.defaultCaps === undefined ? [...MCP_DEFAULT_CAPS] : [...options.defaultCaps];
  }

  isUnsafeToolsEnabled(): boolean {
    return this.unsafeToolsEnabled;
  }

  getDefaultCaps(): string[] {
    return [...this.defaultCaps];
  }

  getAllowedTools(): string[] {
    return [...this.allowedTools];
  }

  listSessions(): McpSessionInfo[] {
    return [...this.sessions.values()].map((record) => cloneSession(record.info));
  }

  getSession(sessionId: string): McpSessionInfo {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new AutomationError('NOT_FOUND', `MCP 会话不存在：${sessionId}`);
    }
    return cloneSession(record.info);
  }

  async createSession(input: McpCreateSessionInput): Promise<McpSessionInfo> {
    const cliPath = resolvePlaywrightCli(this.options.playwrightCliPath);
    const workDir = this.validateWorkDir(input.workDir);
    await fs.mkdir(workDir, { recursive: true });
    const caps = this.validateCaps(input.caps === undefined ? this.defaultCaps : input.caps);
    const headless = input.headless !== false;
    const isolated = input.isolated !== false;
    const sessionId = input.id === undefined || input.id === '' ? createSessionId() : input.id;
    if (this.sessions.has(sessionId)) {
      throw new AutomationError('VALIDATION_FAILED', `MCP 会话 id 已存在：${sessionId}`);
    }

    const argv = [cliPath, 'mcp'];
    if (headless) argv.push('--headless');
    if (isolated) argv.push('--isolated');
    if (input.browser !== undefined && input.browser !== 'chromium') argv.push(`--browser=${input.browser}`);
    if (caps.length > 0) argv.push(`--caps=${caps.join(',')}`);

    const info: McpSessionInfo = {
      id: sessionId,
      status: 'starting',
      serverInfo: null,
      protocolVersion: null,
      caps,
      tools: [],
      headless,
      isolated,
      workDir,
      pid: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      error: null,
    };
    const record: SessionRecord = { info, client: null, transport: null, stderr: '' };
    this.sessions.set(sessionId, record);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: argv,
      cwd: workDir,
      stderr: 'pipe',
    });
    record.transport = transport;
    const stderrStream = transport.stderr;
    stderrStream?.on('data', (chunk: Buffer) => {
      if (record.stderr.length < 16_384) record.stderr += chunk.toString('utf8');
    });

    const client = new Client({ name: 'pw-auto-framework', version: '0.1.0' }, { capabilities: {} });
    record.client = client;

    // 让 SDK 请求合同钉死的协议版本，并记录服务端实际回显值（可诊断）。
    const mutable = client as unknown as { request: RequestFn };
    const originalRequest = mutable.request.bind(client);
    let negotiated: string | null = null;
    mutable.request = async (request, schema, options) => {
      if (request.method === 'initialize' && request.params !== undefined) {
        request.params['protocolVersion'] = MCP_PROTOCOL_VERSION;
      }
      const result = (await originalRequest(request, schema, options)) as
        | { protocolVersion?: unknown }
        | undefined;
      if (request.method === 'initialize' && typeof result?.protocolVersion === 'string') {
        negotiated = result.protocolVersion;
        info.protocolVersion = result.protocolVersion;
      }
      return result;
    };

    const timeoutMs = this.options.startupTimeoutMs ?? 30_000;
    try {
      await client.connect(transport, { timeout: timeoutMs });
      info.pid = transport.pid;
      if (info.pid !== null && info.pid > 0) this.registry.register(info.pid, `mcp:${sessionId}`);
      const serverVersion = client.getServerVersion();
      info.serverInfo =
        serverVersion === undefined
          ? null
          : { name: serverVersion.name, version: serverVersion.version };
      if (negotiated === null) info.protocolVersion = MCP_PROTOCOL_VERSION;
      const listed = await client.listTools(undefined, { timeout: timeoutMs });
      info.tools = listed.tools.map((tool: Tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
      }));
      if (info.pid === null && transport.pid !== null) info.pid = transport.pid;
      info.status = 'ready';
      return cloneSession(info);
    } catch (error) {
      info.status = 'error';
      info.endedAt = new Date().toISOString();
      info.pid = info.pid ?? transport.pid;
      info.error = {
        code: toErrorCode(error) === MCP_REQUEST_TIMEOUT_CODE ? 'TOOL_TIMEOUT' : 'SUBPROCESS_ERROR',
        message: errorMessage(error),
      };
      await this.forceClose(record);
      const code = info.error.code === 'TOOL_TIMEOUT' ? 'TOOL_TIMEOUT' : 'SUBPROCESS_ERROR';
      throw new AutomationError(
        code,
        `官方 MCP 服务器握手失败：${info.error.message}。自检命令：node "${cliPath}" mcp --help`,
        {
          detail: {
            session: cloneSession(info),
            stderr: record.stderr.slice(-4000),
            command: [process.execPath, ...argv],
          },
        },
      );
    }
  }

  async callTool(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown> = {},
    options: McpCallOptions = {},
  ): Promise<McpCallResult> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) throw new AutomationError('NOT_FOUND', `MCP 会话不存在：${sessionId}`);
    if (record.info.status !== 'ready' || record.client === null) {
      throw new AutomationError('SESSION_NOT_READY', `MCP 会话未就绪（当前状态：${record.info.status}）`, {
        detail: { sessionId },
      });
    }
    if (typeof toolName !== 'string' || toolName.trim() === '') {
      throw new AutomationError('VALIDATION_FAILED', 'tool 不能为空');
    }
    const exposed = record.info.tools.some((tool) => tool.name === toolName);
    if (!exposed) {
      throw new AutomationError(
        'CAPABILITY_DISABLED',
        `工具「${toolName}」不在当前会话的官方 tools/list 中，已拒绝`,
        { detail: { availableTools: record.info.tools.map((tool) => tool.name) } },
      );
    }
    if (isUnsafeMcpTool(toolName)) {
      if (!this.unsafeToolsEnabled) {
        throw new AutomationError(
          'CAPABILITY_DISABLED',
          `工具「${toolName}」等价于任意代码执行；需设置 PW_ENABLE_UNSAFE_TOOLS=1 后重启服务`,
        );
      }
      if (options.confirm !== true) {
        throw new AutomationError('CAPABILITY_DISABLED', `调用不安全工具「${toolName}」需要请求体 confirm:true`);
      }
    } else if (!this.allowedTools.has(toolName)) {
      throw new AutomationError(
        'CAPABILITY_DISABLED',
        `工具「${toolName}」不在默认白名单内（如需启用请在 McpAdapterOptions.allowedTools 显式声明）`,
        { detail: { allowedTools: [...this.allowedTools] } },
      );
    }

    const timeoutMs = options.timeoutMs === undefined ? 60_000 : options.timeoutMs;
    const startedAt = Date.now();
    try {
      const result = (await record.client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: timeoutMs,
      })) as CallToolResult;
      return {
        content: Array.isArray(result.content) ? (result.content as unknown[]) : [],
        isError: result.isError === true,
        durationMs: Date.now() - startedAt,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      };
    } catch (error) {
      const code = toErrorCode(error);
      if (code === MCP_REQUEST_TIMEOUT_CODE) {
        throw new AutomationError('TOOL_TIMEOUT', `MCP 工具「${toolName}」调用超时（${timeoutMs}ms）`, {
          detail: { sessionId, tool: toolName, timeoutMs },
        });
      }
      if (code === MCP_CONNECTION_CLOSED_CODE) {
        record.info.status = 'error';
        record.info.error = { code: 'SUBPROCESS_ERROR', message: errorMessage(error) };
        throw new AutomationError('SUBPROCESS_ERROR', `MCP 连接已关闭：${errorMessage(error)}`, {
          detail: { sessionId },
        });
      }
      throw new AutomationError('SUBPROCESS_ERROR', `MCP 工具「${toolName}」调用失败：${errorMessage(error)}`, {
        detail: { sessionId, tool: toolName },
      });
    }
  }

  async closeSession(sessionId: string): Promise<McpSessionInfo> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) throw new AutomationError('NOT_FOUND', `MCP 会话不存在：${sessionId}`);
    if (record.info.status === 'closed') return cloneSession(record.info);
    record.info.status = 'closing';
    await this.forceClose(record);
    record.info.status = 'closed';
    record.info.endedAt = new Date().toISOString();
    return cloneSession(record.info);
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.values()]
      .filter((record) => record.info.status === 'ready' || record.info.status === 'starting')
      .map((record) => record.info.id);
    await Promise.all(ids.map(async (id) => this.closeSession(id)));
  }

  /** 强杀（client.close + taskkill 兜底），并清空引用。 */
  private async forceClose(record: SessionRecord): Promise<void> {
    const pid = record.info.pid;
    try {
      await record.client?.close();
    } catch {
      // 关闭失败继续强杀。
    }
    if (pid !== null) {
      await killProcessTree(pid);
      this.registry.unregister(pid);
    }
    record.client = null;
    record.transport = null;
  }

  private validateCaps(caps: string[]): string[] {
    if (!Array.isArray(caps)) throw new AutomationError('VALIDATION_FAILED', 'caps 必须是字符串数组');
    const normalized: string[] = [];
    for (const cap of caps) {
      if (typeof cap !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(cap)) {
        throw new AutomationError('VALIDATION_FAILED', `非法的 caps 值：${String(cap)}`);
      }
      if (!normalized.includes(cap)) normalized.push(cap);
    }
    return normalized;
  }

  private validateWorkDir(workDir: string): string {
    if (typeof workDir !== 'string' || workDir.trim() === '' || !path.isAbsolute(workDir)) {
      throw new AutomationError('VALIDATION_FAILED', 'MCP 会话 workDir 必须是绝对路径');
    }
    const resolved = path.resolve(workDir);
    const roots = this.options.allowedWorkDirRoots;
    if (roots !== undefined && roots.length > 0) {
      const allowed = roots.some((root) => isInside(path.resolve(root), resolved));
      if (!allowed) {
        throw new AutomationError('PATH_FORBIDDEN', `MCP 会话 workDir 越出受控根：${workDir}`);
      }
    }
    return resolved;
  }
}

export function createMcpAdapter(options: McpAdapterOptions = {}): McpAdapter {
  return new McpAdapter(options);
}