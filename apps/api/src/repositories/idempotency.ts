/**
 * 幂等键仓储（api-contract §0.3）：同 key + 同请求体 → 返回同一资源；不同请求体 → 409。
 */

import type { DatabaseSync } from 'node:sqlite';
import { get, run } from '../db/sql.ts';

export interface IdempotencyRecord {
  key: string;
  scope: string;
  requestHash: string;
  resourceId: string;
  responseStatus: number;
  createdAt: string;
}

interface IdempotencyRow {
  key: string;
  scope: string;
  request_hash: string;
  resource_id: string;
  response_status: number;
  created_at: string;
}

export function getIdempotency(db: DatabaseSync, key: string): IdempotencyRecord | null {
  const row = get<IdempotencyRow>(db, 'SELECT * FROM idempotency_keys WHERE key = ?', [key]);
  if (!row) return null;
  return {
    key: row.key,
    scope: row.scope,
    requestHash: row.request_hash,
    resourceId: row.resource_id,
    responseStatus: Number(row.response_status),
    createdAt: row.created_at,
  };
}

export function saveIdempotency(db: DatabaseSync, record: IdempotencyRecord): void {
  run(
    db,
    `INSERT OR REPLACE INTO idempotency_keys(key, scope, request_hash, resource_id, response_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [record.key, record.scope, record.requestHash, record.resourceId, record.responseStatus, record.createdAt],
  );
}