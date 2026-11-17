/**
 * 用例仓储（SQL 只出现在这一层，service 不拼 SQL）。
 * 契约视图：docs/api-contract.md §2、§11。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  Case,
  CaseListItem,
  CaseMode,
  CaseStatus,
  CaseListQuery,
  NlSourceRecord,
  Page,
  Step,
  StepOrigin,
} from '@pw-auto/contracts';
import { paginate } from '../db/paginate.ts';
import { get, run, type SqlValue } from '../db/sql.ts';
import { AppError } from '../errors.ts';
import { newId } from '../ids.ts';
import { isoNow, jsonText, safeJsonParse } from '../utils.ts';
import { deriveNlSourceForCase } from './nl-generations.ts';

interface CaseRow {
  id: string;
  name: string;
  description: string;
  mode: string;
  steps_json: string;
  code_text: string | null;
  tags_json: string;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  nl_json: string | null;
  step_origin_json: string | null;
}

export interface CreateCaseRecord {
  name: string;
  description: string;
  mode: CaseMode;
  steps: Step[];
  code: string | null;
  tags: string[];
  nl?: NlSourceRecord | null;
  stepOrigin?: StepOrigin | null;
}

export interface CasePatch {
  name?: string;
  description?: string;
  mode?: CaseMode;
  steps?: Step[];
  code?: string | null;
  tags?: string[];
  status?: CaseStatus;
}

function mapCase(db: DatabaseSync, row: CaseRow): Case {
  const nlRecord = row.nl_json === null ? null : safeJsonParse<NlSourceRecord | null>(row.nl_json, null);
  const stepOrigin = row.step_origin_json === null ? null : safeJsonParse<StepOrigin | null>(row.step_origin_json, null);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mode: row.mode as CaseMode,
    steps: safeJsonParse<Step[]>(row.steps_json, []),
    code: row.code_text,
    tags: safeJsonParse<string[]>(row.tags_json, []),
    status: row.status as CaseStatus,
    nl: nlRecord === null ? null : deriveNlSourceForCase(db, row.id, nlRecord),
    stepOrigin: stepOrigin ?? null,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapListItem(db: DatabaseSync, row: CaseRow): CaseListItem {
  const item = mapCase(db, row);
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    mode: item.mode,
    tags: item.tags,
    status: item.status,
    nl: item.nl,
    stepOrigin: item.stepOrigin,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
    stepsCount: item.steps.length,
    hasCode: item.code !== null && item.code !== '',
  };
}

export function insertCase(db: DatabaseSync, input: CreateCaseRecord): Case {
  const id = newId('case');
  const now = isoNow();
  run(
    db,
    `INSERT INTO cases(id, name, description, mode, steps_json, code_text, tags_json, status, version, created_at, updated_at, deleted_at, nl_json, step_origin_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL, ?, ?)`,
    [
      id,
      input.name,
      input.description,
      input.mode,
      jsonText(input.steps),
      input.code,
      jsonText(input.tags),
      now,
      now,
      input.nl === undefined || input.nl === null ? null : jsonText(input.nl),
      input.stepOrigin === undefined || input.stepOrigin === null ? null : jsonText(input.stepOrigin),
    ],
  );
  const created = getCaseById(db, id);
  if (!created) throw new AppError('INTERNAL_ERROR', '用例写入后无法读回（数据库异常）');
  return created;
}

/** 读取未删除的用例；不存在/已删除返回 null（调用方统一 404） */
export function getCaseById(db: DatabaseSync, id: string): Case | null {
  const row = get<CaseRow>(db, 'SELECT * FROM cases WHERE id = ? AND deleted_at IS NULL', [id]);
  return row ? mapCase(db, row) : null;
}

export function caseExists(db: DatabaseSync, id: string): boolean {
  return getCaseById(db, id) !== null;
}

export function listCases(db: DatabaseSync, query: CaseListQuery): Page<CaseListItem> {
  const where: string[] = ['deleted_at IS NULL'];
  const params: SqlValue[] = [];
  if (query.q) {
    where.push('(name LIKE ? OR description LIKE ?)');
    params.push(`%${query.q}%`, `%${query.q}%`);
  }
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(cases.tags_json) WHERE json_each.value = ?)');
    params.push(query.tag);
  }
  return paginate<CaseListItem>({
    db,
    select: 'SELECT *',
    from: 'FROM cases',
    where,
    params,
    orderBy: 'created_at',
    idColumn: 'id',
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => mapListItem(db, row as unknown as CaseRow),
  });
}

/**
 * 乐观锁更新（If-Match: "version"）。
 * 版本不匹配 → 409 VERSION_CONFLICT；用例不存在 → 404。
 */
export function updateCase(db: DatabaseSync, id: string, expectedVersion: number, patch: CasePatch): Case {
  const current = getCaseById(db, id);
  if (!current) throw new AppError('NOT_FOUND', `用例不存在或已删除：${id}`);
  if (current.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      `用例已被修改（当前版本 ${current.version}，请求版本 ${expectedVersion}），请刷新后重试`,
    );
  }

  const next = {
    name: patch.name ?? current.name,
    description: patch.description ?? current.description,
    mode: patch.mode ?? current.mode,
    steps: patch.steps ?? current.steps,
    code: patch.code !== undefined ? patch.code : current.code,
    tags: patch.tags ?? current.tags,
    status: patch.status ?? current.status,
    version: current.version + 1,
    updatedAt: isoNow(),
  };
  // 手工改 steps 时清除找不到来源的 stepOrigin（accept 之外唯一允许触碰 steps 的既有路径）
  const stepIds = new Set(next.steps.map((step) => step.id));
  const nextStepOrigin: StepOrigin | null =
    current.stepOrigin === null || current.stepOrigin === undefined
      ? null
      : Object.fromEntries(Object.entries(current.stepOrigin).filter(([stepId]) => stepIds.has(stepId)));

  run(
    db,
    `UPDATE cases SET name = ?, description = ?, mode = ?, steps_json = ?, code_text = ?, tags_json = ?, status = ?, version = ?, updated_at = ?, step_origin_json = ?
     WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    [
      next.name,
      next.description,
      next.mode,
      jsonText(next.steps),
      next.code,
      jsonText(next.tags),
      next.status,
      next.version,
      next.updatedAt,
      nextStepOrigin === null ? null : jsonText(nextStepOrigin),
      id,
      expectedVersion,
    ],
  );

  const updated = getCaseById(db, id);
  if (!updated) throw new AppError('INTERNAL_ERROR', '用例更新后无法读回（数据库异常）');
  return updated;
}

/** NL 文本写入/删除（PUT/DELETE /cases/{id}/nl）；不触碰 steps */
export function setCaseNl(
  db: DatabaseSync,
  id: string,
  record: NlSourceRecord | null,
  stepOrigin?: StepOrigin | null,
): Case {
  const current = getCaseById(db, id);
  if (!current) throw new AppError('NOT_FOUND', `用例不存在或已删除：${id}`);
  const now = isoNow();
  const nextStepOrigin = stepOrigin === undefined ? (current.stepOrigin ?? null) : stepOrigin;
  run(
    db,
    `UPDATE cases SET nl_json = ?, step_origin_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    [record === null ? null : jsonText(record), nextStepOrigin === null ? null : jsonText(nextStepOrigin), now, id],
  );
  const updated = getCaseById(db, id);
  if (!updated) throw new AppError('INTERNAL_ERROR', '用例更新后无法读回（数据库异常）');
  return updated;
}

/** accept 生成结果：唯一允许写 steps/stepOrigin 的路径（同时写入 nl 与版本号） */
export function applyNlGeneration(
  db: DatabaseSync,
  id: string,
  input: { mode: CaseMode; steps: Step[]; code: string | null; stepOrigin: StepOrigin | null; nl: NlSourceRecord },
): Case {
  const current = getCaseById(db, id);
  if (!current) throw new AppError('NOT_FOUND', `用例不存在或已删除：${id}`);
  const now = isoNow();
  run(
    db,
    `UPDATE cases SET mode = ?, steps_json = ?, code_text = ?, step_origin_json = ?, nl_json = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      input.mode,
      jsonText(input.steps),
      input.code,
      input.stepOrigin === null ? null : jsonText(input.stepOrigin),
      jsonText(input.nl),
      now,
      id,
    ],
  );
  const updated = getCaseById(db, id);
  if (!updated) throw new AppError('INTERNAL_ERROR', '用例更新后无法读回（数据库异常）');
  return updated;
}

/** 软删除：deletedAt 置值 + status=archived；重复删除幂等 */
export function softDeleteCase(db: DatabaseSync, id: string): void {
  const row = get<{ id: string; deleted_at: string | null; version: number }>(
    db,
    'SELECT id, deleted_at, version FROM cases WHERE id = ?',
    [id],
  );
  if (!row) throw new AppError('NOT_FOUND', `用例不存在：${id}`);
  if (row.deleted_at !== null) return;
  const now = isoNow();
  run(db, `UPDATE cases SET deleted_at = ?, status = 'archived', version = version + 1, updated_at = ? WHERE id = ?`, [
    now,
    now,
    id,
  ]);
}

/** 读取 NL 原始存储记录（供 NlService 读写；不含派生 status/lines） */
export function getCaseNlRecord(
  db: DatabaseSync,
  id: string,
): { record: NlSourceRecord | null; stepOrigin: StepOrigin | null } | null {
  const row = get<{ nl_json: string | null; step_origin_json: string | null }>(
    db,
    'SELECT nl_json, step_origin_json FROM cases WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
  if (!row) return null;
  return {
    record: row.nl_json === null ? null : safeJsonParse<NlSourceRecord | null>(row.nl_json, null),
    stepOrigin: row.step_origin_json === null ? null : safeJsonParse<StepOrigin | null>(row.step_origin_json, null),
  };
}

/** 用例引用的数据集数量（删除用例时的审计信息用） */
export function countDatasetsForCase(db: DatabaseSync, caseId: string): number {
  const row = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM datasets WHERE case_id = ? AND deleted_at IS NULL', [
    caseId,
  ]);
  return Number(row?.n ?? 0);
}