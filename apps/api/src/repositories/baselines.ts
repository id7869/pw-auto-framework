/**
 * 回归基线仓储。契约视图：docs/api-contract.md §6.1、§11。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Baseline, BaselineCreatedBy, BaselineListQuery, BaselineScope, Page } from '@pw-auto/contracts';
import { paginate } from '../db/paginate.ts';
import { get, run, type SqlValue } from '../db/sql.ts';
import { AppError } from '../errors.ts';
import { newId } from '../ids.ts';
import { isoNow } from '../utils.ts';

interface BaselineRow {
  id: string;
  scope: string;
  scope_id: string;
  run_id: string;
  name: string;
  note: string | null;
  is_default: number;
  archived_at: string | null;
  created_by: string;
  created_at: string;
}

function mapBaseline(row: BaselineRow): Baseline {
  return {
    id: row.id,
    scope: row.scope as BaselineScope,
    scopeId: row.scope_id,
    runId: row.run_id,
    name: row.name,
    note: row.note,
    isDefault: Number(row.is_default) === 1,
    archivedAt: row.archived_at,
    createdBy: row.created_by as BaselineCreatedBy,
    createdAt: row.created_at,
  };
}

export function insertBaseline(
  db: DatabaseSync,
  input: {
    scope: BaselineScope;
    scopeId: string;
    runId: string;
    name: string;
    note: string | null;
    createdBy: BaselineCreatedBy;
  },
): Baseline {
  const id = newId('baseline');
  const existingDefault = get<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM baselines WHERE scope = ? AND scope_id = ? AND is_default = 1 AND archived_at IS NULL',
    [input.scope, input.scopeId],
  );
  const isDefault = Number(existingDefault?.n ?? 0) === 0;
  run(
    db,
    `INSERT INTO baselines(id, scope, scope_id, run_id, name, note, is_default, archived_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [id, input.scope, input.scopeId, input.runId, input.name, input.note, isDefault ? 1 : 0, input.createdBy, isoNow()],
  );
  const created = getBaselineById(db, id);
  if (!created) throw new AppError('INTERNAL_ERROR', '基线写入后无法读回（数据库异常）');
  return created;
}

export function getBaselineById(db: DatabaseSync, id: string): Baseline | null {
  const row = get<BaselineRow>(db, 'SELECT * FROM baselines WHERE id = ?', [id]);
  return row ? mapBaseline(row) : null;
}

export function listBaselines(db: DatabaseSync, query: BaselineListQuery): Page<Baseline> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (query.scope) {
    where.push('scope = ?');
    params.push(query.scope);
  }
  if (query.scopeId) {
    where.push('scope_id = ?');
    params.push(query.scopeId);
  }
  if (query.archived === 'true') {
    where.push('archived_at IS NOT NULL');
  } else if (query.archived === 'false') {
    where.push('archived_at IS NULL');
  }
  return paginate<Baseline>({
    db,
    select: 'SELECT *',
    from: 'FROM baselines',
    where,
    params,
    orderBy: 'created_at',
    idColumn: 'id',
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => mapBaseline(row as unknown as BaselineRow),
  });
}

/** 同 scope 至多一条默认基线：先把同 scope 其它基线取消默认，再置本条；已归档基线拒绝（防御性双保险） */
export function setDefaultBaseline(db: DatabaseSync, id: string): Baseline {
  const current = getBaselineById(db, id);
  if (!current) throw new AppError('NOT_FOUND', `基线不存在：${id}`);
  if (current.archivedAt !== null) {
    throw new AppError('VALIDATION_FAILED', '已归档的基线不能再设为默认；请选择未归档的基线', [
      { path: 'baselineId', message: `基线已归档：${id}` },
    ]);
  }
  run(db, 'UPDATE baselines SET is_default = 0 WHERE scope = ? AND scope_id = ? AND archived_at IS NULL', [
    current.scope,
    current.scopeId,
  ]);
  run(db, 'UPDATE baselines SET is_default = 1 WHERE id = ?', [id]);
  const updated = getBaselineById(db, id);
  if (!updated) throw new AppError('INTERNAL_ERROR', '基线更新后无法读回（数据库异常）');
  return updated;
}

export function archiveBaseline(db: DatabaseSync, id: string): Baseline {
  const current = getBaselineById(db, id);
  if (!current) throw new AppError('NOT_FOUND', `基线不存在：${id}`);
  if (current.archivedAt === null) {
    run(db, 'UPDATE baselines SET archived_at = ?, is_default = 0 WHERE id = ?', [isoNow(), id]);
  }
  const updated = getBaselineById(db, id);
  if (!updated) throw new AppError('INTERNAL_ERROR', '基线更新后无法读回（数据库异常）');
  return updated;
}

export function defaultBaselineFor(db: DatabaseSync, scope: BaselineScope, scopeId: string): Baseline | null {
  const row = get<BaselineRow>(
    db,
    'SELECT * FROM baselines WHERE scope = ? AND scope_id = ? AND is_default = 1 AND archived_at IS NULL LIMIT 1',
    [scope, scopeId],
  );
  return row ? mapBaseline(row) : null;
}