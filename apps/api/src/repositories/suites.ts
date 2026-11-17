/**
 * 套件仓储（caseIds 有序，1..100 项）。契约视图：docs/api-contract.md §4、§11。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Page, Suite, SuiteListQuery } from '@pw-auto/contracts';
import { paginate } from '../db/paginate.ts';
import { all, get, run, type SqlValue } from '../db/sql.ts';
import { AppError } from '../errors.ts';
import { newId } from '../ids.ts';
import { isoNow, jsonText } from '../utils.ts';

interface SuiteRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

function caseIdsOf(db: DatabaseSync, suiteId: string): string[] {
  return all<{ case_id: string }>(db, 'SELECT case_id FROM suite_cases WHERE suite_id = ? ORDER BY seq ASC, case_id ASC', [
    suiteId,
  ]).map((row) => row.case_id);
}

function mapSuite(db: DatabaseSync, row: SuiteRow): Suite {
  const caseIds = caseIdsOf(db, row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    caseIds,
    casesCount: caseIds.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function replaceSuiteCases(db: DatabaseSync, suiteId: string, caseIds: readonly string[]): void {
  run(db, 'DELETE FROM suite_cases WHERE suite_id = ?', [suiteId]);
  caseIds.forEach((caseId, seq) => {
    run(db, 'INSERT INTO suite_cases(suite_id, case_id, seq) VALUES (?, ?, ?)', [suiteId, caseId, seq]);
  });
}

export function insertSuite(
  db: DatabaseSync,
  input: { name: string; description: string; caseIds: string[] },
): Suite {
  const id = newId('suite');
  const now = isoNow();
  run(
    db,
    `INSERT INTO suites(id, name, description, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [id, input.name, input.description, now, now],
  );
  replaceSuiteCases(db, id, input.caseIds);
  const created = getSuiteById(db, id);
  if (!created) throw new AppError('INTERNAL_ERROR', '套件写入后无法读回（数据库异常）');
  return created;
}

export function getSuiteById(db: DatabaseSync, id: string): Suite | null {
  const row = get<SuiteRow>(db, 'SELECT * FROM suites WHERE id = ? AND deleted_at IS NULL', [id]);
  return row ? mapSuite(db, row) : null;
}

export function listSuites(db: DatabaseSync, query: SuiteListQuery): Page<Suite> {
  const where: string[] = ['deleted_at IS NULL'];
  const params: SqlValue[] = [];
  if (query.q) {
    where.push('(name LIKE ? OR description LIKE ?)');
    params.push(`%${query.q}%`, `%${query.q}%`);
  }
  return paginate<Suite>({
    db,
    select: 'SELECT *',
    from: 'FROM suites',
    where,
    params,
    orderBy: 'created_at',
    idColumn: 'id',
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => mapSuite(db, row as unknown as SuiteRow),
  });
}

export function updateSuite(
  db: DatabaseSync,
  id: string,
  patch: { name?: string | undefined; description?: string | undefined },
): Suite {
  const current = getSuiteById(db, id);
  if (!current) throw new AppError('NOT_FOUND', `套件不存在或已删除：${id}`);
  run(db, 'UPDATE suites SET name = ?, description = ?, updated_at = ? WHERE id = ?', [
    patch.name ?? current.name,
    patch.description ?? current.description,
    isoNow(),
    id,
  ]);
  const updated = getSuiteById(db, id);
  if (!updated) throw new AppError('INTERNAL_ERROR', '套件更新后无法读回（数据库异常）');
  return updated;
}

export function setSuiteCases(db: DatabaseSync, id: string, caseIds: readonly string[]): Suite {
  const current = getSuiteById(db, id);
  if (!current) throw new AppError('NOT_FOUND', `套件不存在或已删除：${id}`);
  replaceSuiteCases(db, id, caseIds);
  run(db, 'UPDATE suites SET updated_at = ? WHERE id = ?', [isoNow(), id]);
  const updated = getSuiteById(db, id);
  if (!updated) throw new AppError('INTERNAL_ERROR', '套件更新后无法读回（数据库异常）');
  return updated;
}

export function softDeleteSuite(db: DatabaseSync, id: string): void {
  const row = get<{ id: string; deleted_at: string | null }>(db, 'SELECT id, deleted_at FROM suites WHERE id = ?', [id]);
  if (!row) throw new AppError('NOT_FOUND', `套件不存在：${id}`);
  if (row.deleted_at !== null) return;
  run(db, 'UPDATE suites SET deleted_at = ?, updated_at = ? WHERE id = ?', [isoNow(), isoNow(), id]);
}

/** 审计细节：套件成员快照（不参与资源字段） */
export function suiteCaseIdsJson(db: DatabaseSync, id: string): string {
  return jsonText(caseIdsOf(db, id));
}