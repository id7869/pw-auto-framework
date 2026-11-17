/**
 * 后端 HTTP 客户端（验收套件唯一入口）。
 *
 * 纪律：
 * - 只按 docs/api-contract.md 的端点与字段调用，不绕过 API 直接改数据库（反作弊条款 §4.3）；
 * - 每个请求都记录状态码/响应头/原始文本，便于证据落盘与失败定位。
 */

import { API_BASE } from './env.ts';
import type {
  Artifact,
  Baseline,
  Case,
  CaseStep,
  CliExecResult,
  Comparison,
  ComparisonDetail,
  ComparisonItem,
  Dataset,
  DatasetRow,
  McpSession,
  McpToolCallResult,
  MetaResponse,
  Page,
  Run,
  RunItem,
  Scaffold,
  Suite,
} from './types.ts';

export interface HttpResult<T = unknown> {
  status: number;
  headers: Headers;
  text: string;
  body: T;
  requestId: string | null;
}

export interface HttpOptions {
  body?: unknown;
  /** 直接发送的原始 body（用于非法 JSON / 超大请求体） */
  rawBody?: string;
  headers?: Record<string, string>;
  base?: string;
  /** 单请求超时（毫秒），默认 60s；运行相关的读请求可能较慢 */
  timeoutMs?: number;
  contentType?: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: { path: string; message: string }[];

  constructor(status: number, code: string, message: string, details?: { path: string; message: string }[]) {
    super(`${status} ${code}: ${message}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { __unparsed: text.slice(0, 500) };
  }
}

export async function http<T = unknown>(method: string, path: string, options: HttpOptions = {}): Promise<HttpResult<T>> {
  const base = options.base ?? API_BASE;
  const headers: Record<string, string> = { ...options.headers };
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    if (options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/json';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    if (options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/json';
  } else if (options.contentType !== null && options.contentType !== undefined) {
    headers['content-type'] = options.contentType;
  }

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: parseJson(text) as T,
    requestId: response.headers.get('x-request-id'),
  };
}

/** 解包 `{ data }` 信封；非 2xx 抛 ApiError（测试需要状态码时请直接用 http()） */
export function unwrap<T>(result: HttpResult, expectedStatus?: number): T {
  const statusOk = expectedStatus === undefined ? result.status >= 200 && result.status < 300 : result.status === expectedStatus;
  if (!statusOk) {
    const envelope = result.body as { error?: { code?: string; message?: string; details?: { path: string; message: string }[] } } | null;
    throw new ApiError(
      result.status,
      envelope?.error?.code ?? 'UNKNOWN',
      envelope?.error?.message ?? result.text.slice(0, 300),
      envelope?.error?.details,
    );
  }
  const envelope = result.body as { data?: T } | null;
  if (envelope === null || envelope.data === undefined) {
    throw new Error(`响应缺少 data 信封（status=${result.status}）：${result.text.slice(0, 300)}`);
  }
  return envelope.data;
}

export function errorCodeOf(result: HttpResult): string | null {
  const envelope = result.body as { error?: { code?: string } } | null;
  return envelope?.error?.code ?? null;
}

// ── 健康与元信息 ──────────────────────────────────────────────────────────

export async function getHealth(): Promise<HttpResult> {
  return http('GET', '/api/health');
}

export async function getMeta(): Promise<MetaResponse> {
  return unwrap<MetaResponse>(await http('GET', '/api/v1/meta'));
}

// ── 用例 / 数据集 / 套件 ───────────────────────────────────────────────────

export interface CreateCaseInput {
  name: string;
  description?: string;
  mode?: 'steps' | 'code';
  steps?: CaseStep[];
  code?: string | null;
  tags?: string[];
  /** NL-first 初值（只接受 text；status/lines/hash 由服务端派生） */
  nl?: { text: string };
}

export async function createCase(input: CreateCaseInput): Promise<Case> {
  return unwrap<Case>(await http('POST', '/api/v1/cases', { body: input }), 201);
}

export async function getCase(caseId: string): Promise<Case> {
  return unwrap<Case>(await http('GET', `/api/v1/cases/${encodeURIComponent(caseId)}`));
}

export async function patchCase(caseId: string, version: number | string, patch: Record<string, unknown>): Promise<Case> {
  return unwrap<Case>(
    await http('PATCH', `/api/v1/cases/${encodeURIComponent(caseId)}`, {
      body: patch,
      headers: { 'if-match': `"${String(version)}"` },
    }),
    200,
  );
}

export async function listCases(query: string = ''): Promise<Page<import('./types.ts').CaseListItem>> {
  return unwrap(await http('GET', `/api/v1/cases${query}`));
}

export async function validateCase(caseId: string, body: { datasetId?: string } = {}): Promise<HttpResult> {
  return http('POST', `/api/v1/cases/${encodeURIComponent(caseId)}/validate`, { body });
}

export async function createDataset(caseId: string, input: { name: string; source?: string; rows: { data: Record<string, unknown>; enabled?: boolean }[] }): Promise<Dataset> {
  return unwrap<Dataset>(await http('POST', `/api/v1/cases/${encodeURIComponent(caseId)}/datasets`, { body: input }), 201);
}

export async function listDatasetRows(datasetId: string): Promise<Page<DatasetRow>> {
  return unwrap(await http('GET', `/api/v1/datasets/${encodeURIComponent(datasetId)}/rows?limit=100`));
}

export async function createSuite(input: { name: string; description?: string; caseIds: string[] }): Promise<Suite> {
  return unwrap<Suite>(await http('POST', '/api/v1/suites', { body: input }), 201);
}

// ── 运行 ──────────────────────────────────────────────────────────────────

export interface RunOptionsInput {
  retries?: number;
  workers?: number;
  timeoutMs?: number;
  trace?: string;
  screenshot?: string;
  video?: string;
  headed?: boolean;
  browser?: string;
  failOnFlaky?: boolean;
  /** NL 门禁（§12.4）：stale 文本显式放行 */
  allowStaleNl?: boolean;
}

export interface CreateRunInput {
  target: { kind: 'case'; caseId: string } | { kind: 'suite'; suiteId: string };
  datasetId?: string;
  options?: RunOptionsInput;
  reason?: string;
}

export async function startRun(input: CreateRunInput, idempotencyKey?: string): Promise<HttpResult> {
  return http('POST', '/api/v1/runs', {
    body: input,
    ...(idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': idempotencyKey } }),
  });
}

export async function createRun(input: CreateRunInput, idempotencyKey?: string): Promise<Run> {
  return unwrap<Run>(await startRun(input, idempotencyKey), 202);
}

export async function getRun(runId: string): Promise<Run> {
  return unwrap<Run>(await http('GET', `/api/v1/runs/${encodeURIComponent(runId)}`));
}

export const TERMINAL_RUN_STATUSES: readonly string[] = ['passed', 'failed', 'cancelled', 'error'];

export function isTerminal(run: Run | undefined | null): boolean {
  return run !== undefined && run !== null && TERMINAL_RUN_STATUSES.includes(run.status);
}

export interface WaitRunOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** 轮询过程中每次取到的运行对象都会回调（用于观察状态迁移） */
  onPoll?: (run: Run, elapsedMs: number) => void;
}

/** 轮询到终态（api-contract §0.4：轮询为 MUST）；超时抛错并附最后一次快照。 */
export async function waitRun(runId: string, options: WaitRunOptions = {}): Promise<Run> {
  const timeoutMs = options.timeoutMs ?? 150_000;
  const intervalMs = options.intervalMs ?? 500;
  const startedAt = Date.now();
  let last: Run | null = null;
  const observed: string[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    last = await getRun(runId);
    if (observed[observed.length - 1] !== last.status) observed.push(last.status);
    options.onPoll?.(last, Date.now() - startedAt);
    if (isTerminal(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`运行 ${runId} 在 ${timeoutMs}ms 内未到终态；状态序列=${observed.join(' → ')}；最后快照=${JSON.stringify(last?.stats)}`);
}

/** 轮询直到 status 满足谓词（例如等到 running 再取消） */
export async function waitRunStatus(runId: string, predicate: (run: Run) => boolean, timeoutMs = 60_000): Promise<Run> {
  const startedAt = Date.now();
  let last = await getRun(runId);
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await getRun(runId);
  }
  throw new Error(`运行 ${runId} 未在 ${timeoutMs}ms 内进入期望状态（当前 ${last.status}）`);
}

export async function listRunItems(runId: string, query = '?limit=100'): Promise<Page<RunItem>> {
  return unwrap(await http('GET', `/api/v1/runs/${encodeURIComponent(runId)}/items${query}`));
}

export async function listRunArtifacts(runId: string, query = '?limit=100'): Promise<Page<Artifact>> {
  return unwrap(await http('GET', `/api/v1/runs/${encodeURIComponent(runId)}/artifacts${query}`));
}

export async function cancelRun(runId: string): Promise<HttpResult> {
  return http('POST', `/api/v1/runs/${encodeURIComponent(runId)}/cancel`);
}

export async function listRuns(query = '?limit=20'): Promise<Page<Run>> {
  return unwrap(await http('GET', `/api/v1/runs${query}`));
}

/** 产物内容（返回原始字节与响应头，用于内容/长度/类型断言） */
export async function fetchArtifactContent(runId: string, artifactId: string, extraQuery = '', headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; bytes: Buffer; text: string }> {
  const response = await fetch(
    `${API_BASE}/api/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/content${extraQuery}`,
    { headers },
  );
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes: buffer, text: buffer.toString('utf8') };
}

// ── 回归 ──────────────────────────────────────────────────────────────────

export async function createBaseline(input: { scope: 'case' | 'suite'; scopeId: string; runId: string; name: string; note?: string }): Promise<HttpResult> {
  return http('POST', '/api/v1/baselines', { body: input });
}

export async function listBaselines(query: string): Promise<Page<Baseline>> {
  return unwrap(await http('GET', `/api/v1/baselines${query}`));
}

export async function createComparison(input: { baselineId: string; runId: string }): Promise<HttpResult> {
  return http('POST', '/api/v1/comparisons', { body: input });
}

export async function getComparison(comparisonId: string): Promise<ComparisonDetail> {
  return unwrap<ComparisonDetail>(await http('GET', `/api/v1/comparisons/${encodeURIComponent(comparisonId)}`));
}

export async function listComparisons(query: string): Promise<Page<Comparison>> {
  return unwrap(await http('GET', `/api/v1/comparisons${query}`));
}

export type { Comparison, ComparisonItem };

// ── 官方能力交接 ──────────────────────────────────────────────────────────

export async function createMcpSession(input: Record<string, unknown>): Promise<HttpResult> {
  return http('POST', '/api/v1/mcp/sessions', { body: input });
}

export async function callMcpTool(sessionId: string, tool: string, args: Record<string, unknown> = {}, confirm?: boolean): Promise<HttpResult> {
  return http('POST', `/api/v1/mcp/sessions/${encodeURIComponent(sessionId)}/calls`, {
    body: { tool, arguments: args, ...(confirm === undefined ? {} : { confirm }) },
    timeoutMs: 90_000,
  });
}

export async function closeMcpSession(sessionId: string): Promise<HttpResult> {
  return http('DELETE', `/api/v1/mcp/sessions/${encodeURIComponent(sessionId)}`);
}

export async function getMcpSession(sessionId: string): Promise<HttpResult> {
  return http('GET', `/api/v1/mcp/sessions/${encodeURIComponent(sessionId)}`);
}

export type { McpSession, McpToolCallResult };

export async function cliExec(input: Record<string, unknown>): Promise<HttpResult> {
  return http('POST', '/api/v1/cli/exec', { body: input, timeoutMs: 120_000 });
}

export type { CliExecResult };

export async function createScaffold(input: Record<string, unknown>, idempotencyKey?: string): Promise<HttpResult> {
  return http('POST', '/api/v1/agents/scaffolds', {
    body: input,
    ...(idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': idempotencyKey } }),
    timeoutMs: 120_000,
  });
}

export type { Scaffold };

// ── NL-first（R6）─────────────────────────────────────────────────────────

export async function getNl(caseId: string): Promise<HttpResult> {
  return http('GET', `/api/v1/cases/${encodeURIComponent(caseId)}/nl`);
}

export async function putNl(caseId: string, text: string): Promise<HttpResult> {
  return http('PUT', `/api/v1/cases/${encodeURIComponent(caseId)}/nl`, { body: { text } });
}

export async function deleteNl(caseId: string): Promise<HttpResult> {
  return http('DELETE', `/api/v1/cases/${encodeURIComponent(caseId)}/nl`);
}

export async function createNlGeneration(
  caseId: string,
  body: { generator?: 'agent' | 'rule'; hints?: Record<string, string>; force?: boolean } = {},
): Promise<HttpResult> {
  return http('POST', `/api/v1/cases/${encodeURIComponent(caseId)}/nl/generations`, { body });
}

export async function listNlGenerationsForCase(caseId: string, query = '?limit=100'): Promise<HttpResult> {
  return http('GET', `/api/v1/cases/${encodeURIComponent(caseId)}/nl/generations${query}`);
}

export async function getNlGeneration(caseId: string, generationId: string): Promise<HttpResult> {
  return http(
    'GET',
    `/api/v1/cases/${encodeURIComponent(caseId)}/nl/generations/${encodeURIComponent(generationId)}`,
  );
}

export async function listNlQueue(query = ''): Promise<HttpResult> {
  return http('GET', `/api/v1/nl/generations${query}`);
}

export async function claimNlGeneration(generationId: string, body: { leaseSeconds?: number } = {}): Promise<HttpResult> {
  return http('POST', `/api/v1/nl/generations/${encodeURIComponent(generationId)}/claim`, { body });
}

export async function submitNlGeneration(
  generationId: string,
  body: {
    leaseId: string;
    steps?: CaseStep[];
    code?: string | null;
    warnings?: { code: string; line: number; message: string }[];
    generatorVersion: string;
    stepOrigin?: Record<string, { nlLine: number }>;
    datasetId?: string;
  },
): Promise<HttpResult> {
  return http('POST', `/api/v1/nl/generations/${encodeURIComponent(generationId)}/submit`, { body });
}

export async function acceptNlGeneration(
  caseId: string,
  generationId: string,
  body: { force?: boolean; code?: boolean } = {},
): Promise<HttpResult> {
  return http(
    'POST',
    `/api/v1/cases/${encodeURIComponent(caseId)}/nl/generations/${encodeURIComponent(generationId)}/accept`,
    { body },
  );
}

export async function rejectNlGeneration(caseId: string, generationId: string, reason: string): Promise<HttpResult> {
  return http(
    'POST',
    `/api/v1/cases/${encodeURIComponent(caseId)}/nl/generations/${encodeURIComponent(generationId)}/reject`,
    { body: { reason } },
  );
}

export async function cancelNlGeneration(caseId: string, generationId: string): Promise<HttpResult> {
  return http(
    'POST',
    `/api/v1/cases/${encodeURIComponent(caseId)}/nl/generations/${encodeURIComponent(generationId)}/cancel`,
    { body: {} },
  );
}

export async function getSpecPreview(caseId: string): Promise<HttpResult> {
  return http('GET', `/api/v1/cases/${encodeURIComponent(caseId)}/spec?preview=1`, { timeoutMs: 120_000 });
}

// ── 三 harness 入口（R7）──────────────────────────────────────────────────

export async function getHarnesses(): Promise<HttpResult> {
  return http('GET', '/api/v1/agents/harnesses');
}

export async function getAgentLoops(): Promise<HttpResult> {
  return http('GET', '/api/v1/agents/loops');
}

export async function getAgentPrompts(entry?: string): Promise<HttpResult> {
  const suffix = entry === undefined ? '' : `?entry=${encodeURIComponent(entry)}`;
  return http('GET', `/api/v1/agents/prompts${suffix}`);
}

export async function getAgentWorkspace(query: string): Promise<HttpResult> {
  return http('GET', `/api/v1/agents/workspace${query}`);
}

// ── JSON 工具 ─────────────────────────────────────────────────────────────

/** 递归收集 JSON 中所有对象的键名（用于「密钥字段不得出现」检查） */
export function collectKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
    return acc;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      acc.push(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

/** 递归深度限制的字符串化（用于体积较大的运行对象证据） */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}