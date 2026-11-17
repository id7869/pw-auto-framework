/**
 * 前端消费的 HTTP 合同类型，逐字段对应 docs/api-contract.md（v1.0 冻结）。
 *
 * 纪律：
 * - 只在这里声明「后端已合同化」的字段；不得发明接口或字段。
 * - 与 packages/contracts 重叠的枚举/常量从合同包导入（单一来源），其余
 *   因合同包当前只导出了少量公共类型，在前端按合同文档镜像声明。
 */
import type { ComparisonChange, ItemOutcome, RunStatus } from '@pw-auto/contracts';

export type { ComparisonChange, ItemOutcome, RunStatus };

/** 通用分页容器，见 api-contract §0.1 / 附录 A.2 */
export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** GET /api/health，见 §1.1 */
export interface Health {
  status: 'ok' | 'degraded';
  uptimeMs: number;
  db: 'ok' | 'error';
  version: string;
}

/** GET /api/v1/meta，见 §1.2 */
export interface Meta {
  app: { name: string };
  versions: {
    node: string;
    playwright: string;
    playwrightCliPath: string;
    browser: { name: string; channel?: string; version?: string };
    os: string;
  };
  limits: {
    runTimeoutMs: number;
    caseTimeoutMs: number;
    maxConcurrentRuns: number;
    keepRuns: number;
    bodyLimitBytes: number;
  };
  env: {
    bindHost: string;
    port: number;
    dataDir: string;
    staticDir: string | null;
    corsOrigins: string[];
  };
  capabilities: {
    mcp: { enabled: boolean; sessions: number };
    cli: { enabled: boolean; unsafeEnabled: boolean };
    agents: { entries: AgentEntry[] };
    sse: boolean;
    unsafeTools: boolean;
  };
}

export type TargetBy = 'role' | 'testId' | 'label' | 'placeholder' | 'text' | 'alt' | 'title' | 'css';

/** 定位器目标，见 §2.2 */
export interface Target {
  by: TargetBy;
  role?: string;
  name?: string;
  exact?: boolean;
  level?: number;
  testId?: string;
  text?: string;
  selector?: string;
}

export const STEP_ACTIONS = [
  'goto',
  'click',
  'dblclick',
  'fill',
  'press',
  'select',
  'check',
  'uncheck',
  'hover',
  'waitFor',
  'expectVisible',
  'expectText',
  'expectValue',
  'expectURL',
  'expectTitle',
  'screenshot',
  'setViewport',
] as const;

export type StepAction = (typeof STEP_ACTIONS)[number];

export const WAIT_STATES = ['visible', 'hidden', 'attached', 'detached'] as const;
export type WaitState = (typeof WAIT_STATES)[number];

// ── NL-first（api-contract §12）────────────────────────────────────────────
export const NL_STATUSES = ['draft', 'generating', 'generated', 'stale', 'invalid'] as const;
export type NlStatus = (typeof NL_STATUSES)[number];

export const NL_ORIGINS = ['agent', 'rule'] as const;
export type NlOrigin = (typeof NL_ORIGINS)[number];

export const NL_WARNING_CODES = [
  'NL_LINE_UNMAPPED',
  'NL_TARGET_AMBIGUOUS',
  'NL_UNSUPPORTED_ACTION',
  'NL_NO_ASSERTION',
] as const;
export type NlWarningCode = (typeof NL_WARNING_CODES)[number];

export const NL_LINE_KINDS = ['blank', 'comment', 'instruction', 'step', 'unmapped'] as const;
export type NlLineKind = (typeof NL_LINE_KINDS)[number];

export interface NlLine {
  line: number;
  text: string;
  kind: NlLineKind;
  stepId?: string | null;
}

export interface NlWarning {
  code: NlWarningCode;
  line: number;
  message: string;
}

export interface NlSource {
  text: string;
  status: NlStatus;
  sourceHash: string;
  origin: NlOrigin | null;
  generatorVersion: string | null;
  warnings: NlWarning[];
  lines: NlLine[];
  updatedAt: string;
  generatedAt?: string | null;
}

/** stepId → NL 行号（1 基） */
export type StepOrigin = Record<string, { nlLine: number }>;

export const NL_GENERATION_STATUSES = [
  'queued',
  'running',
  'ready',
  'accepted',
  'rejected',
  'failed',
  'cancelled',
] as const;
export type NlGenerationStatus = (typeof NL_GENERATION_STATUSES)[number];

export type NlGenerator = 'agent' | 'rule';

export interface NlGeneration {
  id: string;
  caseId: string;
  generator: NlGenerator;
  status: NlGenerationStatus;
  sourceHash: string;
  origin: NlOrigin | null;
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
  steps: unknown[] | null;
  code: string | null;
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

/** 结构化步骤，见 §2.2（每个步骤 = 一次官方 API 调用） */
export interface Step {
  id: string;
  action: StepAction;
  label?: string;
  target?: Target;
  value?: string;
  url?: string;
  key?: string;
  state?: WaitState;
  fullPage?: boolean;
  width?: number;
  height?: number;
  timeoutMs?: number;
  exact?: boolean;
}

export type CaseMode = 'steps' | 'code';
export type CaseStatus = 'active' | 'archived';

/** 用例资源，见 §2.1 */
export interface Case {
  id: string;
  name: string;
  description: string;
  mode: CaseMode;
  steps?: Step[];
  code?: string | null;
  tags: string[];
  status: CaseStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** NL-first 增量：只读派生；无 NL 的旧用例为 null/缺省 */
  nl?: NlSource | null;
  /** stepId → NL 行号（accept 写入） */
  stepOrigin?: StepOrigin | null;
}

/** 列表项：省略 steps/code，仅给 stepsCount（见 §2.3） */
export type CaseListItem = Omit<Case, 'steps' | 'code'> & { stepsCount: number };

/** 创建/更新用例的请求体（§2.4 / §2.6） */
export interface CaseInput {
  name: string;
  description?: string;
  mode?: CaseMode;
  steps?: Step[];
  code?: string | null;
  tags?: string[];
  status?: CaseStatus;
  /** POST /cases 可选 NL 初值；PATCH 不接受 */
  nl?: { text: string };
}

/** POST /cases/{id}/validate 响应（§2.8） */
export interface CaseValidateResult {
  ok: boolean;
  compiledSpecPath: string | null;
  stepsCount: number;
  rowsCount: number;
  warnings: { code: string; message: string; stepId?: string }[];
}

/** 数据集资源，见 §3.1 */
export type DatasetSource = 'manual' | 'json' | 'csv';

export interface Dataset {
  id: string;
  caseId: string;
  name: string;
  source: DatasetSource;
  columns: string[];
  rowsCount: number;
  enabledRowsCount: number;
  createdAt: string;
  updatedAt: string;
}

export type CellValue = string | number | boolean | null;

export interface DatasetRow {
  id: string;
  datasetId: string;
  rowIndex: number;
  data: Record<string, CellValue>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 行写入形态：PUT rows 全量替换（§3.2） */
export interface DatasetRowInput {
  data: Record<string, CellValue>;
  enabled?: boolean;
}

export interface DatasetCreateInput {
  name: string;
  source: DatasetSource;
  rows: DatasetRowInput[];
}

/** 套件资源，见 §4 */
export interface Suite {
  id: string;
  name: string;
  description: string;
  caseIds: string[];
  casesCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SuiteCreateInput {
  name: string;
  description?: string;
  caseIds: string[];
}

/** 运行选项，见 §5.3 / 附录 A.4 */
export type TraceMode = 'off' | 'retain-on-failure' | 'on';
export type ScreenshotMode = 'off' | 'only-on-failure' | 'on';
export type VideoMode = 'off' | 'retain-on-failure' | 'on';
export type BrowserName = 'chromium' | 'chrome' | 'msedge' | 'firefox' | 'webkit';

export interface RunOptions {
  retries: number;
  workers: number;
  timeoutMs: number;
  trace: TraceMode;
  screenshot: ScreenshotMode;
  video: VideoMode;
  headed: boolean;
  browser: BrowserName;
  failOnFlaky: boolean;
  /** NL stale 时是否允许继续运行（默认 false → 409 NL_STALE） */
  allowStaleNl?: boolean;
}

export interface RunStats {
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
  durationMs: number;
}

export interface EnvironmentFingerprint {
  node: string;
  playwright: string;
  browser: string;
  os: string;
  timezone: string;
}

export interface RunDiagnostics {
  playwrightCliPath: string;
  command: string[];
  specPath: string | null;
  reportPath: string | null;
  workspaceDir: string;
  warnings: string[];
}

/** 运行资源，见 §5.1 */
export interface Run {
  id: string;
  kind: 'case' | 'suite';
  caseId: string | null;
  suiteId: string | null;
  datasetId: string | null;
  options: RunOptions;
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
  environment: EnvironmentFingerprint;
  error: { code: string; message: string; detail?: unknown } | null;
  diagnostics: RunDiagnostics;
  idempotencyKey: string | null;
}

/** 逐项结果（含逐行），见 §5.2 */
export type ItemOutcomeValue = ItemOutcome;

export interface RunItemError {
  message: string;
  stack?: string;
  snippet?: string;
  location?: { file: string; line: number; column: number };
}

export interface RunItemStep {
  title: string;
  durationMs: number;
  error: string | null;
  steps?: unknown[];
}

export interface RunItemAttachment {
  name: string;
  contentType: string;
  artifactId: string | null;
}

export interface RunItemAttempt {
  attempt: number;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  durationMs: number;
  startTime: string;
  error: RunItemError | null;
  errorHash: string;
  steps: RunItemStep[];
  attachments: RunItemAttachment[];
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
  outcome: ItemOutcomeValue;
  durationMs: number;
  attempts: RunItemAttempt[];
}

/** 运行创建请求，见 §5.3 / 附录 A.4 */
export type RunTarget =
  | { kind: 'case'; caseId: string }
  | { kind: 'suite'; suiteId: string };

export interface RunCreateRequest {
  target: RunTarget;
  datasetId?: string;
  options?: Partial<RunOptions>;
  reason?: string;
}

/** 产物资源，见 §5.5 */
export type ArtifactKind =
  | 'trace'
  | 'screenshot'
  | 'video'
  | 'json-report'
  | 'stdout'
  | 'stderr'
  | 'spec'
  | 'snapshot'
  | 'console'
  | 'other';

export interface Artifact {
  id: string;
  runId: string;
  itemKey: string | null;
  kind: ArtifactKind;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  createdAt: string;
}

/** 回归基线，见 §6.1 */
export type BaselineScope = 'case' | 'suite';
export type BaselineCreator = 'user' | 'agent' | 'system';

export interface Baseline {
  id: string;
  scope: BaselineScope;
  scopeId: string;
  runId: string;
  name: string;
  note: string | null;
  isDefault: boolean;
  archivedAt: string | null;
  createdBy: BaselineCreator;
  createdAt: string;
}

export interface BaselineCreateInput {
  scope: BaselineScope;
  scopeId: string;
  runId: string;
  name: string;
  note?: string;
  createdBy?: BaselineCreator;
}

/** 回归对比，见 §6.2 */
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

/** 失败原因分类（PRD R3.5；胶水层规则推断，非官方结论） */
export const FAILURE_CATEGORIES = [
  'locator_not_found',
  'timeout',
  'assertion_mismatch',
  'navigation_error',
  'network_error',
  'data_error',
  'environment_error',
  'unknown',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export interface ComparisonAttribution {
  /** 回归变化型归因（new_failure / fixed / item_missing …），描述与基线相比发生了什么 */
  category: string;
  /** 失败原因分类；仅失败类变化有值，非失败变化为 null（后端合同 §6.2） */
  failureCategory?: FailureCategory | null;
  confidence: 'low' | 'medium' | 'high';
  evidence: string[];
}

export interface ComparisonItem {
  itemKey: string;
  rowIndex: number | null;
  change: ComparisonChange;
  baseOutcome: ItemOutcomeValue;
  targetOutcome: ItemOutcomeValue;
  errorChanged: boolean;
  baseErrorHash: string | null;
  targetErrorHash: string | null;
  durationDeltaMs: number | null;
  artifactDelta: { added: string[]; removed: string[] };
  attribution?: ComparisonAttribution | null;
}

export interface Comparison {
  id: string;
  baselineId: string;
  baselineRunId: string;
  runId: string;
  scope: BaselineScope;
  scopeId: string;
  summary: ComparisonSummary;
  createdAt: string;
}

/** GET /comparisons/{id} 的 data 形态，见 §6.2 */
export interface ComparisonDetail {
  comparison: Comparison;
  items: ComparisonItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Agent 脚手架，见 §13（三入口；deepseek 无官方 loop） */
export type AgentEntry = 'claude' | 'codex' | 'deepseek';
/** 旧 6 loop 类型仅保留给历史字段/旧端点，不再用于 UI 入口 */
export type AgentLoop = 'claude' | 'codex' | 'copilot' | 'opencode' | 'vscode' | 'vscode-legacy';

export const AGENT_ENTRIES = ['claude', 'codex', 'deepseek'] as const;

export interface HarnessSkillPath {
  scope: 'project' | 'user' | 'shared';
  path: string;
}

export interface AgentHarness {
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

export interface ScaffoldFile {
  path: string;
  sizeBytes: number;
  sha256: string;
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
  files: ScaffoldFile[];
  missing: string[];
  notes?: string;
  error: { code: string; message: string } | null;
  createdAt: string;
  finishedAt: string;
}

export interface ScaffoldCreateInput {
  entry: AgentEntry;
  prompts?: boolean;
  confirm: true;
}

/** GET /agents/loops（历史兼容端点；UI 不再使用，改读 /agents/harnesses） */
export interface AgentLoopInfo {
  entry?: AgentEntry;
  loop: AgentLoop | string | null;
  description: string;
}

export type AgentPromptKey = 'plan' | 'generate' | 'heal' | 'coverage';

export interface AgentPrompt {
  key: AgentPromptKey;
  title: string;
  body: string;
  source: 'official' | 'framework';
}

export interface WorkspaceEntry {
  path: string;
  sizeBytes: number;
  mtime: string;
}

/** MCP 会话，见 §8.1 */
export type McpSessionStatus = 'starting' | 'ready' | 'closing' | 'closed' | 'error';

export interface McpTool {
  name: string;
  description?: string;
}

export interface McpSession {
  id: string;
  status: McpSessionStatus;
  serverInfo: { name: string; version: string } | null;
  protocolVersion: string | null;
  caps: string[];
  tools: McpTool[];
  headless: boolean;
  isolated: boolean;
  workDir: string;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  error: { code: string; message: string } | null;
}

export interface McpSessionCreateInput {
  caps?: string[];
  headless?: boolean;
  browser?: string;
  isolated?: boolean;
}

export interface McpCallResult {
  content: unknown[];
  isError: boolean;
  durationMs: number;
}

/** CLI 命令目录，见 §9.1 */
export interface CliCommands {
  allow: string[];
  needsConfirm: string[];
  deny: string[];
}

export interface CliArtifactRef {
  kind: string;
  path: string;
}

export interface CliExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: unknown;
  parsed: unknown;
  durationMs: number;
  artifacts: CliArtifactRef[];
}

export interface CliExecInput {
  argv: string[];
  session?: string;
  workDir?: string;
  timeoutMs?: number;
  confirm?: boolean;
}
