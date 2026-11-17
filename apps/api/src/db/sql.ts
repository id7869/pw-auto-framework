/**
 * `node:sqlite` 薄封装：只做参数绑定与类型收敛，不隐藏 SQL（SQL 仍属实现细节）。
 *
 * 约束：
 * - 唯一允许访问数据库的位置是 `apps/api`（architecture §3.1 硬规则 2）；
 * - 所有写操作走 `withTransaction`，避免半写状态；
 * - `node:sqlite` 不支持 boolean，统一以 0/1 INTEGER 落库（读时转回 boolean）。
 */

import type { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;

export function all<T>(db: DatabaseSync, sql: string, params: SqlValue[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function get<T>(db: DatabaseSync, sql: string, params: SqlValue[] = []): T | null {
  const row = db.prepare(sql).get(...params) as unknown as T | undefined;
  return row === undefined ? null : row;
}

export function run(db: DatabaseSync, sql: string, params: SqlValue[] = []): { changes: number } {
  const result = db.prepare(sql).run(...params);
  return { changes: Number(result.changes) };
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败时保留原始错误（sqlite 已在事务异常时自动回滚）
    }
    throw error;
  }
}

export function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

export function intToBool(value: number | bigint | null | undefined): boolean {
  return Number(value ?? 0) === 1;
}

export function nullToStr(value: string | null | undefined): string | null {
  return value === undefined ? null : value;
}