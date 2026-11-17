/**
 * 运行（Run）与逐项结果（RunItem）合同。
 * 权威来源：docs/api-contract.md §5、附录 A.4/A.5。
 *
 * 关键口径（不得改动）：
 * - 6 态状态机（run-status.ts）；
 * - `passed ⇔ stats.unexpected === 0 && (failOnFlaky ? stats.flaky === 0 : true) && exitCode === 0`；
 * - `itemKey` 跨运行稳定：`{caseId}` 或 `{caseId}#row:{rowIndex}`（套件内重复追加 `#idx:{n}`）；
 * - 逐项结果只搬运官方 JSON 报告字段，不加工结论。
 */

import { z } from 'zod';
import { isoDateTimeSchema, looseDateTimeSchema, resourceIdSchema } from './common.ts';
import { itemOutcomeSchema, runStatusSchema } from './run-status.ts';

export const RUN_KINDS = ['case', 'suite'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const runKindSchema = z.enum(RUN_KINDS);

export const TRACE_MODES = ['off', 'retain-on-failure', 'on'] as const;
export type TraceMode = (typeof TRACE_MODES)[number];

export const SCREENSHOT_MODES = ['off', 'only-on-failure', 'on'] as const;
export type ScreenshotMode = (typeof SCREENSHOT_MODES)[number];

export const VIDEO_MODES = ['off', 'retain-on-failure', 'on'] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];

export const BROWSERS = ['chromium', 'chrome', 'msedge', 'firefox', 'webkit'] as const;
export type BrowserName = (typeof BROWSERS)[number];
export const browserSchema = z.enum(BROWSERS);

/** 运行选项（api-contract 附录 A.4；默认值即契约默认值） */
export const runOptionsSchema = z
  .object({
    retries: z.number().int().min(0).max(5).default(0),
    workers: z.number().int().min(1).max(4).default(1),
    timeoutMs: z.number().int().min(1000).max(3600000).default(60000),
    trace: z.enum(TRACE_MODES).default('retain-on-failure'),
    screenshot: z.enum(SCREENSHOT_MODES).default('only-on-failure'),
    video: z.enum(VIDEO_MODES).default('off'),
    headed: z.boolean().default(false),
    browser: browserSchema.default('chromium'),
    failOnFlaky: z.boolean().default(false),
    /** R6 增量：NL 已改但未重新生成时，是否允许继续运行（默认 false → 409 NL_STALE） */
    allowStaleNl: z.boolean().default(false),
  })
  .strict();

export type RunOptions = z.infer<typeof runOptionsSchema>;

export const runStatsSchema = z
  .object({
    expected: z.number().int().nonnegative(),
    unexpected: z.number().int().nonnegative(),
    flaky: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
  })
  .strict();

export type RunStats = z.infer<typeof runStatsSchema>;

export const environmentFingerprintSchema = z
  .object({
    node: z.string().min(1),
    playwright: z.string().min(1),
    browser: z.string().min(1),
    os: z.string().min(1),
    timezone: z.string().min(1),
  })
  .strict();

export type EnvironmentFingerprint = z.infer<typeof environmentFingerprintSchema>;

export const runDiagnosticsSchema = z
  .object({
    playwrightCliPath: z.string(),
    command: z.array(z.string()),
    specPath: z.string().nullable(),
    reportPath: z.string().nullable(),
    workspaceDir: z.string(),
    warnings: z.array(z.string()),
  })
  .strict();

export type RunDiagnostics = z.infer<typeof runDiagnosticsSchema>;

export const runErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    detail: z.unknown().optional(),
  })
  .strict();

export type RunError = z.infer<typeof runErrorSchema>;

export const runSchema = z
  .object({
    id: resourceIdSchema,
    kind: runKindSchema,
    caseId: resourceIdSchema.nullable(),
    suiteId: resourceIdSchema.nullable(),
    datasetId: resourceIdSchema.nullable(),
    options: runOptionsSchema,
    status: runStatusSchema,
    queuePosition: z.number().int().min(1).nullable(),
    requestedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    finishedAt: isoDateTimeSchema.nullable(),
    cancelRequestedAt: isoDateTimeSchema.nullable(),
    exitCode: z.number().int().nullable(),
    stats: runStatsSchema,
    itemsCount: z.number().int().nonnegative(),
    artifactsCount: z.number().int().nonnegative(),
    environment: environmentFingerprintSchema,
    error: runErrorSchema.nullable(),
    diagnostics: runDiagnosticsSchema,
    idempotencyKey: z.string().nullable(),
  })
  .strict();

export type Run = z.infer<typeof runSchema>;

export const RUN_ITEM_ATTEMPT_STATUSES = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'] as const;
export type RunItemAttemptStatus = (typeof RUN_ITEM_ATTEMPT_STATUSES)[number];

export const errorLocationSchema = z
  .object({
    file: z.string(),
    line: z.number().int().min(0),
    column: z.number().int().min(0),
  })
  .strict();

export type ErrorLocation = z.infer<typeof errorLocationSchema>;

export const runItemErrorSchema = z
  .object({
    message: z.string(),
    stack: z.string().optional(),
    snippet: z.string().optional(),
    location: errorLocationSchema.optional(),
  })
  .strict();

export type RunItemError = z.infer<typeof runItemErrorSchema>;

/** test.step 轨迹（官方 JSON 报告 steps[] 的递归形状） */
export interface StepTrace {
  title: string;
  durationMs: number;
  error: string | null;
  steps?: StepTrace[];
}

export const stepTraceSchema: z.ZodType<StepTrace> = z.lazy(() =>
  z
    .object({
      title: z.string(),
      durationMs: z.number(),
      error: z.string().nullable(),
      steps: z.array(stepTraceSchema).optional(),
    })
    .strict(),
);

export const attachmentRefSchema = z
  .object({
    name: z.string(),
    contentType: z.string(),
    artifactId: z.string().nullable(),
  })
  .strict();

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

export const runItemAttemptSchema = z
  .object({
    attempt: z.number().int().nonnegative(),
    status: z.enum(RUN_ITEM_ATTEMPT_STATUSES),
    durationMs: z.number().nonnegative(),
    startTime: looseDateTimeSchema,
    error: runItemErrorSchema.nullable(),
    /** 官方 results[].errors[] 全量（architecture §9.3：不裁剪） */
    errors: z.array(runItemErrorSchema).optional(),
    errorHash: z.string(),
    steps: z.array(stepTraceSchema),
    attachments: z.array(attachmentRefSchema),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
  })
  .strict();

export type RunItemAttempt = z.infer<typeof runItemAttemptSchema>;

export const runItemSchema = z
  .object({
    itemKey: z.string().min(1),
    caseId: resourceIdSchema,
    rowIndex: z.number().int().nonnegative().nullable(),
    title: z.string(),
    projectName: z.string().nullable(),
    outcome: itemOutcomeSchema,
    durationMs: z.number().nonnegative(),
    attempts: z.array(runItemAttemptSchema),
  })
  .strict();

export type RunItem = z.infer<typeof runItemSchema>;

/** 创建运行的请求（api-contract §5.3 + 附录 A.4） */
export const runTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('case'), caseId: z.string().min(1).max(160) }).strict(),
  z.object({ kind: z.literal('suite'), suiteId: z.string().min(1).max(160) }).strict(),
]);

export type RunTarget = z.infer<typeof runTargetSchema>;

export const createRunRequestSchema = z
  .object({
    target: runTargetSchema,
    datasetId: z.string().min(1).max(160).optional(),
    options: runOptionsSchema.optional(),
    reason: z.string().max(200).optional(),
  })
  .strict();

export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

export const runListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  status: runStatusSchema.optional(),
  caseId: z.string().min(1).max(160).optional(),
  suiteId: z.string().min(1).max(160).optional(),
});

export type RunListQuery = z.infer<typeof runListQuerySchema>;

export const runItemListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  status: itemOutcomeSchema.optional(),
  rowIndex: z.coerce.number().int().min(0).optional(),
});

export type RunItemListQuery = z.infer<typeof runItemListQuerySchema>;

/** 单次执行最大保留 stdout/stderr 字节数（architecture §9.3：>8 KiB 截断并标记） */
export const STREAM_TRUNCATE_BYTES = 8 * 1024;

/** itemKey 生成规则（api-contract §5.2，唯一实现） */
export function buildItemKey(caseId: string, rowIndex: number | null, duplicateIndex?: number): string {
  const base = rowIndex === null ? caseId : `${caseId}#row:${rowIndex}`;
  return duplicateIndex === undefined ? base : `${base}#idx:${duplicateIndex}`;
}

/** 从 itemKey 反解 caseId（itemKey 以 caseId 开头，见 §5.2） */
export function caseIdFromItemKey(itemKey: string): string {
  const hashIndex = itemKey.indexOf('#');
  return hashIndex === -1 ? itemKey : itemKey.slice(0, hashIndex);
}

/** itemKey 中解析行号（无行号返回 null） */
export function rowIndexFromItemKey(itemKey: string): number | null {
  const match = /#row:(\d+)/.exec(itemKey);
  if (!match) return null;
  const value = Number.parseInt(match[1] ?? '', 10);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** 状态判定唯一口径（api-contract §5.1） */
export function deriveRunStatus(input: {
  stats: RunStats;
  exitCode: number | null;
  failOnFlaky: boolean;
}): 'passed' | 'failed' {
  const flakyFails = input.failOnFlaky && input.stats.flaky > 0;
  const ok = input.stats.unexpected === 0 && !flakyFails && input.exitCode === 0;
  return ok ? 'passed' : 'failed';
}

export const EMPTY_RUN_STATS: RunStats = { expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 };