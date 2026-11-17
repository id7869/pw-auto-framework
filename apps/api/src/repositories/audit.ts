/**
 * 审计日志（api-contract §11 audit_log）：记录变更动作，便于回溯「谁在什么时候改了什么」。
 * 只记资源 id 与摘要，不记录请求体原文（避免密钥/大字段入库）。
 */

import type { DatabaseSync } from 'node:sqlite';
import { run } from '../db/sql.ts';
import { isoNow, jsonText } from '../utils.ts';

export interface AuditEntry {
  actor: string;
  action: string;
  target: string | null;
  detail?: Record<string, unknown> | undefined;
}

export function writeAudit(db: DatabaseSync, entry: AuditEntry): void {
  run(db, 'INSERT INTO audit_log(at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)', [
    isoNow(),
    entry.actor,
    entry.action,
    entry.target,
    entry.detail ? jsonText(entry.detail) : null,
  ]);
}