/**
 * 回归对比仓储（对比结论 + 逐项差异）。契约视图：docs/api-contract.md §6.2、§11。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  Comparison,
  ComparisonItem,
  ComparisonListQuery,
  ComparisonSummary,
  Page,
} from '@pw-auto/contracts';
import { paginate } from '../db/paginate.ts';
import { all, get, run, type SqlValue } from '../db/sql.ts';
import { AppError } from '../errors.ts';
import { newId } from '../ids.ts';
import { isoNow, jsonText, safeJsonParse } from '../utils.ts';

interface ComparisonRow {
  id: string;
  baseline_id: string;
  run_id: string;
  scope: string;
  scope_id: string;
  summary_json: string;
  created_at: string;
}

interface ComparisonItemRow {
  comparison_id: string;
  item_key: string;
  row_index: number | null;
  change: string;
  base_outcome: string;
  target_outcome: string;
  error_changed: number;
  base_error_hash: string | null;
  target_error_hash: string | null;
  duration_delta_ms: number | null;
  artifact_delta_json: string;
  attribution_json: string | null;
}

function mapComparison(row: ComparisonRow): Comparison {
  return {
    id: row.id,
    baselineId: row.baseline_id,
    baselineRunId: '',
    runId: row.run_id,
    scope: row.scope as Comparison['scope'],
    scopeId: row.scope_id,
    summary: safeJsonParse<ComparisonSummary>(row.summary_json, {
      total: 0,
      newly_failed: 0,
      newly_passed: 0,
      still_failed: 0,
      still_passed: 0,
      flaky: 0,
      became_flaky: 0,
      skipped: 0,
      new_item: 0,
      missing_item: 0,
      unknown: 0,
      verdict: 'unchanged',
      verdictBasis: 'computed',
    }),
    createdAt: row.created_at,
  };
}

function mapComparisonItem(row: ComparisonItemRow): ComparisonItem {
  const delta = safeJsonParse<{ added: string[]; removed: string[] }>(row.artifact_delta_json, {
    added: [],
    removed: [],
  });
  const attribution = safeJsonParse<ComparisonItem['attribution']>(row.attribution_json, null);
  return {
    itemKey: row.item_key,
    rowIndex: row.row_index === null ? null : Number(row.row_index),
    change: row.change as ComparisonItem['change'],
    baseOutcome: row.base_outcome as ComparisonItem['baseOutcome'],
    targetOutcome: row.target_outcome as ComparisonItem['targetOutcome'],
    errorChanged: Number(row.error_changed) === 1,
    baseErrorHash: row.base_error_hash,
    targetErrorHash: row.target_error_hash,
    durationDeltaMs: row.duration_delta_ms === null ? null : Number(row.duration_delta_ms),
    artifactDelta: { added: delta.added, removed: delta.removed },
    attribution: attribution ?? null,
  };
}

export function insertComparison(
  db: DatabaseSync,
  input: {
    comparison: Omit<Comparison, 'baselineRunId'> & { baselineRunId: string };
    items: readonly ComparisonItem[];
  },
): Comparison {
  const id = input.comparison.id;
  run(
    db,
    `INSERT INTO comparisons(id, baseline_id, run_id, scope, scope_id, summary_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.comparison.baselineId,
      input.comparison.runId,
      input.comparison.scope,
      input.comparison.scopeId,
      jsonText(input.comparison.summary),
      input.comparison.createdAt,
    ],
  );
  for (const item of input.items) {
    run(
      db,
      `INSERT INTO comparison_items(comparison_id, item_key, row_index, change, base_outcome, target_outcome,
         error_changed, base_error_hash, target_error_hash, duration_delta_ms, artifact_delta_json, attribution_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        item.itemKey,
        item.rowIndex,
        item.change,
        item.baseOutcome,
        item.targetOutcome,
        item.errorChanged ? 1 : 0,
        item.baseErrorHash,
        item.targetErrorHash,
        item.durationDeltaMs,
        jsonText(item.artifactDelta),
        item.attribution ? jsonText(item.attribution) : null,
      ],
    );
  }
  const created = getComparisonById(db, id);
  if (!created) throw new AppError('INTERNAL_ERROR', '对比写入后无法读回（数据库异常）');
  return created;
}

export function getComparisonById(db: DatabaseSync, id: string): Comparison | null {
  const row = get<ComparisonRow>(db, 'SELECT * FROM comparisons WHERE id = ?', [id]);
  if (!row) return null;
  const comparison = mapComparison(row);
  const baselineRun = get<{ run_id: string }>(db, 'SELECT run_id FROM baselines WHERE id = ?', [comparison.baselineId]);
  return { ...comparison, baselineRunId: baselineRun?.run_id ?? '' };
}

export function listComparisonItems(
  db: DatabaseSync,
  comparisonId: string,
  query: { limit: number; cursor?: string | undefined; order: 'asc' | 'desc' },
): Page<ComparisonItem> {
  return paginate<ComparisonItem>({
    db,
    select: 'SELECT *',
    from: 'FROM comparison_items',
    where: ['comparison_id = ?'],
    params: [comparisonId],
    orderBy: 'item_key',
    idColumn: 'item_key',
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => mapComparisonItem(row as unknown as ComparisonItemRow),
  });
}

export function listAllComparisonItems(db: DatabaseSync, comparisonId: string): ComparisonItem[] {
  return all<ComparisonItemRow>(db, 'SELECT * FROM comparison_items WHERE comparison_id = ? ORDER BY item_key ASC', [
    comparisonId,
  ]).map(mapComparisonItem);
}

export function listComparisons(db: DatabaseSync, query: ComparisonListQuery): Page<Comparison> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (query.runId) {
    where.push('run_id = ?');
    params.push(query.runId);
  }
  if (query.baselineId) {
    where.push('baseline_id = ?');
    params.push(query.baselineId);
  }
  return paginate<Comparison>({
    db,
    select: 'SELECT *',
    from: 'FROM comparisons',
    where,
    params,
    orderBy: 'created_at',
    idColumn: 'id',
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => {
      const comparison = mapComparison(row as unknown as ComparisonRow);
      const baselineRun = get<{ run_id: string }>(db, 'SELECT run_id FROM baselines WHERE id = ?', [
        comparison.baselineId,
      ]);
      return { ...comparison, baselineRunId: baselineRun?.run_id ?? '' };
    },
  });
}