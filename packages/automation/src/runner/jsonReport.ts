/**
 * 官方 JSON 报告解析（唯一入库契约）。
 *
 * 官方结构（@playwright/test@1.65.0 types/testReporter.d.ts）：
 * JSONReport { config, suites: JSONReportSuite[], errors: TestError[],
 *              stats: { startTime, duration, expected, unexpected, flaky, skipped } }
 * JSONReportSuite { title, file, line, column, specs[], suites[]? }
 * JSONReportSpec  { tags[], title, ok, tests[], id, file, line, column }
 * JSONReportTest  { timeout, annotations[], expectedStatus, projectName, projectId, results[],
 *                   status: skipped|expected|unexpected|flaky }
 * JSONReportTestResult { workerIndex, parallelIndex, status, duration, error?, errors[],
 *                        stdout[], stderr[], retry, steps[]?, startTime, attachments[],
 *                        annotations[], errorLocation? }
 *
 * 本文件只做“官方字段 → 引擎字段”的归一化，不解析 stdout 冒充结果，不重算通过率。
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import type {
  EngineAttemptStatus,
  EngineItemOutcome,
  EngineRunAttachment,
  EngineRunItem,
  EngineRunItemAttempt,
  EngineRunStats,
  EngineRunStep,
  EngineStepError,
} from '../types.ts';
import { ATTEMPT_STATUSES, ITEM_OUTCOMES } from '../types.ts';

const MAX_LOG_BYTES = 8192;

export interface JsonReportError {
  message?: string;
  stack?: string;
  snippet?: string;
  location?: { file?: string; line?: number; column?: number };
}

export interface JsonReportAttachment {
  name?: string;
  contentType?: string;
  path?: string;
  body?: string;
}

export interface JsonReportStep {
  title?: string;
  subtitle?: string;
  duration?: number;
  error?: JsonReportError;
  steps?: JsonReportStep[];
}

export interface JsonReportTestResult {
  workerIndex?: number;
  parallelIndex?: number;
  status?: string;
  duration?: number;
  error?: JsonReportError;
  errors?: JsonReportError[];
  stdout?: string[];
  stderr?: string[];
  retry?: number;
  steps?: JsonReportStep[];
  startTime?: string;
  attachments?: JsonReportAttachment[];
  errorLocation?: { file?: string; line?: number; column?: number };
}

export interface JsonReportTest {
  timeout?: number;
  annotations?: unknown[];
  expectedStatus?: string;
  projectName?: string;
  projectId?: string;
  results?: JsonReportTestResult[];
  status?: string;
}

export interface JsonReportSpec {
  tags?: string[];
  title?: string;
  ok?: boolean;
  tests?: JsonReportTest[];
  id?: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface JsonReportSuite {
  title?: string;
  file?: string;
  line?: number;
  column?: number;
  specs?: JsonReportSpec[];
  suites?: JsonReportSuite[];
}

export interface JsonReportStats {
  startTime?: string;
  duration?: number;
  expected?: number;
  unexpected?: number;
  flaky?: number;
  skipped?: number;
}

export interface JsonReport {
  config?: Record<string, unknown>;
  suites?: JsonReportSuite[];
  errors?: JsonReportError[];
  stats?: JsonReportStats;
}

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;

/** 规范化错误信息（仅用于 hash/比较）：去 ANSI、统一换行、去行尾空白。 */
export function normalizeErrorMessage(message: string | null | undefined): string {
  if (typeof message !== 'string') return '';
  return message
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** sha256(规范化 error.message)；无错误返回 ''。 */
export function hashErrorMessage(message: string | null | undefined): string {
  const normalized = normalizeErrorMessage(message);
  if (normalized === '') return '';
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** 按 UTF-8 字节截断（不破坏多字节字符边界；极端情况下替换为 U+FFFD）。 */
export function truncateUtf8(text: string, maxBytes = MAX_LOG_BYTES): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  const slice = buffer.subarray(0, maxBytes);
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(slice), truncated: true };
}

/**
 * 从任意标题中“宽松”提取 `[row:N]`（取最后一个标记）。
 *
 * 仅作为独立工具保留，**不参与** JSON 报告解析：runner 必须使用 parseGeneratedRowTag
 * （带编译期行号上下文），否则 case 名/code 模式标题里出现的 `[row:N]` 会被误判为数据行。
 */
export function parseRowIndexFromTitle(title: string): number | null {
  let result: number | null = null;
  const pattern = /\[row:(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(title)) !== null) {
    const parsed = Number.parseInt(match[1] ?? '', 10);
    if (Number.isInteger(parsed) && parsed >= 0) result = parsed;
  }
  return result;
}

const TRAILING_ROW_TAG = /\s\[row:(\d+)\]\s*$/;

export interface RowTagContext {
  /** 编译期确实生成的数据行号集合；缺省/null/空数组表示无数据集，忽略标题中的 row 标记。 */
  expectedRowIndexes?: readonly number[] | null;
  /** 编译期 itemKeys（可选交叉校验）。 */
  expectedItemKeys?: readonly string[];
}

/**
 * 只接受“编译器确实生成的数据行”的末尾 `[row:N]` 标记：
 * - 必须位于标题末尾（生成形式为 `<caseName> [row:N]`）；
 * - N 必须属于编译期生成的行号集合（若提供 itemKeys，还必须命中 `caseId#row:N`）。
 * 因此 case 名或 code 模式标题中自带的 `[row:9]` 不会被当作数据行。
 */
export function parseGeneratedRowTag(title: string, caseId: string, context: RowTagContext): number | null {
  const expectedRows = context.expectedRowIndexes;
  if (expectedRows === undefined || expectedRows === null || expectedRows.length === 0) return null;
  const match = TRAILING_ROW_TAG.exec(title.trimEnd());
  if (match === null) return null;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  if (!expectedRows.includes(parsed)) return null;
  if (
    context.expectedItemKeys !== undefined &&
    !context.expectedItemKeys.includes(`${caseId}#row:${parsed}`)
  ) {
    return null;
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function mapLocation(
  location: { file?: unknown; line?: unknown; column?: unknown } | undefined,
): { file: string; line: number; column: number } | undefined {
  if (location === undefined || typeof location.file !== 'string') return undefined;
  return {
    file: location.file,
    line: typeof location.line === 'number' ? location.line : 0,
    column: typeof location.column === 'number' ? location.column : 0,
  };
}

function mapError(error: JsonReportError | undefined): EngineStepError | null {
  if (error === undefined || typeof error.message !== 'string') return null;
  const mapped: EngineStepError = { message: error.message };
  if (typeof error.stack === 'string') mapped.stack = error.stack;
  if (typeof error.snippet === 'string') mapped.snippet = error.snippet;
  const location = mapLocation(error.location);
  if (location !== undefined) mapped.location = location;
  return mapped;
}

function mapSteps(steps: JsonReportStep[] | undefined): EngineRunStep[] {
  return asArray<JsonReportStep>(steps).map((step) => {
    const mapped: EngineRunStep = {
      title: typeof step.title === 'string' ? step.title : '',
      durationMs: typeof step.duration === 'number' ? Math.round(step.duration) : 0,
      error: typeof step.error?.message === 'string' ? step.error.message : null,
    };
    const nested = mapSteps(step.steps);
    if (nested.length > 0) mapped.steps = nested;
    return mapped;
  });
}

function mapAttemptStatus(status: unknown): EngineAttemptStatus {
  if (typeof status === 'string' && (ATTEMPT_STATUSES as readonly string[]).includes(status)) {
    return status as EngineAttemptStatus;
  }
  return 'failed';
}

function mapOutcome(status: unknown): EngineItemOutcome {
  if (typeof status === 'string' && (ITEM_OUTCOMES as readonly string[]).includes(status)) {
    return status as EngineItemOutcome;
  }
  return 'unknown';
}

export interface ParseJsonReportOptions {
  caseId: string;
  workspaceDir: string;
  /** 官方附件绝对路径 → 相对 workspaceDir 的 POSIX 路径。 */
  resolveAttachmentRelPath: (absolutePath: string) => string | undefined;
  /** 编译期生成的行号集合；缺省/空数组表示无数据集（标题里的 [row:N] 不解析为 row）。 */
  expectedRowIndexes?: readonly number[] | null;
  /** 编译期 itemKeys（提供时用于交叉校验 row 标记）。 */
  expectedItemKeys?: readonly string[];
}

export interface ParsedJsonReport {
  stats: EngineRunStats;
  items: EngineRunItem[];
  /** 已索引到 run 产物的附件占位（relPath 非空），供 artifacts 关联 itemKey。 */
  attachmentItemKeys: Map<string, string>;
  warnings: string[];
}

function parseStats(report: JsonReport): EngineRunStats {
  const stats = isRecord(report.stats) ? report.stats : {};
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    expected: num(stats.expected),
    unexpected: num(stats.unexpected),
    flaky: num(stats.flaky),
    skipped: num(stats.skipped),
    durationMs: Math.round(num(stats.duration)),
  };
}

function collectTopLevelErrors(report: JsonReport): string[] {
  const messages: string[] = [];
  for (const error of asArray<JsonReportError>(report.errors)) {
    if (typeof error.message === 'string' && error.message.trim() !== '') messages.push(error.message);
  }
  return messages;
}

/**
 * 解析官方 JSON 报告为逐项结果。
 * @throws Error 当报告结构不是对象或缺少 suites/stats（由 runner 映射 ENGINE_ERROR）。
 */
export function parseJsonReport(reportInput: unknown, options: ParseJsonReportOptions): ParsedJsonReport {
  if (!isRecord(reportInput)) throw new Error('JSON 报告不是对象');
  const report = reportInput as JsonReport;
  if (!Array.isArray(report.suites)) throw new Error('JSON 报告缺少 suites 数组');
  if (!isRecord(report.stats)) throw new Error('JSON 报告缺少 stats 对象');

  const warnings = collectTopLevelErrors(report);
  const items: EngineRunItem[] = [];
  const attachmentItemKeys = new Map<string, string>();
  const usedKeys = new Map<string, number>();
  const expectedRowIndexes = options.expectedRowIndexes ?? null;
  const datasetExpected = expectedRowIndexes !== null && expectedRowIndexes.length > 0;
  let rowTagMatched = false;

  const mapResult = (result: JsonReportTestResult, index: number, itemKey: string): EngineRunItemAttempt => {
    const errors = asArray<JsonReportError>(result.errors);
    const primary = errors.length > 0 ? errors[0] : result.error;
    const error = mapError(primary);
    const stdout = truncateUtf8(asArray<string>(result.stdout).join('\n'));
    const stderr = truncateUtf8(asArray<string>(result.stderr).join('\n'));
    const attachments: EngineRunAttachment[] = [];
    for (const attachment of asArray<JsonReportAttachment>(result.attachments)) {
      const contentType = typeof attachment.contentType === 'string' ? attachment.contentType : 'application/octet-stream';
      const entry: EngineRunAttachment = {
        name: typeof attachment.name === 'string' ? attachment.name : 'attachment',
        contentType,
        artifactId: null,
      };
      if (typeof attachment.path === 'string' && attachment.path !== '') {
        const absPath = path.isAbsolute(attachment.path) ? attachment.path : path.resolve(options.workspaceDir, attachment.path);
        const relPath = options.resolveAttachmentRelPath(absPath);
        if (relPath !== undefined) {
          entry.relPath = relPath;
          attachmentItemKeys.set(absPath, itemKey);
        } else {
          warnings.push(`附件路径越出工作区，未索引：${attachment.path}`);
        }
      }
      attachments.push(entry);
    }
    const attempt: EngineRunItemAttempt = {
      attempt: typeof result.retry === 'number' && Number.isInteger(result.retry) ? result.retry : index,
      status: mapAttemptStatus(result.status),
      durationMs: typeof result.duration === 'number' ? Math.round(result.duration) : 0,
      startTime: typeof result.startTime === 'string' ? result.startTime : new Date().toISOString(),
      error,
      errorHash: hashErrorMessage(error?.message),
      steps: mapSteps(result.steps),
      attachments,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
    };
    const allErrors = errors.map((entry) => mapError(entry)).filter((entry): entry is EngineStepError => entry !== null);
    if (allErrors.length > 1) attempt.errors = allErrors;
    return attempt;
  };

  const visitSuite = (suite: JsonReportSuite): void => {
    for (const spec of asArray<JsonReportSpec>(suite.specs)) {
      const title = typeof spec.title === 'string' ? spec.title : '';
      const tests = asArray<JsonReportTest>(spec.tests);
      for (const test of tests) {
        // 只解析编译器确实生成的数据行标记（末尾 [row:N] 且属于编译期行号集合）。
        const rowIndex = parseGeneratedRowTag(title, options.caseId, {
          expectedRowIndexes,
          ...(options.expectedItemKeys === undefined ? {} : { expectedItemKeys: options.expectedItemKeys }),
        });
        if (rowIndex !== null) rowTagMatched = true;
        const baseKey = rowIndex === null ? options.caseId : `${options.caseId}#row:${rowIndex}`;
        const previous = usedKeys.get(baseKey) ?? 0;
        usedKeys.set(baseKey, previous + 1);
        const itemKey = previous === 0 ? baseKey : `${baseKey}#idx:${previous}`;
        const attempts = asArray<JsonReportTestResult>(test.results).map((result, index) =>
          mapResult(result, index, itemKey),
        );
        const outcome = mapOutcome(test.status);
        const durationMs = attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0);
        const projectName =
          typeof test.projectName === 'string' && test.projectName !== '' ? test.projectName : null;
        items.push({
          itemKey,
          caseId: options.caseId,
          rowIndex,
          title,
          projectName,
          outcome,
          durationMs,
          attempts,
        });
      }
    }
    for (const child of asArray<JsonReportSuite>(suite.suites)) visitSuite(child);
  };

  for (const suite of asArray<JsonReportSuite>(report.suites)) visitSuite(suite);

  if (datasetExpected && !rowTagMatched && items.length > 0) {
    warnings.push(
      '数据驱动运行但 JSON 报告标题未匹配编译期 [row:N] 标记，itemKey 已退化为 caseId；请核对官方报告标题是否被改写',
    );
  }

  // 报告里没有任何 spec 时，runner 需要据此判断“用例未被收集”，避免伪造通过。
  return { stats: parseStats(report), items, attachmentItemKeys, warnings };
}