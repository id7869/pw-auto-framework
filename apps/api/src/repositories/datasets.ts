/**
 * 数据集仓储：数据集 + 行（行号 0 基稳定，PUT rows 全量替换后重排）。
 * 契约视图：docs/api-contract.md §3、§11。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  CellValue,
  Dataset,
  DatasetRow,
  DatasetRowListQuery,
  DatasetSource,
  Page,
  RowData,
} from '@pw-auto/contracts';
import { paginate } from '../db/paginate.ts';
import { all, get, run, type SqlValue } from '../db/sql.ts';
import { AppError } from '../errors.ts';
import { newId } from '../ids.ts';
import { isoNow, jsonText, safeJsonParse } from '../utils.ts';

interface DatasetRowRecord {
  id: string;
  case_id: string;
  name: string;
  source: string;
  columns_json: string;
  created_at: string;
  updated_at: string;
}

interface DatasetRowEntity {
  id: string;
  dataset_id: string;
  row_index: number;
  data_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function mapDataset(db: DatabaseSync, row: DatasetRowRecord): Dataset {
  const counts = datasetCounts(db, row.id);
  return {
    id: row.id,
    caseId: row.case_id,
    name: row.name,
    source: row.source as DatasetSource,
    columns: safeJsonParse<string[]>(row.columns_json, []),
    rowsCount: counts.rowsCount,
    enabledRowsCount: counts.enabledRowsCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRow(row: DatasetRowEntity): DatasetRow {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    rowIndex: Number(row.row_index),
    data: safeJsonParse<RowData>(row.data_json, {}),
    enabled: Number(row.enabled) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function datasetCounts(db: DatabaseSync, datasetId: string): { rowsCount: number; enabledRowsCount: number } {
  const row = get<{ total: number; enabled: number }>(
    db,
    'SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled FROM dataset_rows WHERE dataset_id = ?',
    [datasetId],
  );
  return { rowsCount: Number(row?.total ?? 0), enabledRowsCount: Number(row?.enabled ?? 0) };
}

/** 列集合 = 所有行 key 的并集（保持首次出现顺序） */
export function deriveColumns(rows: readonly { data: RowData }[]): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.data)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  return columns;
}

export interface DatasetRowSeed {
  data: RowData;
  enabled: boolean;
}

function insertRows(db: DatabaseSync, datasetId: string, rows: readonly DatasetRowSeed[]): void {
  const now = isoNow();
  rows.forEach((row, index) => {
    run(
      db,
      `INSERT INTO dataset_rows(id, dataset_id, row_index, data_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId('row'), datasetId, index, jsonText(row.data), row.enabled ? 1 : 0, now, now],
    );
  });
}

function refreshColumns(db: DatabaseSync, datasetId: string): void {
  const rows = all<{ data_json: string }>(db, 'SELECT data_json FROM dataset_rows WHERE dataset_id = ? ORDER BY row_index ASC', [
    datasetId,
  ]);
  const columns = deriveColumns(rows.map((row) => ({ data: safeJsonParse<RowData>(row.data_json, {}) })));
  run(db, 'UPDATE datasets SET columns_json = ?, updated_at = ? WHERE id = ?', [jsonText(columns), isoNow(), datasetId]);
}

export function insertDataset(
  db: DatabaseSync,
  input: { caseId: string; name: string; source: DatasetSource; rows: DatasetRowSeed[]; columns: string[] },
): Dataset {
  const id = newId('dataset');
  const now = isoNow();
  run(
    db,
    `INSERT INTO datasets(id, case_id, name, source, columns_json, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [id, input.caseId, input.name, input.source, jsonText(input.columns), now, now],
  );
  insertRows(db, id, input.rows);
  refreshColumns(db, id);
  const created = getDatasetById(db, id);
  if (!created) throw new AppError('INTERNAL_ERROR', '数据集写入后无法读回（数据库异常）');
  return created;
}

export function getDatasetById(db: DatabaseSync, id: string): Dataset | null {
  const row = get<DatasetRowRecord>(db, 'SELECT * FROM datasets WHERE id = ? AND deleted_at IS NULL', [id]);
  return row ? mapDataset(db, row) : null;
}

export function listDatasetsByCase(
  db: DatabaseSync,
  caseId: string,
  query: { limit: number; cursor?: string | undefined; order: 'asc' | 'desc' },
): Page<Dataset> {
  return paginate<Dataset>({
    db,
    select: 'SELECT *',
    from: 'FROM datasets',
    where: ['case_id = ?', 'deleted_at IS NULL'],
    params: [caseId],
    orderBy: 'created_at',
    idColumn: 'id',
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => mapDataset(db, row as unknown as DatasetRowRecord),
  });
}

/** 用例的「默认（第一个）」数据集：套件运行使用（api-contract §4 注） */
export function getFirstDatasetForCase(db: DatabaseSync, caseId: string): Dataset | null {
  const row = get<DatasetRowRecord>(
    db,
    'SELECT * FROM datasets WHERE case_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1',
    [caseId],
  );
  return row ? mapDataset(db, row) : null;
}

export function renameDataset(db: DatabaseSync, id: string, name: string): Dataset {
  const existing = getDatasetById(db, id);
  if (!existing) throw new AppError('NOT_FOUND', `数据集不存在或已删除：${id}`);
  run(db, 'UPDATE datasets SET name = ?, updated_at = ? WHERE id = ?', [name, isoNow(), id]);
  const updated = getDatasetById(db, id);
  if (!updated) throw new AppError('INTERNAL_ERROR', '数据集更新后无法读回（数据库异常）');
  return updated;
}

export function softDeleteDataset(db: DatabaseSync, id: string): void {
  const row = get<{ id: string; deleted_at: string | null }>(db, 'SELECT id, deleted_at FROM datasets WHERE id = ?', [id]);
  if (!row) throw new AppError('NOT_FOUND', `数据集不存在：${id}`);
  if (row.deleted_at !== null) return;
  run(db, 'UPDATE datasets SET deleted_at = ?, updated_at = ? WHERE id = ?', [isoNow(), isoNow(), id]);
}

export function listRows(db: DatabaseSync, datasetId: string, query: DatasetRowListQuery): Page<DatasetRow> {
  const where: string[] = ['dataset_id = ?'];
  const params: SqlValue[] = [datasetId];
  if (query.enabled !== undefined) {
    where.push('enabled = ?');
    params.push(query.enabled === 'true' ? 1 : 0);
  }
  return paginate<DatasetRow>({
    db,
    select: 'SELECT *',
    from: 'FROM dataset_rows',
    where,
    params,
    orderBy: 'row_index',
    idColumn: 'id',
    numeric: true,
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => mapRow(row as unknown as DatasetRowEntity),
  });
}

/** 引擎输入：只取 enabled 行，按 rowIndex 升序 */
export function listEnabledRows(db: DatabaseSync, datasetId: string): DatasetRow[] {
  return all<DatasetRowEntity>(
    db,
    'SELECT * FROM dataset_rows WHERE dataset_id = ? AND enabled = 1 ORDER BY row_index ASC',
    [datasetId],
  ).map(mapRow);
}

/** 全量替换（旧行号失效；历史运行使用已固化的快照，不受影响） */
export function replaceRows(db: DatabaseSync, datasetId: string, rows: readonly DatasetRowSeed[]): Dataset {
  const existing = getDatasetById(db, datasetId);
  if (!existing) throw new AppError('NOT_FOUND', `数据集不存在或已删除：${datasetId}`);
  run(db, 'DELETE FROM dataset_rows WHERE dataset_id = ?', [datasetId]);
  insertRows(db, datasetId, rows);
  refreshColumns(db, datasetId);
  const updated = getDatasetById(db, datasetId);
  if (!updated) throw new AppError('INTERNAL_ERROR', '数据集更新后无法读回（数据库异常）');
  return updated;
}

/** 计算列并集（供 service 在写入前校验列名/列数） */
export function columnsOfRows(rows: readonly DatasetRowSeed[]): string[] {
  return deriveColumns(rows);
}

export type { DatasetRowSeed as DatasetRowSeedType };
export type CellValueType = CellValue;