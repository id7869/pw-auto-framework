/**
 * 运行仓储：运行记录 + 逐项结果 + 产物索引。
 * 契约视图：docs/api-contract.md §5、§11（统计列以子查询实时计算，避免计数漂移）。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  EMPTY_RUN_STATS,
  type Artifact,
  type ArtifactListQuery,
  type Page,
  type Run,
  type RunError,
  type RunItem,
  type RunItemListQuery,
  type RunListQuery,
  type RunStats,
  type RunStatus,
  type EnvironmentFingerprint,
  type RunDiagnostics,
  type RunOptions,
} from '@pw-auto/contracts';
import { paginate } from '../db/paginate.ts';
import { all, get, run, type SqlValue } from '../db/sql.ts';
import { AppError } from '../errors.ts';
import type { RunSnapshot } from '../snapshot.ts';
import { jsonText, safeJsonParse } from '../utils.ts';

interface RunRow {
  id: string;
  kind: string;
  case_id: string | null;
  suite_id: string | null;
  dataset_id: string | null;
  options_json: string;
  case_snapshot_json: string;
  status: string;
  queue_position: number | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested_at: string | null;
  exit_code: number | null;
  stats_json: string;
  environment_json: string;
  error_json: string | null;
  diagnostics_json: string;
  idempotency_key: string | null;
  workspace_dir: string;
  items_count?: number;
  artifacts_count?: number;
}

interface RunItemRow {
  run_id: string;
  item_key: string;
  case_id: string;
  row_index: number | null;
  title: string;
  project_name: string | null;
  outcome: string;
  duration_ms: number;
  attempts_json: string;
}

interface ArtifactRow {
  id: string;
  run_id: string;
  item_key: string | null;
  kind: string;
  rel_path: string;
  file_name: string;
  size_bytes: number;
  sha256: string;
  content_type: string;
  created_at: string;
}

const DEFAULT_DIAGNOSTICS: RunDiagnostics = {
  playwrightCliPath: '',
  command: [],
  specPath: null,
  reportPath: null,
  workspaceDir: '',
  warnings: [],
};

const DEFAULT_ENVIRONMENT: EnvironmentFingerprint = {
  node: process.versions.node,
  playwright: 'unknown',
  browser: 'unknown',
  os: process.platform,
  timezone: 'unknown',
};

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    kind: row.kind as Run['kind'],
    caseId: row.case_id,
    suiteId: row.suite_id,
    datasetId: row.dataset_id,
    options: safeJsonParse<RunOptions>(row.options_json, {
      retries: 0,
      workers: 1,
      timeoutMs: 60000,
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      video: 'off',
      headed: false,
      browser: 'chromium',
      failOnFlaky: false,
      allowStaleNl: false,
    }),
    status: row.status as RunStatus,
    queuePosition: row.queue_position === null ? null : Number(row.queue_position),
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cancelRequestedAt: row.cancel_requested_at,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    stats: safeJsonParse<RunStats>(row.stats_json, EMPTY_RUN_STATS),
    itemsCount: Number(row.items_count ?? 0),
    artifactsCount: Number(row.artifacts_count ?? 0),
    environment: safeJsonParse<EnvironmentFingerprint>(row.environment_json, DEFAULT_ENVIRONMENT),
    error: safeJsonParse<RunError | null>(row.error_json, null),
    diagnostics: { ...DEFAULT_DIAGNOSTICS, ...safeJsonParse<RunDiagnostics>(row.diagnostics_json, DEFAULT_DIAGNOSTICS) },
    idempotencyKey: row.idempotency_key,
  };
}

function mapRunItem(row: RunItemRow): RunItem {
  return {
    itemKey: row.item_key,
    caseId: row.case_id,
    rowIndex: row.row_index === null ? null : Number(row.row_index),
    title: row.title,
    projectName: row.project_name,
    outcome: row.outcome as RunItem['outcome'],
    durationMs: Number(row.duration_ms),
    attempts: safeJsonParse<RunItem['attempts']>(row.attempts_json, []),
  };
}

function mapArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    runId: row.run_id,
    itemKey: row.item_key,
    kind: row.kind as Artifact['kind'],
    fileName: row.file_name,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    contentType: row.content_type,
    createdAt: row.created_at,
  };
}

const RUN_SELECT =
  'SELECT runs.*, (SELECT COUNT(*) FROM run_items WHERE run_id = runs.id) AS items_count, (SELECT COUNT(*) FROM artifacts WHERE run_id = runs.id) AS artifacts_count';

export interface StoredRun {
  run: Run;
  snapshot: RunSnapshot;
  workspaceDir: string;
  idempotencyKey: string | null;
}

export function insertRun(
  db: DatabaseSync,
  input: { run: Run; snapshot: RunSnapshot; workspaceDir: string; idempotencyKey: string | null },
): void {
  const record = input.run;
  run(
    db,
    `INSERT INTO runs(id, kind, case_id, suite_id, dataset_id, options_json, case_snapshot_json, status, queue_position,
       requested_at, started_at, finished_at, cancel_requested_at, exit_code, stats_json, environment_json, error_json,
       diagnostics_json, idempotency_key, workspace_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.kind,
      record.caseId,
      record.suiteId,
      record.datasetId,
      jsonText(record.options),
      jsonText(input.snapshot),
      record.status,
      record.queuePosition,
      record.requestedAt,
      record.startedAt,
      record.finishedAt,
      record.cancelRequestedAt,
      record.exitCode,
      jsonText(record.stats),
      jsonText(record.environment),
      record.error === null ? null : jsonText(record.error),
      jsonText(record.diagnostics),
      input.idempotencyKey,
      input.workspaceDir,
    ],
  );
}

export function getRunById(db: DatabaseSync, id: string): Run | null {
  const row = get<RunRow>(db, `${RUN_SELECT} FROM runs WHERE runs.id = ?`, [id]);
  return row ? mapRun(row) : null;
}

export function getStoredRun(db: DatabaseSync, id: string): StoredRun | null {
  const row = get<RunRow>(db, `${RUN_SELECT} FROM runs WHERE runs.id = ?`, [id]);
  if (!row) return null;
  return {
    run: mapRun(row),
    snapshot: safeJsonParse<RunSnapshot>(row.case_snapshot_json, { kind: 'case', case: null, suite: null }),
    workspaceDir: row.workspace_dir,
    idempotencyKey: row.idempotency_key,
  };
}

export function listRuns(db: DatabaseSync, query: RunListQuery): Page<Run> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (query.status) {
    where.push('runs.status = ?');
    params.push(query.status);
  }
  if (query.caseId) {
    where.push('runs.case_id = ?');
    params.push(query.caseId);
  }
  if (query.suiteId) {
    where.push('runs.suite_id = ?');
    params.push(query.suiteId);
  }
  return paginate<Run>({
    db,
    select: RUN_SELECT,
    from: 'FROM runs',
    where,
    params,
    orderBy: 'requested_at',
    idColumn: 'id',
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => mapRun(row as unknown as RunRow),
  });
}

export function markRunRunning(db: DatabaseSync, id: string, startedAt: string): void {
  run(db, `UPDATE runs SET status = 'running', started_at = ?, queue_position = NULL WHERE id = ?`, [startedAt, id]);
}

export function setQueuePosition(db: DatabaseSync, id: string, position: number | null): void {
  run(db, 'UPDATE runs SET queue_position = ? WHERE id = ?', [position, id]);
}

export function setCancelRequested(db: DatabaseSync, id: string, at: string): void {
  run(db, 'UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?) WHERE id = ?', [at, id]);
}

export interface RunProgressPatch {
  stats?: RunStats;
  environment?: EnvironmentFingerprint;
  diagnostics?: RunDiagnostics;
}

export function saveRunProgress(db: DatabaseSync, id: string, patch: RunProgressPatch): void {
  const fields: string[] = [];
  const params: SqlValue[] = [];
  if (patch.stats) {
    fields.push('stats_json = ?');
    params.push(jsonText(patch.stats));
  }
  if (patch.environment) {
    fields.push('environment_json = ?');
    params.push(jsonText(patch.environment));
  }
  if (patch.diagnostics) {
    fields.push('diagnostics_json = ?');
    params.push(jsonText(patch.diagnostics));
  }
  if (fields.length === 0) return;
  params.push(id);
  run(db, `UPDATE runs SET ${fields.join(', ')} WHERE id = ?`, params);
}

export interface RunFinishPatch {
  status: RunStatus;
  finishedAt: string;
  exitCode: number | null;
  stats: RunStats;
  error: RunError | null;
  environment?: EnvironmentFingerprint;
  diagnostics: RunDiagnostics;
}

export function finishRun(db: DatabaseSync, id: string, patch: RunFinishPatch): void {
  run(
    db,
    `UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, stats_json = ?, error_json = ?, environment_json = COALESCE(?, environment_json),
       diagnostics_json = ?, queue_position = NULL WHERE id = ?`,
    [
      patch.status,
      patch.finishedAt,
      patch.exitCode,
      jsonText(patch.stats),
      patch.error === null ? null : jsonText(patch.error),
      patch.environment ? jsonText(patch.environment) : null,
      jsonText(patch.diagnostics),
      id,
    ],
  );
}

export function listQueuedRuns(db: DatabaseSync): { id: string; requestedAt: string }[] {
  return all<{ id: string; requested_at: string }>(
    db,
    `SELECT id, requested_at FROM runs WHERE status = 'queued' ORDER BY requested_at ASC, id ASC`,
  ).map((row) => ({ id: row.id, requestedAt: row.requested_at }));
}

export function countRunsInStatuses(db: DatabaseSync, statuses: readonly RunStatus[]): number {
  if (statuses.length === 0) return 0;
  const placeholders = statuses.map(() => '?').join(',');
  const row = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM runs WHERE status IN (${placeholders})`, [...statuses]);
  return Number(row?.n ?? 0);
}

export function listNonTerminalRunIds(db: DatabaseSync): string[] {
  return all<{ id: string }>(db, `SELECT id FROM runs WHERE status IN ('queued','running') ORDER BY requested_at ASC`).map(
    (row) => row.id,
  );
}

/** 后端重启：非终态运行一律置 error（RUN_INTERRUPTED，api-contract §0.5） */
export function markInterruptedRuns(db: DatabaseSync, at: string): string[] {
  const ids = listNonTerminalRunIds(db);
  for (const id of ids) {
    const row = get<RunRow>(db, 'SELECT * FROM runs WHERE id = ?', [id]);
    if (!row) continue;
    const record = mapRun(row);
    finishRun(db, id, {
      status: 'error',
      finishedAt: at,
      exitCode: record.exitCode,
      stats: record.stats,
      error: { code: 'RUN_INTERRUPTED', message: '后端重启导致运行中断（未产出完整结果）' },
      diagnostics: { ...record.diagnostics, warnings: [...record.diagnostics.warnings, 'RUN_INTERRUPTED'] },
    });
  }
  return ids;
}

export function insertRunItems(db: DatabaseSync, runId: string, items: readonly RunItem[]): void {
  for (const item of items) {
    run(
      db,
      `INSERT OR REPLACE INTO run_items(run_id, item_key, case_id, row_index, title, project_name, outcome, duration_ms, attempts_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        item.itemKey,
        item.caseId,
        item.rowIndex,
        item.title,
        item.projectName,
        item.outcome,
        item.durationMs,
        jsonText(item.attempts),
      ],
    );
  }
}

export function listRunItems(db: DatabaseSync, runId: string, query: RunItemListQuery): Page<RunItem> {
  const where: string[] = ['run_id = ?'];
  const params: SqlValue[] = [runId];
  if (query.status) {
    where.push('outcome = ?');
    params.push(query.status);
  }
  if (query.rowIndex !== undefined) {
    where.push('row_index = ?');
    params.push(query.rowIndex);
  }
  return paginate<RunItem>({
    db,
    select: 'SELECT *',
    from: 'FROM run_items',
    where,
    params,
    orderBy: 'item_key',
    idColumn: 'item_key',
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => mapRunItem(row as unknown as RunItemRow),
  });
}

export function getRunItemByKey(db: DatabaseSync, runId: string, itemKey: string): RunItem | null {
  const row = get<RunItemRow>(db, 'SELECT * FROM run_items WHERE run_id = ? AND item_key = ?', [runId, itemKey]);
  return row ? mapRunItem(row) : null;
}

export function listAllRunItems(db: DatabaseSync, runId: string): RunItem[] {
  return all<RunItemRow>(db, 'SELECT * FROM run_items WHERE run_id = ? ORDER BY item_key ASC', [runId]).map(mapRunItem);
}

export interface ArtifactInsert {
  id: string;
  itemKey: string | null;
  kind: Artifact['kind'];
  relPath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  createdAt: string;
}

export function insertArtifacts(db: DatabaseSync, runId: string, artifacts: readonly ArtifactInsert[]): void {
  for (const artifact of artifacts) {
    run(
      db,
      `INSERT OR REPLACE INTO artifacts(id, run_id, item_key, kind, rel_path, file_name, size_bytes, sha256, content_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        artifact.id,
        runId,
        artifact.itemKey,
        artifact.kind,
        artifact.relPath,
        artifact.fileName,
        artifact.sizeBytes,
        artifact.sha256,
        artifact.contentType,
        artifact.createdAt,
      ],
    );
  }
}

export function listArtifacts(db: DatabaseSync, runId: string, query: ArtifactListQuery): Page<Artifact> {
  const where: string[] = ['run_id = ?'];
  const params: SqlValue[] = [runId];
  if (query.kind) {
    where.push('kind = ?');
    params.push(query.kind);
  }
  return paginate<Artifact>({
    db,
    select: 'SELECT *',
    from: 'FROM artifacts',
    where,
    params,
    orderBy: 'created_at',
    idColumn: 'id',
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => mapArtifact(row as unknown as ArtifactRow),
  });
}

export function getStoredArtifact(
  db: DatabaseSync,
  runId: string,
  artifactId: string,
): { artifact: Artifact; relPath: string } | null {
  const row = get<ArtifactRow>(db, 'SELECT * FROM artifacts WHERE run_id = ? AND id = ?', [runId, artifactId]);
  if (!row) return null;
  return { artifact: mapArtifact(row), relPath: row.rel_path };
}

/** 逐项产物的 kind 集合（回归对比的「产物差异」输入） */
export function artifactKindsByItem(db: DatabaseSync, runId: string): Map<string, Set<string>> {
  const rows = all<{ item_key: string; kind: string }>(
    db,
    'SELECT item_key, kind FROM artifacts WHERE run_id = ? AND item_key IS NOT NULL',
    [runId],
  );
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = map.get(row.item_key) ?? new Set<string>();
    set.add(row.kind);
    map.set(row.item_key, set);
  }
  return map;
}

/** 保留策略：超出 PW_KEEP_RUNS 的最旧终态运行（跳过基线引用的运行） */
export function listRunIdsForRetention(db: DatabaseSync, keep: number): string[] {
  const rows = all<{ id: string }>(
    db,
    `SELECT runs.id FROM runs
     WHERE runs.status IN ('passed','failed','cancelled','error')
       AND runs.id NOT IN (SELECT run_id FROM baselines)
     ORDER BY runs.requested_at DESC, runs.id DESC`,
  );
  return rows.slice(Math.max(0, keep)).map((row) => row.id);
}

export function deleteRunCascade(db: DatabaseSync, runId: string): void {
  run(db, 'DELETE FROM comparison_items WHERE comparison_id IN (SELECT id FROM comparisons WHERE run_id = ?)', [runId]);
  run(db, 'DELETE FROM comparisons WHERE run_id = ?', [runId]);
  run(db, 'DELETE FROM run_items WHERE run_id = ?', [runId]);
  run(db, 'DELETE FROM artifacts WHERE run_id = ?', [runId]);
  run(db, 'DELETE FROM runs WHERE id = ?', [runId]);
}

export function assertRunExists(db: DatabaseSync, id: string): Run {
  const found = getRunById(db, id);
  if (!found) throw new AppError('NOT_FOUND', `运行不存在：${id}`);
  return found;
}