/**
 * Agent 脚手架仓储（官方 `init-agents` 产物的索引与结构校验结论）。
 * 契约视图：docs/api-contract.md §7、§11。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Page, Scaffold, ScaffoldFile } from '@pw-auto/contracts';
import { paginate } from '../db/paginate.ts';
import { get, run } from '../db/sql.ts';
import { AppError } from '../errors.ts';
import { jsonText, safeJsonParse } from '../utils.ts';

interface ScaffoldRow {
  id: string;
  loop: string;
  entry: string | null;
  official_loop: string | null;
  notes: string | null;
  prompts: number;
  target_dir: string;
  status: string;
  command_json: string;
  files_json: string;
  missing_json: string;
  error_json: string | null;
  created_at: string;
  finished_at: string;
}

function mapScaffold(row: ScaffoldRow): Scaffold {
  const rawLoop = row.loop === '' ? null : row.loop;
  // 兼容 v1 历史行：claude/codex 可映射；其他旧 loop 统一归入 deepseek（officialLoop=null，不伪造）
  const entry = (row.entry ?? (rawLoop === 'claude' ? 'claude' : rawLoop === 'codex' ? 'codex' : 'deepseek')) as Scaffold['entry'];
  const officialLoop = (row.official_loop ?? (rawLoop === 'claude' || rawLoop === 'codex' ? rawLoop : null)) as
    | 'claude'
    | 'codex'
    | null;
  return {
    id: row.id,
    loop: rawLoop,
    entry,
    officialLoop,
    prompts: Number(row.prompts) === 1,
    targetDir: row.target_dir,
    status: row.status as Scaffold['status'],
    command: safeJsonParse<string[]>(row.command_json, []),
    files: safeJsonParse<ScaffoldFile[]>(row.files_json, []),
    missing: safeJsonParse<string[]>(row.missing_json, []),
    ...(row.notes === null ? {} : { notes: row.notes }),
    error: safeJsonParse<Scaffold['error']>(row.error_json, null),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export function insertScaffold(db: DatabaseSync, scaffold: Scaffold): void {
  run(
    db,
    `INSERT INTO scaffolds(id, loop, entry, official_loop, notes, prompts, target_dir, status, command_json, files_json, missing_json, error_json, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scaffold.id,
      // loop 列 NOT NULL（v1）；deepseek 无官方 loop → 存空串，映射时还原为 null
      scaffold.loop ?? '',
      scaffold.entry,
      scaffold.officialLoop,
      scaffold.notes ?? null,
      scaffold.prompts ? 1 : 0,
      scaffold.targetDir,
      scaffold.status,
      jsonText(scaffold.command),
      jsonText(scaffold.files),
      jsonText(scaffold.missing),
      scaffold.error ? jsonText(scaffold.error) : null,
      scaffold.createdAt,
      scaffold.finishedAt,
    ],
  );
}

export function getScaffoldById(db: DatabaseSync, id: string): Scaffold | null {
  const row = get<ScaffoldRow>(db, 'SELECT * FROM scaffolds WHERE id = ?', [id]);
  return row ? mapScaffold(row) : null;
}

export function listScaffolds(db: DatabaseSync, query: { limit: number; cursor?: string | undefined; order: 'asc' | 'desc' }): Page<Scaffold> {
  return paginate<Scaffold>({
    db,
    select: 'SELECT *',
    from: 'FROM scaffolds',
    where: [],
    params: [],
    orderBy: 'created_at',
    idColumn: 'id',
    order: query.order,
    cursor: query.cursor,
    limit: query.limit,
    map: (row) => mapScaffold(row as unknown as ScaffoldRow),
  });
}

/** 最近一次「带 --prompts 且成功」的脚手架（GET /agents/prompts 的 official 来源） */
export function latestPromptScaffold(db: DatabaseSync): Scaffold | null {
  const row = get<ScaffoldRow>(
    db,
    `SELECT * FROM scaffolds WHERE prompts = 1 AND status = 'completed' ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  return row ? mapScaffold(row) : null;
}

export function latestScaffold(db: DatabaseSync): Scaffold | null {
  const row = get<ScaffoldRow>(db, 'SELECT * FROM scaffolds ORDER BY created_at DESC, id DESC LIMIT 1');
  return row ? mapScaffold(row) : null;
}

export function assertScaffoldExists(db: DatabaseSync, id: string): Scaffold {
  const found = getScaffoldById(db, id);
  if (!found) throw new AppError('NOT_FOUND', `脚手架不存在：${id}`);
  return found;
}