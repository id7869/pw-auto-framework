/**
 * 数据库迁移（启动时幂等执行，schema_migrations 记录版本）。
 *
 * 表结构的**契约视图**见 docs/api-contract.md §11；这里是其 SQL 落地，
 * 额外列（如 items/artifacts 计数、幂等键表）属于实现细节，不改变对外资源字段。
 */

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

const INIT_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS cases (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     mode TEXT NOT NULL,
     steps_json TEXT NOT NULL DEFAULT '[]',
     code_text TEXT,
     tags_json TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     deleted_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cases_created ON cases(created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status)`,

  `CREATE TABLE IF NOT EXISTS datasets (
     id TEXT PRIMARY KEY,
     case_id TEXT NOT NULL,
     name TEXT NOT NULL,
     source TEXT NOT NULL,
     columns_json TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     deleted_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_datasets_case ON datasets(case_id, created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS dataset_rows (
     id TEXT PRIMARY KEY,
     dataset_id TEXT NOT NULL,
     row_index INTEGER NOT NULL,
     data_json TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE(dataset_id, row_index),
     FOREIGN KEY(dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_dataset_rows_order ON dataset_rows(dataset_id, row_index ASC, id ASC)`,

  `CREATE TABLE IF NOT EXISTS suites (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     deleted_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_suites_created ON suites(created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS suite_cases (
     suite_id TEXT NOT NULL,
     case_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     PRIMARY KEY(suite_id, case_id),
     FOREIGN KEY(suite_id) REFERENCES suites(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_suite_cases_seq ON suite_cases(suite_id, seq ASC)`,

  `CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     case_id TEXT,
     suite_id TEXT,
     dataset_id TEXT,
     options_json TEXT NOT NULL,
     case_snapshot_json TEXT NOT NULL,
     status TEXT NOT NULL,
     queue_position INTEGER,
     requested_at TEXT NOT NULL,
     started_at TEXT,
     finished_at TEXT,
     cancel_requested_at TEXT,
     exit_code INTEGER,
     stats_json TEXT NOT NULL DEFAULT '{}',
     environment_json TEXT NOT NULL DEFAULT '{}',
     error_json TEXT,
     diagnostics_json TEXT NOT NULL DEFAULT '{}',
     idempotency_key TEXT UNIQUE,
     workspace_dir TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, requested_at)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_case ON runs(case_id, requested_at)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(requested_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS run_items (
     run_id TEXT NOT NULL,
     item_key TEXT NOT NULL,
     case_id TEXT NOT NULL,
     row_index INTEGER,
     title TEXT NOT NULL,
     project_name TEXT,
     outcome TEXT NOT NULL,
     duration_ms REAL NOT NULL DEFAULT 0,
     attempts_json TEXT NOT NULL DEFAULT '[]',
     PRIMARY KEY(run_id, item_key),
     FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_run_items_outcome ON run_items(run_id, outcome)`,

  `CREATE TABLE IF NOT EXISTS artifacts (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     item_key TEXT,
     kind TEXT NOT NULL,
     rel_path TEXT NOT NULL,
     file_name TEXT NOT NULL,
     size_bytes INTEGER NOT NULL DEFAULT 0,
     sha256 TEXT NOT NULL,
     content_type TEXT NOT NULL,
     created_at TEXT NOT NULL,
     FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_run_kind ON artifacts(run_id, kind)`,

  `CREATE TABLE IF NOT EXISTS baselines (
     id TEXT PRIMARY KEY,
     scope TEXT NOT NULL,
     scope_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     name TEXT NOT NULL,
     note TEXT,
     is_default INTEGER NOT NULL DEFAULT 0,
     archived_at TEXT,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_baselines_scope ON baselines(scope, scope_id, created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS comparisons (
     id TEXT PRIMARY KEY,
     baseline_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     scope TEXT NOT NULL,
     scope_id TEXT NOT NULL,
     summary_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_comparisons_run ON comparisons(run_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_comparisons_baseline ON comparisons(baseline_id)`,

  `CREATE TABLE IF NOT EXISTS comparison_items (
     comparison_id TEXT NOT NULL,
     item_key TEXT NOT NULL,
     row_index INTEGER,
     change TEXT NOT NULL,
     base_outcome TEXT NOT NULL,
     target_outcome TEXT NOT NULL,
     error_changed INTEGER NOT NULL DEFAULT 0,
     base_error_hash TEXT,
     target_error_hash TEXT,
     duration_delta_ms REAL,
     artifact_delta_json TEXT NOT NULL DEFAULT '{}',
     attribution_json TEXT,
     PRIMARY KEY(comparison_id, item_key),
     FOREIGN KEY(comparison_id) REFERENCES comparisons(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_comparison_items_order ON comparison_items(comparison_id, item_key ASC)`,

  `CREATE TABLE IF NOT EXISTS scaffolds (
     id TEXT PRIMARY KEY,
     loop TEXT NOT NULL,
     prompts INTEGER NOT NULL DEFAULT 0,
     target_dir TEXT NOT NULL,
     status TEXT NOT NULL,
     command_json TEXT NOT NULL DEFAULT '[]',
     files_json TEXT NOT NULL DEFAULT '[]',
     missing_json TEXT NOT NULL DEFAULT '[]',
     error_json TEXT,
     created_at TEXT NOT NULL,
     finished_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_scaffolds_created ON scaffolds(created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS mcp_sessions (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     server_info_json TEXT,
     protocol_version TEXT,
     caps_json TEXT NOT NULL DEFAULT '[]',
     tools_json TEXT NOT NULL DEFAULT '[]',
     headless INTEGER NOT NULL DEFAULT 1,
     isolated INTEGER NOT NULL DEFAULT 1,
     work_dir TEXT NOT NULL,
     pid INTEGER,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     error_json TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     target TEXT,
     detail_json TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC)`,

  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     key TEXT PRIMARY KEY,
     scope TEXT NOT NULL,
     request_hash TEXT NOT NULL,
     resource_id TEXT NOT NULL,
     response_status INTEGER NOT NULL,
     created_at TEXT NOT NULL
   )`,
];

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    statements: INIT_SQL,
  },
  {
    version: 2,
    name: 'nl-first',
    statements: [
      // 用例侧增量（不删不改既有列）
      `ALTER TABLE cases ADD COLUMN nl_json TEXT`,
      `ALTER TABLE cases ADD COLUMN step_origin_json TEXT`,
      // 生成任务（7 态 + 租约 + 快照）
      `CREATE TABLE IF NOT EXISTS nl_generations (
         id TEXT PRIMARY KEY,
         case_id TEXT NOT NULL,
         generator TEXT NOT NULL,
         status TEXT NOT NULL,
         source_hash TEXT NOT NULL,
         origin TEXT,
         generator_version TEXT,
         lease_id TEXT,
         lease_expires_at TEXT,
         lease_attempts INTEGER NOT NULL DEFAULT 0,
         case_name TEXT NOT NULL,
         nl_text TEXT NOT NULL,
         dataset_columns_json TEXT NOT NULL DEFAULT '[]',
         hints_json TEXT,
         steps_json TEXT,
         step_origin_json TEXT,
         code_text TEXT,
         warnings_json TEXT NOT NULL DEFAULT '[]',
         fallback INTEGER NOT NULL DEFAULT 0,
         error_json TEXT,
         submitted_at TEXT,
         accepted_at TEXT,
         rejected_at TEXT,
         failed_at TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_nl_generations_case ON nl_generations(case_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_nl_generations_status ON nl_generations(status, created_at DESC)`,
      // scaffold 三入口增量（entry/official_loop/notes；loop 允许 NULL 表示 deepseek 无官方 loop）
      `ALTER TABLE scaffolds ADD COLUMN entry TEXT`,
      `ALTER TABLE scaffolds ADD COLUMN official_loop TEXT`,
      `ALTER TABLE scaffolds ADD COLUMN notes TEXT`,
    ],
  },
];