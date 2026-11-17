/**
 * packages/automation 的公共类型契约。
 *
 * 来源：
 * - docs/architecture.md §3.2（ExecutionEngine 接口、EngineRunRequest/Result/Item/Artifact、EnvironmentFingerprint）
 * - docs/api-contract.md §5.1/§5.2/§5.5（Run/RunItem/Artifact 字段口径）
 * - docs/api-contract.md §2.2（Step/Target 模型）
 *
 * 本文件不定义 HTTP 层字段（id/runId 由 apps/api 生成），只描述执行引擎的输入/输出与统计口径。
 */

// ---------------------------------------------------------------------------
// 运行状态 / 选项
// ---------------------------------------------------------------------------

/** 引擎返回的终态（RunStatus 去掉 queued/running）；failed 与 error 的区分见 runner 注释。 */
export const ENGINE_RUN_STATUSES = ['passed', 'failed', 'cancelled', 'error'] as const;
export type EngineRunStatus = (typeof ENGINE_RUN_STATUSES)[number];

export const TRACE_MODES = ['off', 'retain-on-failure', 'on'] as const;
export type TraceMode = (typeof TRACE_MODES)[number];

export const SCREENSHOT_MODES = ['off', 'only-on-failure', 'on'] as const;
export type ScreenshotMode = (typeof SCREENSHOT_MODES)[number];

export const VIDEO_MODES = ['off', 'retain-on-failure', 'on'] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];

export const BROWSER_NAMES = ['chromium', 'chrome', 'msedge', 'firefox', 'webkit'] as const;
export type BrowserName = (typeof BROWSER_NAMES)[number];

export interface EngineProxyOption {
  /** 官方 use.proxy.server 原样值（如 http://127.0.0.1:8080）。 */
  server: string;
  /** 官方 use.proxy.bypass，逗号分隔域列表。 */
  bypass?: string;
}

/** 调用方可选字段：缺省值由 resolveEngineRunOptions 统一补齐。 */
export interface EngineRunOptions {
  /** 运行级超时（整次 run，含编译与执行），默认 600000ms。 */
  timeoutMs?: number;
  /** 用例级超时（官方 config.timeout），默认 60000ms。 */
  caseTimeoutMs?: number;
  /** 官方 config.retries，默认 0。 */
  retries?: number;
  /** 官方 config.workers，默认 1。 */
  workers?: number;
  /** 官方 use.trace，默认 retain-on-failure。 */
  trace?: TraceMode;
  /** 官方 use.screenshot，默认 only-on-failure。 */
  screenshot?: ScreenshotMode;
  /** 官方 use.video，默认 off。 */
  video?: VideoMode;
  /** 官方 use.headless 的反面，默认 false（headless）。 */
  headed?: boolean;
  /** 浏览器/channel，默认 chromium。 */
  browser?: BrowserName;
  /** 官方 failOnFlakyTests（v1.52+），默认 false。 */
  failOnFlaky?: boolean;
  /** 官方 use.proxy 形态。 */
  proxy?: EngineProxyOption;
}

/** 内部使用的已补齐选项。 */
export interface ResolvedEngineRunOptions {
  timeoutMs: number;
  caseTimeoutMs: number;
  retries: number;
  workers: number;
  trace: TraceMode;
  screenshot: ScreenshotMode;
  video: VideoMode;
  headed: boolean;
  browser: BrowserName;
  failOnFlaky: boolean;
  proxy?: EngineProxyOption;
}

export const DEFAULT_ENGINE_RUN_OPTIONS: ResolvedEngineRunOptions = {
  timeoutMs: 600_000,
  caseTimeoutMs: 60_000,
  retries: 0,
  workers: 1,
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',
  video: 'off',
  headed: false,
  browser: 'chromium',
  failOnFlaky: false,
};

// ---------------------------------------------------------------------------
// 用例快照 / 步骤模型
// ---------------------------------------------------------------------------

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

export const TARGET_TYPES = ['role', 'testId', 'label', 'placeholder', 'text', 'alt', 'title', 'css'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export const WAIT_STATES = ['visible', 'hidden', 'attached', 'detached'] as const;
export type WaitState = (typeof WAIT_STATES)[number];

/** 官方 locator 的声明式目标（docs/api-contract.md §2.2）。 */
export interface StepTarget {
  by: TargetType;
  /** by=role */
  role?: string;
  /** by=role 的可访问名称 */
  name?: string;
  /** by=testId */
  testId?: string;
  /** label/placeholder/text/alt/title */
  text?: string;
  /** by=css（兜底，编译期产生 CSS_SELECTOR 警告） */
  selector?: string;
  exact?: boolean;
  /** by=role 的 heading level（1..6） */
  level?: number;
}

export interface CaseStep {
  id: string;
  action: StepAction;
  label?: string;
  target?: StepTarget;
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

export type DataCell = string | number | boolean | null;

/** 数据集行（已按 enabled 过滤，rowIndex 为原始稳定行号）。 */
export interface CaseDataRow {
  rowIndex: number;
  data: Record<string, DataCell>;
}

/**
 * 用例快照：由 apps/api 在创建 run 时固化后传入。
 *
 * steps 使用 unknown[] 是为了让 apps/api 直接传其持久化 JSON（不强迫跨包共享类型）；
 * 引擎在编译前做完整运行时校验（INVALID_STEP / UNKNOWN_COLUMN）。
 */
export interface CaseSnapshot {
  caseId: string;
  name: string;
  description?: string;
  mode: 'steps' | 'code';
  steps: unknown[];
  code: string | null;
  tags?: string[];
  /** 已过滤 enabled 的数据行；为空/缺省表示不使用数据集（单 test，itemKey=caseId）。 */
  rows?: CaseDataRow[];
  /** 数据集列（可缺省，缺省时由 rows 并集推导）。 */
  columns?: string[];
  datasetId?: string | null;
}

// ---------------------------------------------------------------------------
// 运行结果
// ---------------------------------------------------------------------------

export interface EngineRunStats {
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
  durationMs: number;
}

export const ENGINE_ARTIFACT_KINDS = [
  'trace',
  'screenshot',
  'video',
  'json-report',
  'stdout',
  'stderr',
  'spec',
  'snapshot',
  'console',
  'other',
] as const;
export type EngineArtifactKind = (typeof ENGINE_ARTIFACT_KINDS)[number];

/** 与 api-contract §5.5 Artifact 对齐；relPath 相对于 workspaceDir（POSIX 分隔符）。 */
export interface EngineRunArtifact {
  itemKey: string | null;
  kind: EngineArtifactKind;
  relPath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  /** 文件 mtime（ISO-8601 毫秒）。 */
  createdAt: string;
}

export interface EngineErrorLocation {
  file: string;
  line: number;
  column: number;
}

export interface EngineStepError {
  message: string;
  stack?: string;
  snippet?: string;
  location?: EngineErrorLocation;
}

export interface EngineRunStep {
  title: string;
  durationMs: number;
  error: string | null;
  steps?: EngineRunStep[];
}

export interface EngineRunAttachment {
  name: string;
  contentType: string;
  /** 由 apps/api 回填的产物 id；引擎内恒为 null。 */
  artifactId: string | null;
  /** 产物相对 workspaceDir 的路径（便于 apps/api 关联 artifacts 表）。 */
  relPath?: string;
}

export const ATTEMPT_STATUSES = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'] as const;
export type EngineAttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export interface EngineRunItemAttempt {
  /** 0 基；官方 JSONReport.results[].retry。 */
  attempt: number;
  status: EngineAttemptStatus;
  durationMs: number;
  startTime: string;
  error: EngineStepError | null;
  /** 官方 results[].errors[] 全量（首个同时放入 error，便于归因）。 */
  errors?: EngineStepError[];
  /** sha256(规范化 error.message)，无错误为 ''。 */
  errorHash: string;
  steps: EngineRunStep[];
  attachments: EngineRunAttachment[];
  /** ≤ 8 KiB（UTF-8 字节），超出截断。 */
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export const ITEM_OUTCOMES = ['expected', 'unexpected', 'flaky', 'skipped', 'missing', 'unknown'] as const;
export type EngineItemOutcome = (typeof ITEM_OUTCOMES)[number];

export interface EngineRunItem {
  /** 稳定业务键：`${caseId}#row:${rowIndex}` 或 `${caseId}`（api-contract §5.2）。 */
  itemKey: string;
  caseId: string;
  rowIndex: number | null;
  /** 官方 test 标题（含 `[row:N]` 标记）。 */
  title: string;
  projectName: string | null;
  outcome: EngineItemOutcome;
  durationMs: number;
  attempts: EngineRunItemAttempt[];
}

export interface EnvironmentFingerprint {
  node: string;
  playwright: string;
  browser: string;
  os: string;
  timezone: string;
}

export interface EngineRunDiagnostics {
  playwrightCliPath: string;
  /** 官方命令回显（argv 全量，不含密钥）。 */
  command: string[];
  specPath: string | null;
  reportPath: string | null;
  workspaceDir: string;
  warnings: string[];
  playwrightVersion: string;
  browser: string;
  nodeVersion: string;
  durationMs: number;
}

export interface EngineRunError {
  code: string;
  message: string;
  detail?: unknown;
}

export interface EngineRunResult {
  runId: string;
  status: EngineRunStatus;
  exitCode: number | null;
  stats: EngineRunStats;
  items: EngineRunItem[];
  artifacts: EngineRunArtifact[];
  environment: EnvironmentFingerprint;
  /** 官方 JSON 报告绝对路径；未产出时为 ''。 */
  reportPath: string;
  error?: EngineRunError;
  diagnostics: EngineRunDiagnostics;
}

export interface EngineRunRequest {
  /** 后端生成，用于工作区命名与结果关联。 */
  runId: string;
  /** 绝对路径，已由后端创建（引擎会确保子目录存在）。 */
  workspaceDir: string;
  /** 产物根（默认 <repo>/.data）；引擎只读用，不写库。 */
  dataRoot: string;
  caseSnapshot: CaseSnapshot;
  options: EngineRunOptions;
}

export const ENGINE_PHASES = ['validate', 'compile', 'prepare', 'execute', 'parse', 'artifacts', 'done'] as const;
export type EnginePhase = (typeof ENGINE_PHASES)[number];

export interface EngineRunContext {
  onPhase: (phase: EnginePhase) => void;
  signal: AbortSignal;
  logger: (message: string) => void;
}

export interface ExecutionEngine {
  run(req: EngineRunRequest, ctx: EngineRunContext): Promise<EngineRunResult>;
  cancel(runId: string): Promise<void>;
  /** 编译校验（不执行、不落盘）。 */
  compile(input: { caseSnapshot: CaseSnapshot }): Promise<CompileResult>;
  /** 进程清理（可选；apps/api 退出时调用）。 */
  shutdown?(): Promise<void>;
  /** 官方入口探测（可选；GET /api/v1/meta 使用）。 */
  getPlaywrightInfo?(): Promise<PlaywrightInfo>;
}

export interface PlaywrightInfo {
  available: boolean;
  cliPath: string | null;
  version: string | null;
  expectedVersion: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// 编译结果
// ---------------------------------------------------------------------------

export interface CompileWarning {
  code: string;
  message: string;
  stepId?: string;
}

export interface CompileIssue {
  code: string;
  message: string;
  path?: string;
  stepId?: string;
  detail?: unknown;
}

export interface CompileResult {
  ok: boolean;
  stepsCount: number;
  rowsCount: number;
  warnings: CompileWarning[];
  /** 校验失败明细（ok=false 时非空）；apps/api 映射 422。 */
  errors: CompileIssue[];
  /** 仅内存中的规格文本（compile 不落盘）；code 模式为完整文件内容。 */
  specSource: string | null;
  specFileName: string | null;
  itemKeys: string[];
}

// ---------------------------------------------------------------------------
// 选项规范化
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickNumber(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${field} 必须是数字`);
  }
  if (value < min || value > max) throw new RangeError(`${field} 必须在 ${min}..${max} 之间`);
  return Math.floor(value);
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T, field: string): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new RangeError(`${field} 必须是 ${allowed.join('|')} 之一`);
  }
  return value as T;
}

/** 补齐并校验 EngineRunOptions；非法值抛 RangeError（由调用方映射 VALIDATION_FAILED）。 */
export function resolveEngineRunOptions(options?: EngineRunOptions): ResolvedEngineRunOptions {
  const input: Record<string, unknown> = isRecord(options) ? options : {};
  const resolved: ResolvedEngineRunOptions = {
    timeoutMs: pickNumber(input['timeoutMs'], DEFAULT_ENGINE_RUN_OPTIONS.timeoutMs, 1_000, 3_600_000, 'options.timeoutMs'),
    caseTimeoutMs: pickNumber(input['caseTimeoutMs'], DEFAULT_ENGINE_RUN_OPTIONS.caseTimeoutMs, 1_000, 3_600_000, 'options.caseTimeoutMs'),
    retries: pickNumber(input['retries'], DEFAULT_ENGINE_RUN_OPTIONS.retries, 0, 5, 'options.retries'),
    workers: pickNumber(input['workers'], DEFAULT_ENGINE_RUN_OPTIONS.workers, 1, 4, 'options.workers'),
    trace: pickEnum(input['trace'], TRACE_MODES, DEFAULT_ENGINE_RUN_OPTIONS.trace, 'options.trace'),
    screenshot: pickEnum(input['screenshot'], SCREENSHOT_MODES, DEFAULT_ENGINE_RUN_OPTIONS.screenshot, 'options.screenshot'),
    video: pickEnum(input['video'], VIDEO_MODES, DEFAULT_ENGINE_RUN_OPTIONS.video, 'options.video'),
    headed: input['headed'] === true,
    browser: pickEnum(input['browser'], BROWSER_NAMES, DEFAULT_ENGINE_RUN_OPTIONS.browser, 'options.browser'),
    failOnFlaky: input['failOnFlaky'] === true,
  };
  const proxy = input['proxy'];
  if (proxy !== undefined && proxy !== null) {
    if (!isRecord(proxy) || typeof proxy['server'] !== 'string' || proxy['server'].trim() === '') {
      throw new RangeError('options.proxy.server 必须是非空字符串');
    }
    if (proxy['bypass'] !== undefined && proxy['bypass'] !== null && typeof proxy['bypass'] !== 'string') {
      throw new RangeError('options.proxy.bypass 必须是字符串');
    }
    resolved.proxy = {
      server: proxy['server'],
      ...(typeof proxy['bypass'] === 'string' ? { bypass: proxy['bypass'] } : {}),
    };
  }
  return resolved;
}