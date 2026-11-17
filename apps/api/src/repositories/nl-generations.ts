/**
 * NL 生成任务仓储（nl_generations 表；7 态 + 租约 + 快照）。
 * 契约：docs/api-contract.md §12.3 / 附录 A.8、§11 增量表。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  NlGeneration,
  NlGenerationListQuery,
  NlGenerationQueueQuery,
  NlGenerationStatus,
  NlGenerator,
  NlOrigin,
  NlSourceRecord,
  NlWarning,
  Page,
  StepOrigin,
} from '@pw-auto/contracts';
import { paginate } from '../db/paginate.ts';
import { get, run, type SqlValue } from '../db/sql.ts';
import { jsonText, safeJsonParse } from '../utils.ts';
import { buildNlLines, deriveNlStatus, nlSourceHash } from '../nl/model.ts';

interface NlGenerationRow {
  id: string;
  case_id: string;
  generator: string;
  status: string;
  source_hash: string;
  origin: string | null;
  generator_version: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
  lease_attempts: number;
  case_name: string;
  nl_text: string;
  dataset_columns_json: string;
  hints_json: string | null;
  steps_json: string | null;
  step_origin_json: string | null;
  code_text: string | null;
  warnings_json: string;
  fallback: number;
  error_json: string | null;
  submitted_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  failed_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapGeneration(row: NlGenerationRow): NlGeneration {
  const hints = safeJsonParse<Record<string, string> | null>(row.hints_json, null);
  return {
    id: row.id,
    caseId: row.case_id,
    generator: row.generator as NlGenerator,
    status: row.status as NlGenerationStatus,
    sourceHash: row.source_hash,
    origin: (row.origin as NlOrigin | null) ?? null,
    generatorVersion: row.generator_version,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    leaseAttempts: Number(row.lease_attempts),
    fallback: Number(row.fallback) === 1,
    caseName: row.case_name,
    nlText: row.nl_text,
    datasetColumns: safeJsonParse<string[]>(row.dataset_columns_json, []),
    ...(hints === null ? {} : { hints }),
    stepOrigin: safeJsonParse<StepOrigin | null>(row.step_origin_json, null),
    steps: safeJsonParse<unknown[] | null>(row.steps_json, null),
    code: row.code_text,
    warnings: safeJsonParse<NlWarning[]>(row.warnings_json, []),
    error: safeJsonParse<NlGeneration['error']>(row.error_json, null),
    submittedAt: row.submitted_at,
    acceptedAt: row.accepted_at,
    rejectedAt: row.rejected_at,
    failedAt: row.failed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertNlGenerationInput {
  caseId: string;
  generator: NlGenerator;
  status: NlGenerationStatus;
  sourceHash: string;
  caseName: string;
  nlText: string;
  datasetColumns: string[];
  hints?: Record<string, string> | undefined;
  origin?: NlOrigin | null;
}

export function insertNlGeneration(db: DatabaseSync, id: string, input: InsertNlGenerationInput, now: string): NlGeneration {
  run(
    db,
    `INSERT INTO nl_generations(id, case_id, generator, status, source_hash, origin, lease_attempts,
       case_name, nl_text, dataset_columns_json, hints_json, warnings_json, fallback, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, '[]', 0, ?, ?)`,
    [
      id,
      input.caseId,
      input.generator,
      input.status,
      input.sourceHash,
      input.origin ?? null,
      input.caseName,
      input.nlText,
      jsonText(input.datasetColumns),
      input.hints === undefined ? null : jsonText(input.hints),
      now,
      now,
    ],
  );
  const created = getNlGenerationById(db, id);
  if (!created) throw new Error('NL 生成任务写入后无法读回');
  return created;
}

export function getNlGenerationById(db: DatabaseSync, id: string): NlGeneration | null {
  const row = get<NlGenerationRow>(db, 'SELECT * FROM nl_generations WHERE id = ?', [id]);
  return row ? mapGeneration(row) : null;
}

export function listNlGenerationsForCase(
  db: DatabaseSync,
  caseId: string,
  query: NlGenerationListQuery,
): Page<NlGeneration> {
  const where = ['case_id = ?'];
  const params: SqlValue[] = [caseId];
  const statuses = query.status === undefined ? null : query.status.split(',').map((item) => item.trim()).filter(Boolean);
  if (statuses !== null && statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  return paginate<NlGeneration>({
    db,
    select: 'SELECT *',
    from: 'FROM nl_generations',
    where,
    params,
    orderBy: 'created_at',
    idColumn: 'id',
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => mapGeneration(row as unknown as NlGenerationRow),
  });
}

export function listNlQueue(db: DatabaseSync, statuses: readonly string[], query: NlGenerationQueueQuery): Page<NlGeneration> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  return paginate<NlGeneration>({
    db,
    select: 'SELECT *',
    from: 'FROM nl_generations',
    where,
    params,
    orderBy: 'created_at',
    idColumn: 'id',
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => mapGeneration(row as unknown as NlGenerationRow),
  });
}

export function activeNlGenerationForCase(db: DatabaseSync, caseId: string): NlGeneration | null {
  const row = get<NlGenerationRow>(
    db,
    `SELECT * FROM nl_generations WHERE case_id = ? AND status IN ('queued','running','ready')
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [caseId],
  );
  return row ? mapGeneration(row) : null;
}

export function latestAcceptedNlGeneration(db: DatabaseSync, caseId: string): NlGeneration | null {
  const row = get<NlGenerationRow>(
    db,
    `SELECT * FROM nl_generations WHERE case_id = ? AND status = 'accepted' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [caseId],
  );
  return row ? mapGeneration(row) : null;
}

export function latestNlGeneration(db: DatabaseSync, caseId: string): NlGeneration | null {
  const row = get<NlGenerationRow>(
    db,
    'SELECT * FROM nl_generations WHERE case_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [caseId],
  );
  return row ? mapGeneration(row) : null;
}

export interface NlGenerationPatch {
  status?: NlGenerationStatus;
  origin?: NlOrigin | null;
  generatorVersion?: string | null;
  leaseId?: string | null;
  leaseExpiresAt?: string | null;
  leaseAttempts?: number;
  steps?: unknown[] | null;
  stepOrigin?: StepOrigin | null;
  code?: string | null;
  warnings?: NlWarning[];
  error?: NlGeneration['error'];
  fallback?: boolean;
  submittedAt?: string | null;
  acceptedAt?: string | null;
  rejectedAt?: string | null;
  failedAt?: string | null;
}

export function updateNlGeneration(db: DatabaseSync, id: string, patch: NlGenerationPatch, now: string): NlGeneration {
  const current = getNlGenerationById(db, id);
  if (!current) throw new Error(`NL 生成任务不存在：${id}`);
  const next = {
    status: patch.status ?? current.status,
    origin: patch.origin !== undefined ? patch.origin : current.origin,
    generatorVersion: patch.generatorVersion !== undefined ? patch.generatorVersion : current.generatorVersion,
    leaseId: patch.leaseId !== undefined ? patch.leaseId : current.leaseId,
    leaseExpiresAt: patch.leaseExpiresAt !== undefined ? patch.leaseExpiresAt : current.leaseExpiresAt,
    leaseAttempts: patch.leaseAttempts ?? current.leaseAttempts,
    steps: patch.steps !== undefined ? patch.steps : current.steps,
    code: patch.code !== undefined ? patch.code : current.code,
    warnings: patch.warnings ?? current.warnings,
    error: patch.error !== undefined ? patch.error : current.error,
    fallback: patch.fallback ?? current.fallback,
    submittedAt: patch.submittedAt !== undefined ? patch.submittedAt : current.submittedAt,
    acceptedAt: patch.acceptedAt !== undefined ? patch.acceptedAt : current.acceptedAt,
    rejectedAt: patch.rejectedAt !== undefined ? patch.rejectedAt : current.rejectedAt,
    failedAt: patch.failedAt !== undefined ? patch.failedAt : current.failedAt,
    stepOrigin: patch.stepOrigin !== undefined ? patch.stepOrigin : null,
  };
  run(
    db,
    `UPDATE nl_generations SET status = ?, origin = ?, generator_version = ?, lease_id = ?, lease_expires_at = ?,
       lease_attempts = ?, steps_json = ?, step_origin_json = ?, code_text = ?, warnings_json = ?, error_json = ?,
       fallback = ?, submitted_at = ?, accepted_at = ?, rejected_at = ?, failed_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      next.status,
      next.origin,
      next.generatorVersion,
      next.leaseId,
      next.leaseExpiresAt,
      next.leaseAttempts,
      next.steps === null ? null : jsonText(next.steps),
      next.stepOrigin === null ? null : jsonText(next.stepOrigin),
      next.code,
      jsonText(next.warnings),
      next.error === null ? null : jsonText(next.error),
      next.fallback ? 1 : 0,
      next.submittedAt,
      next.acceptedAt,
      next.rejectedAt,
      next.failedAt,
      now,
      id,
    ],
  );
  const updated = getNlGenerationById(db, id);
  if (!updated) throw new Error('NL 生成任务更新后无法读回');
  return updated;
}

/** 由 cases 表读取 stepOrigin（避免 cases repo ↔ nl repo 循环依赖） */
function stepOriginOfCase(db: DatabaseSync, caseId: string): StepOrigin | null {
  const row = get<{ step_origin_json: string | null }>(db, 'SELECT step_origin_json FROM cases WHERE id = ?', [caseId]);
  if (!row || row.step_origin_json === null) return null;
  return safeJsonParse<StepOrigin | null>(row.step_origin_json, null);
}

/** 读取时派生 NlSource（status/lines/warnings 由任务历史 + 文本哈希唯一决定） */
export function deriveNlSourceForCase(
  db: DatabaseSync,
  caseId: string,
  record: NlSourceRecord,
): NlSourceRecord & { status: ReturnType<typeof deriveNlStatus>; lines: ReturnType<typeof buildNlLines> } {
  const active = activeNlGenerationForCase(db, caseId);
  const accepted = latestAcceptedNlGeneration(db, caseId);
  const latest = latestNlGeneration(db, caseId);
  const currentHash = nlSourceHash(record.text);
  const status = deriveNlStatus({
    text: record.text,
    currentHash,
    hasActive: active !== null,
    acceptedHash: accepted?.sourceHash ?? null,
    latestStatus: latest?.status ?? null,
  });
  const unmapped = new Set(record.warnings.filter((w) => w.code === 'NL_LINE_UNMAPPED' && w.line > 0).map((w) => w.line));
  return {
    ...record,
    sourceHash: currentHash,
    status,
    lines: buildNlLines(record.text, stepOriginOfCase(db, caseId), unmapped),
  };
}
