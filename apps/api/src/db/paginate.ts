/**
 * 游标分页（api-contract §0：`limit` 1..100 默认 20 + 不透明 `cursor`）。
 *
 * 游标内容 = base64url(JSON{k: 排序列值, i: 主键/稳定键})，对调用方不透明；
 * 排序恒为「排序列 + 稳定键」双列，保证翻页不重不漏。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@pw-auto/contracts';
import { AppError } from '../errors.ts';
import { all, type SqlValue } from './sql.ts';

export interface CursorPayload {
  k: string;
  i: string;
}

export function encodeCursor(key: string, id: string): string {
  return Buffer.from(JSON.stringify({ k: key, i: id } satisfies CursorPayload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (typeof record['k'] === 'string' && typeof record['i'] === 'string') {
        return { k: record['k'], i: record['i'] };
      }
    }
  } catch {
    // 落到统一错误
  }
  throw new AppError('VALIDATION_FAILED', 'cursor 非法：请原样透传上一页返回的 nextCursor');
}

export interface PageQuery<T> {
  db: DatabaseSync;
  /** 例：'SELECT *' */
  select: string;
  /** 例：'FROM cases'（不含 WHERE） */
  from: string;
  /** 追加条件（不含 LIMIT） */
  where: string[];
  params: SqlValue[];
  /** 排序列（created_at / row_index / item_key …） */
  orderBy: string;
  /** 稳定键列（id / item_key …） */
  idColumn: string;
  /** 排序列是否按数值比较（row_index 等） */
  numeric?: boolean;
  order: 'asc' | 'desc';
  cursor?: string | undefined;
  limit: number;
  map: (row: Record<string, unknown>) => T;
}

export function paginate<T>(query: PageQuery<T>): Page<T> {
  const direction = query.order === 'desc' ? '<' : '>';
  const where = [...query.where];
  const params: SqlValue[] = [...query.params];

  if (query.cursor) {
    const { k, i } = decodeCursor(query.cursor);
    if (query.numeric) {
      where.push(
        `(CAST(${query.orderBy} AS REAL) ${direction} CAST(? AS REAL) OR (CAST(${query.orderBy} AS REAL) = CAST(? AS REAL) AND ${query.idColumn} ${direction} ?))`,
      );
    } else {
      where.push(`(${query.orderBy} ${direction} ? OR (${query.orderBy} = ? AND ${query.idColumn} ${direction} ?))`);
    }
    params.push(k, k, i);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `${query.select} ${query.from} ${whereSql} ORDER BY ${query.orderBy} ${query.order.toUpperCase()}, ${query.idColumn} ${query.order.toUpperCase()} LIMIT ?`;
  params.push(query.limit + 1);

  const rows = all<Record<string, unknown>>(query.db, sql, params);
  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const items = pageRows.map(query.map);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor(String(last[query.orderBy] ?? ''), String(last[query.idColumn] ?? ''))
      : null;

  return { items, nextCursor, hasMore };
}