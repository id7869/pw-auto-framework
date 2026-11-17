/**
 * 数据集服务：列/行边界校验（错误码固定，不降级为 VALIDATION_FAILED）。
 * 契约：docs/api-contract.md §3。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  DATASET_LIMITS,
  isValidColumnName,
  type CreateDatasetRequest,
  type Dataset,
  type DatasetRow,
  type DatasetRowListQuery,
  type Page,
  type PutDatasetRowsRequest,
} from '@pw-auto/contracts';
import type { ErrorDetail } from '@pw-auto/contracts';
import { AppError } from '../errors.ts';
import { writeAudit } from '../repositories/audit.ts';
import * as caseRepo from '../repositories/cases.ts';
import * as datasetRepo from '../repositories/datasets.ts';
import type { DatasetRowSeed } from '../repositories/datasets.ts';

function validateRows(rows: readonly DatasetRowSeed[]): void {
  if (rows.length > DATASET_LIMITS.maxRows) {
    throw new AppError(
      'ROW_LIMIT_EXCEEDED',
      `数据行数 ${rows.length} 超过上限 ${DATASET_LIMITS.maxRows} 行`,
      [{ path: 'rows', message: `最多 ${DATASET_LIMITS.maxRows} 行` }],
    );
  }

  const details: ErrorDetail[] = [];
  rows.forEach((row, index) => {
    for (const [column, value] of Object.entries(row.data)) {
      if (typeof value === 'string' && value.length > DATASET_LIMITS.maxCellChars) {
        details.push({
          path: `rows[${index}].data.${column}`,
          message: `单元格长度 ${value.length} 超过上限 ${DATASET_LIMITS.maxCellChars} 字符`,
        });
      }
    }
  });
  if (details.length > 0) {
    throw new AppError('ROW_TOO_LARGE', details[0]?.message ?? '单元格过大', details);
  }

  if (rows.length === 0) return;
  const columns = datasetRepo.columnsOfRows(rows);
  if (columns.length < DATASET_LIMITS.minColumns || columns.length > DATASET_LIMITS.maxColumns) {
    throw new AppError(
      'INVALID_DATASET',
      `列数 ${columns.length} 不在 ${DATASET_LIMITS.minColumns}..${DATASET_LIMITS.maxColumns} 范围内`,
      [{ path: 'rows', message: `列数须为 ${DATASET_LIMITS.minColumns}..${DATASET_LIMITS.maxColumns}` }],
    );
  }
  const badNames = columns.filter((name) => !isValidColumnName(name));
  if (badNames.length > 0) {
    throw new AppError(
      'INVALID_DATASET',
      `列名非法（1..${DATASET_LIMITS.maxColumnNameChars} 字符且不得含 {{ }}）：${badNames.join('、')}`,
      badNames.map((name) => ({ path: 'rows', message: `列名非法：${name}` })),
    );
  }
}

export class DatasetService {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private requireCase(caseId: string): void {
    if (!caseRepo.caseExists(this.db, caseId)) {
      throw new AppError('NOT_FOUND', `用例不存在或已删除：${caseId}`);
    }
  }

  private requireDataset(datasetId: string): Dataset {
    const found = datasetRepo.getDatasetById(this.db, datasetId);
    if (!found) throw new AppError('NOT_FOUND', `数据集不存在或已删除：${datasetId}`);
    return found;
  }

  listForCase(caseId: string, query: { limit: number; cursor?: string | undefined; order: 'asc' | 'desc' }): Page<Dataset> {
    this.requireCase(caseId);
    return datasetRepo.listDatasetsByCase(this.db, caseId, query);
  }

  create(caseId: string, input: CreateDatasetRequest, actor: string): Dataset {
    this.requireCase(caseId);
    validateRows(input.rows);
    const columns = datasetRepo.columnsOfRows(input.rows);
    const created = datasetRepo.insertDataset(this.db, {
      caseId,
      name: input.name,
      source: input.source,
      rows: input.rows,
      columns,
    });
    writeAudit(this.db, {
      actor,
      action: 'dataset.create',
      target: created.id,
      detail: { caseId, rowsCount: created.rowsCount, columns: created.columns.length },
    });
    return created;
  }

  get(datasetId: string): Dataset {
    return this.requireDataset(datasetId);
  }

  rename(datasetId: string, name: string, actor: string): Dataset {
    this.requireDataset(datasetId);
    const updated = datasetRepo.renameDataset(this.db, datasetId, name);
    writeAudit(this.db, { actor, action: 'dataset.update', target: datasetId });
    return updated;
  }

  remove(datasetId: string, actor: string): void {
    this.requireDataset(datasetId);
    datasetRepo.softDeleteDataset(this.db, datasetId);
    writeAudit(this.db, { actor, action: 'dataset.delete', target: datasetId });
  }

  rows(datasetId: string, query: DatasetRowListQuery): Page<DatasetRow> {
    this.requireDataset(datasetId);
    return datasetRepo.listRows(this.db, datasetId, query);
  }

  replaceRows(datasetId: string, input: PutDatasetRowsRequest, actor: string): Dataset {
    this.requireDataset(datasetId);
    validateRows(input.rows);
    const updated = datasetRepo.replaceRows(this.db, datasetId, input.rows);
    writeAudit(this.db, {
      actor,
      action: 'dataset.rows.replace',
      target: datasetId,
      detail: { rowsCount: updated.rowsCount, enabledRowsCount: updated.enabledRowsCount },
    });
    return updated;
  }
}