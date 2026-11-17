/**
 * 回归对比（Comparison）合同 + 归一化规则实现。
 * 权威来源：docs/api-contract.md §6.2（含「归一化规则」表，必须逐条实现）。
 *
 * 声明纪律：`verdict`/`change` 均为**胶水层计算**，不是 Playwright 官方输出；
 * 响应必须回显 `summary.verdictBasis: "computed"`。
 */

import { z } from 'zod';
import { isoDateTimeSchema, resourceIdSchema } from './common.ts';
import { baselineScopeSchema } from './baseline.ts';
import { comparisonChangeSchema, type ComparisonChange, type ItemOutcome, itemOutcomeSchema } from './run-status.ts';

export const COMPARISON_VERDICTS = ['regression', 'improvement', 'unchanged', 'mixed'] as const;
export type ComparisonVerdict = (typeof COMPARISON_VERDICTS)[number];
export const comparisonVerdictSchema = z.enum(COMPARISON_VERDICTS);

export const comparisonSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    newly_failed: z.number().int().nonnegative(),
    newly_passed: z.number().int().nonnegative(),
    still_failed: z.number().int().nonnegative(),
    still_passed: z.number().int().nonnegative(),
    flaky: z.number().int().nonnegative(),
    became_flaky: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    new_item: z.number().int().nonnegative(),
    missing_item: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    verdict: comparisonVerdictSchema,
    verdictBasis: z.literal('computed'),
  })
  .strict();

export type ComparisonSummary = z.infer<typeof comparisonSummarySchema>;

export const comparisonSchema = z
  .object({
    id: resourceIdSchema,
    baselineId: resourceIdSchema,
    baselineRunId: resourceIdSchema,
    runId: resourceIdSchema,
    scope: baselineScopeSchema,
    scopeId: resourceIdSchema,
    summary: comparisonSummarySchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type Comparison = z.infer<typeof comparisonSchema>;

export const ATTRIBUTION_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type AttributionConfidence = (typeof ATTRIBUTION_CONFIDENCES)[number];

/**
 * 失败原因分类（PRD R3.5，基于官方证据 errorLocation/errors[]/steps[]/attachments/stdout-stderr 规则推断）。
 * 注意：这是**胶水层推断**，不是官方结论；UI 必须显示「推断」标签并链接原始证据（PRD R3.5）。
 */
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
export const failureCategorySchema = z.enum(FAILURE_CATEGORIES);

/**
 * 归因结果：
 * - `category`：回归变化型归因（new_failure / failure_error_changed / fixed / flaky …），描述「与基线相比发生了什么」；
 * - `failureCategory`：PRD R3.5 的失败原因分类（locator_not_found / timeout / …），仅在失败类变化时有值，
 *   非失败变化（新增通过、缺失项、跳过等）为 null；
 * - `evidence`：官方证据引用（error.message 片段、errorLocation、errors[] 数量、attach ments 名称、失败 step 标题）。
 */
export const comparisonAttributionSchema = z
  .object({
    category: z.string().min(1),
    failureCategory: failureCategorySchema.nullable().optional(),
    confidence: z.enum(ATTRIBUTION_CONFIDENCES),
    evidence: z.array(z.string()),
  })
  .strict();

export type ComparisonAttribution = z.infer<typeof comparisonAttributionSchema>;

export const comparisonItemSchema = z
  .object({
    itemKey: z.string().min(1),
    rowIndex: z.number().int().nonnegative().nullable(),
    change: comparisonChangeSchema,
    baseOutcome: itemOutcomeSchema,
    targetOutcome: itemOutcomeSchema,
    errorChanged: z.boolean(),
    baseErrorHash: z.string().nullable(),
    targetErrorHash: z.string().nullable(),
    durationDeltaMs: z.number().nullable(),
    artifactDelta: z
      .object({
        added: z.array(z.string()),
        removed: z.array(z.string()),
      })
      .strict(),
    attribution: comparisonAttributionSchema.nullable().optional(),
  })
  .strict();

export type ComparisonItem = z.infer<typeof comparisonItemSchema>;

/** POST /comparisons 与 GET /comparisons/{id} 的统一响应形状 */
export const comparisonDetailSchema = z
  .object({
    comparison: comparisonSchema,
    items: z.array(comparisonItemSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export type ComparisonDetail = z.infer<typeof comparisonDetailSchema>;

export const createComparisonRequestSchema = z
  .object({
    baselineId: z.string().min(1).max(160),
    runId: z.string().min(1).max(160),
  })
  .strict();

export type CreateComparisonRequest = z.infer<typeof createComparisonRequestSchema>;

export const comparisonListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  runId: z.string().min(1).max(160).optional(),
  baselineId: z.string().min(1).max(160).optional(),
});

export type ComparisonListQuery = z.infer<typeof comparisonListQuerySchema>;

/** GET /comparisons/{id} 的 items 分页参数（页面大小与游标独立于列表） */
export const comparisonDetailQuerySchema = z.object({
  itemsLimit: z.coerce.number().int().min(1).max(100).default(20),
  itemsCursor: z.string().min(1).max(512).optional(),
});

export type ComparisonDetailQuery = z.infer<typeof comparisonDetailQuerySchema>;

/**
 * 归一化规则表（api-contract §6.2）逐条实现。
 * 未在表中的组合（涉及 unknown）一律保守判为 `unknown`，不猜测。
 */
const CHANGE_TABLE: Record<ItemOutcome, Partial<Record<ItemOutcome, ComparisonChange>>> = {
  expected: {
    expected: 'still_passed',
    unexpected: 'newly_failed',
    flaky: 'became_flaky',
    skipped: 'skipped',
    missing: 'missing_item',
  },
  unexpected: {
    expected: 'newly_passed',
    unexpected: 'still_failed',
    flaky: 'flaky',
    skipped: 'skipped',
    missing: 'missing_item',
  },
  flaky: {
    expected: 'flaky',
    unexpected: 'flaky',
    flaky: 'flaky',
    skipped: 'skipped',
    missing: 'missing_item',
  },
  skipped: {
    expected: 'new_item',
    unexpected: 'new_item',
    flaky: 'new_item',
    skipped: 'skipped',
    missing: 'missing_item',
  },
  missing: {
    expected: 'new_item',
    unexpected: 'new_item',
    flaky: 'new_item',
    skipped: 'new_item',
    missing: 'unknown',
  },
  unknown: {},
};

export function computeComparisonChange(baseOutcome: ItemOutcome, targetOutcome: ItemOutcome): ComparisonChange {
  const mapped = CHANGE_TABLE[baseOutcome][targetOutcome];
  return mapped ?? 'unknown';
}

/** verdict 推导（api-contract §6.2，唯一实现） */
export function computeVerdict(counts: {
  newly_failed: number;
  newly_passed: number;
  flaky: number;
  became_flaky: number;
}): ComparisonVerdict {
  if (counts.newly_failed > 0) return 'regression';
  if (counts.newly_passed > 0) return 'improvement';
  if (counts.flaky + counts.became_flaky > 0) return 'mixed';
  return 'unchanged';
}

/** 统计各差异类别的数量并给出 verdict（verdictBasis 固定 computed） */
export function summarizeComparison(changes: readonly ComparisonChange[]): ComparisonSummary {
  const summary: ComparisonSummary = {
    total: changes.length,
    newly_failed: 0,
    newly_passed: 0,
    still_failed: 0,
    still_passed: 0,
    flaky: 0,
    became_flaky: 0,
    skipped: 0,
    new_item: 0,
    missing_item: 0,
    unknown: 0,
    verdict: 'unchanged',
    verdictBasis: 'computed',
  };
  for (const change of changes) summary[change] += 1;
  summary.verdict = computeVerdict(summary);
  return summary;
}