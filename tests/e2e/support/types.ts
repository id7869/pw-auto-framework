/**
 * 验收套件用到的 API 资源最小类型（只声明断言需要的字段，避免与产品 contracts 耦合）。
 * 字段名严格来自 docs/api-contract.md。
 */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
    requestId: string;
  };
}

export interface CaseStep {
  id: string;
  action: string;
  label?: string;
  target?: Record<string, unknown>;
  value?: string;
  url?: string;
  key?: string;
  state?: string;
  fullPage?: boolean;
  width?: number;
  height?: number;
  timeoutMs?: number;
  exact?: boolean;
}

export interface Case {
  id: string;
  name: string;
  description: string;
  mode: 'steps' | 'code';
  steps: CaseStep[];
  code: string | null;
  tags: string[];
  status: 'active' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
  /** NL-first 增量（R6）：只读派生视图；旧用例为 null/缺省 */
  nl?: NlSource | null;
  /** stepId → NL 行号（accept 写入） */
  stepOrigin?: Record<string, { nlLine: number }> | null;
}

export interface CaseListItem extends Omit<Case, 'steps' | 'code'> {
  stepsCount: number;
  hasCode: boolean;
}

export interface Dataset {
  id: string;
  caseId: string;
  name: string;
  source: string;
  columns: string[];
  rowsCount: number;
  enabledRowsCount: number;
}

export interface DatasetRow {
  id: string;
  datasetId: string;
  rowIndex: number;
  data: Record<string, string | number | boolean | null>;
  enabled: boolean;
}

export interface Suite {
  id: string;
  name: string;
  description: string;
  caseIds: string[];
  casesCount: number;
}

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'error';
export type ItemOutcome = 'expected' | 'unexpected' | 'flaky' | 'skipped' | 'missing' | 'unknown';

export interface RunStats {
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
  durationMs: number;
}

export interface RunDiagnostics {
  playwrightCliPath: string;
  command: string[];
  specPath: string | null;
  reportPath: string | null;
  workspaceDir: string;
  warnings: string[];
}

export interface Run {
  id: string;
  kind: 'case' | 'suite';
  caseId: string | null;
  suiteId: string | null;
  datasetId: string | null;
  options: Record<string, unknown>;
  status: RunStatus;
  queuePosition: number | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  exitCode: number | null;
  stats: RunStats;
  itemsCount: number;
  artifactsCount: number;
  environment: Record<string, string>;
  error: { code: string; message: string; detail?: unknown } | null;
  diagnostics: RunDiagnostics;
  idempotencyKey: string | null;
}

export interface RunItemAttempt {
  attempt: number;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  durationMs: number;
  startTime: string;
  error: { message: string; stack?: string; snippet?: string; location?: { file: string; line: number; column: number } } | null;
  errorHash: string;
  steps: { title: string; durationMs: number; error: string | null }[];
  attachments: { name: string; contentType: string; artifactId: string | null }[];
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface RunItem {
  itemKey: string;
  caseId: string;
  rowIndex: number | null;
  title: string;
  projectName: string | null;
  outcome: ItemOutcome;
  durationMs: number;
  attempts: RunItemAttempt[];
}

export interface Artifact {
  id: string;
  runId: string;
  itemKey: string | null;
  kind: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  createdAt: string;
}

export interface Baseline {
  id: string;
  scope: 'case' | 'suite';
  scopeId: string;
  runId: string;
  name: string;
  note: string | null;
  isDefault: boolean;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ComparisonSummary {
  total: number;
  newly_failed: number;
  newly_passed: number;
  still_failed: number;
  still_passed: number;
  flaky: number;
  became_flaky: number;
  skipped: number;
  new_item: number;
  missing_item: number;
  unknown: number;
  verdict: 'regression' | 'improvement' | 'unchanged' | 'mixed';
  verdictBasis: 'computed';
}

export interface ComparisonItem {
  itemKey: string;
  rowIndex: number | null;
  change: string;
  baseOutcome: ItemOutcome;
  targetOutcome: ItemOutcome;
  errorChanged: boolean;
  baseErrorHash: string | null;
  targetErrorHash: string | null;
  durationDeltaMs: number | null;
  artifactDelta: { added: string[]; removed: string[] };
  attribution?: {
    category: string;
    /** 失败原因分类（8 类；非失败类变化为 null） */
    failureCategory?: string | null;
    confidence: string;
    evidence: string[];
  } | null;
}

export interface Comparison {
  id: string;
  baselineId: string;
  baselineRunId: string;
  runId: string;
  scope: 'case' | 'suite';
  scopeId: string;
  summary: ComparisonSummary;
  createdAt: string;
}

export interface ComparisonDetail {
  comparison: Comparison;
  items: ComparisonItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MetaResponse {
  app: { name: string };
  versions: {
    node: string;
    playwright: string;
    playwrightCliPath: string;
    playwrightSource?: 'cli' | 'fallback';
    playwrightVersionError?: string;
    browser: Record<string, string>;
    os: string;
  };
  limits: Record<string, number>;
  env: { bindHost: string; port: number; dataDir: string; staticDir: string; corsOrigins: string[] };
  capabilities: {
    mcp: { enabled: boolean; sessions: number };
    cli: { enabled: boolean; unsafeEnabled: boolean };
    agents: { entries: AgentEntry[] };
    sse: boolean;
    unsafeTools: boolean;
  };
}

export interface McpSession {
  id: string;
  status: 'starting' | 'ready' | 'closing' | 'closed' | 'error';
  serverInfo: { name: string; version: string } | null;
  protocolVersion: string | null;
  caps: string[];
  tools: { name: string; description?: string }[];
  headless: boolean;
  isolated: boolean;
  workDir: string;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  error: { code: string; message: string } | null;
}

export interface McpToolCallResult {
  content: unknown[];
  isError: boolean;
  durationMs: number;
}

export interface Scaffold {
  id: string;
  /** 实际执行的官方 loop（deepseek 无官方 loop → null） */
  loop: string | null;
  entry: AgentEntry;
  officialLoop: 'claude' | 'codex' | null;
  prompts: boolean;
  targetDir: string;
  status: 'completed' | 'failed';
  command: string[];
  files: { path: string; sizeBytes: number; sha256: string }[];
  missing: string[];
  notes?: string;
  error: { code: string; message: string } | null;
  createdAt: string;
  finishedAt: string;
}

export interface CliExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  json: unknown;
  parsed: unknown;
  durationMs: number;
  artifacts: { kind: string; path: string }[];
}

// ---------------------------------------------------------------------------
// NL-first（R6）与三 harness 入口（R7）——按 docs/api-contract.md §12/§13
// ---------------------------------------------------------------------------

export type AgentEntry = 'claude' | 'codex' | 'deepseek';
export type NlStatus = 'draft' | 'generating' | 'generated' | 'stale' | 'invalid';
export type NlGenerationStatus =
  | 'queued'
  | 'running'
  | 'ready'
  | 'accepted'
  | 'rejected'
  | 'failed'
  | 'cancelled';
export type NlWarningCode =
  | 'NL_LINE_UNMAPPED'
  | 'NL_TARGET_AMBIGUOUS'
  | 'NL_UNSUPPORTED_ACTION'
  | 'NL_NO_ASSERTION';

export interface NlWarning {
  code: NlWarningCode;
  line: number;
  message: string;
}

export interface NlLine {
  line: number;
  text: string;
  kind: 'blank' | 'comment' | 'instruction' | 'step' | 'unmapped';
  stepId?: string | null;
}

export interface NlSource {
  text: string;
  status: NlStatus;
  sourceHash: string;
  origin: 'agent' | 'rule' | null;
  generatorVersion: string | null;
  warnings: NlWarning[];
  lines: NlLine[];
  updatedAt: string;
  generatedAt?: string | null;
}

export interface StepOrigin {
  [stepId: string]: { nlLine: number };
}

export interface NlGeneration {
  id: string;
  caseId: string;
  generator: 'agent' | 'rule';
  status: NlGenerationStatus;
  sourceHash: string;
  origin: 'agent' | 'rule' | null;
  generatorVersion: string | null;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  leaseAttempts: number;
  fallback: boolean;
  caseName: string;
  nlText: string;
  datasetColumns: string[];
  hints?: Record<string, string>;
  stepOrigin?: StepOrigin | null;
  steps?: unknown[] | null;
  code?: string | null;
  warnings: NlWarning[];
  error: { code: string; message: string } | null;
  submittedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NlSpecPreview {
  text: string;
  stepsCount: number;
  rowsCount: number;
  warnings: string[];
}

export interface HarnessSkillPath {
  scope: 'project' | 'user' | 'shared';
  path: string;
}

export interface HarnessInfo {
  entry: AgentEntry;
  label: string;
  officialLoop: 'claude' | 'codex' | null;
  requiresMcp: false;
  skillPaths: HarnessSkillPath[];
  notes?: string;
}

export interface AgentEntryInfo {
  entry: AgentEntry;
  loop: 'claude' | 'codex' | null;
  description: string;
}