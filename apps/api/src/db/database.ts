/**
 * 数据库生命周期：打开/迁移/健康检查/关闭。
 *
 * 单文件库 `<dataDir>/pw-auto.db`；PRAGMA 取值见 architecture §3.4：
 * journal_mode=WAL、synchronous=NORMAL、busy_timeout=5000、foreign_keys=ON。
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir } from '../paths.ts';
import { all, get, withTransaction } from './sql.ts';
import { MIGRATIONS } from './migrations.ts';

export function databaseFile(dataDir: string): string {
  return join(dataDir, 'pw-auto.db');
}

export function openDatabase(dataDir: string): DatabaseSync {
  ensureDir(dataDir);
  const db = new DatabaseSync(databaseFile(dataDir));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** 幂等迁移：逐个版本检查后执行，全部语句在同一事务内 */
export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    all<{ version: number }>(db, 'SELECT version FROM schema_migrations').map((row) => Number(row.version)),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    withTransaction(db, () => {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
    });
  }
}

/** 健康检查：一次 SELECT 1（api-contract §1.1 的 db 字段） */
export function checkDatabase(db: DatabaseSync): boolean {
  try {
    const row = get<{ ok: number }>(db, 'SELECT 1 AS ok');
    return row?.ok === 1;
  } catch {
    return false;
  }
}

export function closeDatabase(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // 已关闭时忽略（shutdown 可能被调用多次）
  }
}