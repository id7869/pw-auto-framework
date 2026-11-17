/**
 * MCP 会话服务（官方 `playwright mcp` 子进程由 automation 适配面托管）。
 * 契约：docs/api-contract.md §8。
 *
 * 安全纪律：工具白名单逐条来自官方 tools/list 实测清单；unsafe 段默认关闭，
 * 开启需 PW_ENABLE_UNSAFE_TOOLS=1 且请求体 confirm:true。
 */

import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  DEFAULT_MCP_CAPS,
  MCP_UNSAFE_TOOL_NAMES,
  isUnsafeMcpTool,
  isWhitelistedMcpTool,
  type CreateMcpSessionRequest,
  type McpCap,
  type McpSession,
  type McpToolCallRequest,
  type McpToolCallResponse,
  type SurfaceBundle,
} from '@pw-auto/contracts';
import { AppError, fromAdapterError } from '../errors.ts';
import { newId } from '../ids.ts';
import { assertWithinRoot, ensureDir, mcpSessionDir } from '../paths.ts';
import { writeAudit } from '../repositories/audit.ts';
import * as mcpRepo from '../repositories/mcp.ts';
import { isoNow } from '../utils.ts';

const TOOL_TIMEOUT_MS = 30000;

export interface McpServiceDeps {
  db: DatabaseSync;
  surfaces: SurfaceBundle;
  dataDir: string;
  enableUnsafeTools: boolean;
  maxSessions: number;
  log: (message: string) => void;
}

export class McpService {
  private readonly db: DatabaseSync;
  private readonly surfaces: SurfaceBundle;
  private readonly dataDir: string;
  private readonly enableUnsafeTools: boolean;
  private readonly maxSessions: number;
  private readonly log: (message: string) => void;

  constructor(deps: McpServiceDeps) {
    this.db = deps.db;
    this.surfaces = deps.surfaces;
    this.dataDir = deps.dataDir;
    this.enableUnsafeTools = deps.enableUnsafeTools;
    this.maxSessions = deps.maxSessions;
    this.log = deps.log;
  }

  list(): McpSession[] {
    return mcpRepo.listMcpSessions(this.db);
  }

  /** 活动会话数（starting/ready/closing），用于 /api/meta 与上限判定 */
  activeSessionCount(): number {
    return mcpRepo.countActiveMcpSessions(this.db);
  }

  get(id: string): McpSession {
    const found = mcpRepo.getMcpSessionById(this.db, id);
    if (!found) throw new AppError('NOT_FOUND', `MCP 会话不存在：${id}`);
    return found;
  }

  async create(input: CreateMcpSessionRequest, actor: string): Promise<McpSession> {
    const surface = this.surfaces.mcp;
    if (!surface) {
      throw new AppError('NOT_IMPLEMENTED', this.surfaces.reasons['mcp'] ?? '官方 playwright mcp 适配不可用');
    }
    const caps: McpCap[] = input.caps ?? [...DEFAULT_MCP_CAPS];
    if (caps.includes('vision') && !this.enableUnsafeTools) {
      throw new AppError('CAPABILITY_DISABLED', 'vision（视觉坐标）能力默认关闭：需 PW_ENABLE_UNSAFE_TOOLS=1 并在请求体 confirm:true');
    }
    if (mcpRepo.countActiveMcpSessions(this.db) >= this.maxSessions) {
      throw new AppError('TOO_MANY_MCP_SESSIONS', `MCP 会话数已达上限 ${this.maxSessions}，请先关闭不用的会话`);
    }

    const sessionId = newId('mcpSession');
    const mcpRoot = ensureDir(join(this.dataDir, 'mcp'));
    const workDir = ensureDir(mcpSessionDir(this.dataDir, sessionId));
    assertWithinRoot(mcpRoot, workDir, 'MCP 工作目录越界');

    const startedAt = isoNow();
    const base: McpSession = {
      id: sessionId,
      status: 'starting',
      serverInfo: null,
      protocolVersion: null,
      caps,
      tools: [],
      headless: input.headless,
      isolated: input.isolated,
      workDir,
      pid: null,
      startedAt,
      endedAt: null,
      error: null,
    };

    try {
      const handle = await surface.createSession({
        sessionId,
        caps,
        headless: input.headless,
        ...(input.browser !== undefined ? { browser: input.browser } : {}),
        isolated: input.isolated,
        workDir,
      });
      const session: McpSession = {
        ...base,
        status: 'ready',
        serverInfo: handle.serverInfo,
        protocolVersion: handle.protocolVersion,
        tools: handle.tools,
        pid: handle.pid,
      };
      mcpRepo.insertMcpSession(this.db, session);
      writeAudit(this.db, { actor, action: 'mcp.session.create', target: sessionId, detail: { caps } });
      return session;
    } catch (error) {
      const mapped = fromAdapterError(error, '官方 playwright mcp 启动/握手失败', 'SUBPROCESS_ERROR');
      this.log(`[mcp] 启动官方 MCP 子进程失败：${mapped.message}`);
      mcpRepo.insertMcpSession(this.db, {
        ...base,
        status: 'error',
        endedAt: isoNow(),
        error: { code: mapped.code, message: mapped.message },
      });
      throw mapped;
    }
  }

  async callTool(sessionId: string, input: McpToolCallRequest, actor: string): Promise<McpToolCallResponse> {
    const session = this.get(sessionId);
    if (session.status !== 'ready') {
      throw new AppError('SESSION_NOT_READY', `MCP 会话未就绪（当前状态：${session.status}）`);
    }
    const tool = input.tool;
    if (isUnsafeMcpTool(tool)) {
      if (!this.enableUnsafeTools || input.confirm !== true) {
        throw new AppError(
          'CAPABILITY_DISABLED',
          `不安全工具 ${tool} 默认关闭：需 PW_ENABLE_UNSAFE_TOOLS=1 且请求体 confirm:true（官方描述为 RCE-equivalent）`,
        );
      }
    } else if (looksLikeUnsafeToolName(tool)) {
      // 形似 unsafe（run_code/evaluate/mouse_*）但不在官方文档化名单内：明确拒绝，绝不按前缀放行
      throw new AppError(
        'CAPABILITY_DISABLED',
        `工具名形似 unsafe 但不在官方文档化名单内：${tool}（仅允许 ${MCP_UNSAFE_TOOL_NAMES.join(' / ')}）`,
      );
    } else if (!isWhitelistedMcpTool(tool)) {
      throw new AppError('CAPABILITY_DISABLED', `工具不在白名单内：${tool}（仅允许官方 tools/list 实测清单内的工具）`);
    }

    const surface = this.surfaces.mcp;
    if (!surface) throw new AppError('NOT_IMPLEMENTED', this.surfaces.reasons['mcp'] ?? '官方 playwright mcp 适配不可用');

    const started = Date.now();
    try {
      const result = await surface.callTool({
        sessionId,
        tool,
        arguments: input.arguments ?? {},
        timeoutMs: TOOL_TIMEOUT_MS,
        confirm: input.confirm === true,
      });
      writeAudit(this.db, { actor, action: 'mcp.tool.call', target: sessionId, detail: { tool } });
      return { ...result, durationMs: result.durationMs || Date.now() - started };
    } catch (error) {
      const mapped = fromAdapterError(error, `MCP 工具调用失败（${tool}）`, 'SUBPROCESS_ERROR');
      if (mapped.code === 'TOOL_TIMEOUT' || /timeout|timed out/i.test(mapped.message)) {
        throw new AppError('TOOL_TIMEOUT', `MCP 工具调用超时（${TOOL_TIMEOUT_MS}ms）：${tool}`);
      }
      throw mapped;
    }
  }

  async close(sessionId: string, actor: string): Promise<void> {
    const session = this.get(sessionId);
    const surface = this.surfaces.mcp;
    mcpRepo.updateMcpSession(this.db, sessionId, { status: 'closing' });
    if (surface) {
      try {
        await surface.closeSession(sessionId);
      } catch (error) {
        this.log(`[mcp] 关闭会话失败（仍标记 closed）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    mcpRepo.updateMcpSession(this.db, sessionId, { status: 'closed', endedAt: isoNow() });
    writeAudit(this.db, { actor, action: 'mcp.session.close', target: sessionId, detail: { caps: session.caps } });
  }
}

/**
 * 形似 unsafe 的工具名（run_code / evaluate / mouse_*）。
 * 用途：这类名字若不在官方文档化名单内，必须显式 403，不能因为"看起来危险"就按 unsafe 段放行。
 */
function looksLikeUnsafeToolName(tool: string): boolean {
  return /^browser_(run_code|evaluate|mouse_)/.test(tool);
}