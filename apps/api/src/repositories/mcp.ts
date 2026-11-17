/**
 * MCP 会话仓储（会话元数据 + 官方 tools/list 快照）。
 * 契约视图：docs/api-contract.md §8、§11。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { McpCap, McpSession, McpTool } from '@pw-auto/contracts';
import { all, get, run } from '../db/sql.ts';
import { jsonText, safeJsonParse } from '../utils.ts';

interface McpSessionRow {
  id: string;
  status: string;
  server_info_json: string | null;
  protocol_version: string | null;
  caps_json: string;
  tools_json: string;
  headless: number;
  isolated: number;
  work_dir: string;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
  error_json: string | null;
}

function mapSession(row: McpSessionRow): McpSession {
  return {
    id: row.id,
    status: row.status as McpSession['status'],
    serverInfo: safeJsonParse<McpSession['serverInfo']>(row.server_info_json, null),
    protocolVersion: row.protocol_version,
    caps: safeJsonParse<McpCap[]>(row.caps_json, []),
    tools: safeJsonParse<McpTool[]>(row.tools_json, []),
    headless: Number(row.headless) === 1,
    isolated: Number(row.isolated) === 1,
    workDir: row.work_dir,
    pid: row.pid === null ? null : Number(row.pid),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    error: safeJsonParse<McpSession['error']>(row.error_json, null),
  };
}

export function insertMcpSession(db: DatabaseSync, session: McpSession): void {
  run(
    db,
    `INSERT INTO mcp_sessions(id, status, server_info_json, protocol_version, caps_json, tools_json, headless, isolated, work_dir, pid, started_at, ended_at, error_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      session.id,
      session.status,
      session.serverInfo ? jsonText(session.serverInfo) : null,
      session.protocolVersion,
      jsonText(session.caps),
      jsonText(session.tools),
      session.headless ? 1 : 0,
      session.isolated ? 1 : 0,
      session.workDir,
      session.pid,
      session.startedAt,
      session.endedAt,
      session.error ? jsonText(session.error) : null,
    ],
  );
}

export function getMcpSessionById(db: DatabaseSync, id: string): McpSession | null {
  const row = get<McpSessionRow>(db, 'SELECT * FROM mcp_sessions WHERE id = ?', [id]);
  return row ? mapSession(row) : null;
}

export function listMcpSessions(db: DatabaseSync): McpSession[] {
  return all<McpSessionRow>(db, 'SELECT * FROM mcp_sessions ORDER BY started_at DESC, id DESC').map(mapSession);
}

export function countActiveMcpSessions(db: DatabaseSync): number {
  const row = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM mcp_sessions WHERE status IN ('starting','ready','closing')`,
  );
  return Number(row?.n ?? 0);
}

export function updateMcpSession(
  db: DatabaseSync,
  id: string,
  patch: { status?: McpSession['status']; tools?: McpTool[]; endedAt?: string | null; error?: McpSession['error'] },
): void {
  const current = getMcpSessionById(db, id);
  if (!current) return;
  run(db, 'UPDATE mcp_sessions SET status = ?, tools_json = ?, ended_at = ?, error_json = ? WHERE id = ?', [
    patch.status ?? current.status,
    jsonText(patch.tools ?? current.tools),
    patch.endedAt !== undefined ? patch.endedAt : current.endedAt,
    (patch.error !== undefined ? patch.error : current.error) === null
      ? null
      : jsonText(patch.error !== undefined ? patch.error : current.error),
    id,
  ]);
}

export function deleteMcpSession(db: DatabaseSync, id: string): void {
  run(db, 'DELETE FROM mcp_sessions WHERE id = ?', [id]);
}

/**
 * 进程重启后：上次进程的 MCP 子进程已不可用（优雅退出会被 shutdown 强杀，异常退出会残留孤儿），
 * 因此所有非终态会话一律置 error 并写明原因（不假装仍然 ready）。
 */
export function markStaleMcpSessions(db: DatabaseSync, at: string): number {
  const rows = all<{ id: string }>(
    db,
    `SELECT id FROM mcp_sessions WHERE status IN ('starting','ready','closing')`,
  );
  for (const row of rows) {
    run(db, `UPDATE mcp_sessions SET status = 'error', ended_at = ?, error_json = ? WHERE id = ?`, [
      at,
      JSON.stringify({ code: 'RUN_INTERRUPTED', message: '后端重启导致 MCP 会话失效（官方子进程已不可用）' }),
      row.id,
    ]);
  }
  return rows.length;
}