import { z } from 'zod';

/**
 * 运行状态机（6 态，见 docs/api-contract.md §0.5）。
 * 只做常量与类型，状态迁移逻辑由 apps/api 实现。
 */
export const RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled', 'error'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = ['passed', 'failed', 'cancelled', 'error'] as const;
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export function isTerminalRunStatus(value: RunStatus): value is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(value);
}

/** 官方 JSON 报告的用例三态 + 缺失态（回归对比的输入口径） */
export const ITEM_OUTCOMES = ['expected', 'unexpected', 'flaky', 'skipped', 'missing', 'unknown'] as const;
export type ItemOutcome = (typeof ITEM_OUTCOMES)[number];

/** 回归差异枚举（固定 10 类，不得扩展） */
export const COMPARISON_CHANGES = [
  'newly_failed',
  'newly_passed',
  'still_failed',
  'still_passed',
  'flaky',
  'became_flaky',
  'skipped',
  'new_item',
  'missing_item',
  'unknown',
] as const;
export type ComparisonChange = (typeof COMPARISON_CHANGES)[number];

export const runStatusSchema = z.enum(RUN_STATUSES);
export const itemOutcomeSchema = z.enum(ITEM_OUTCOMES);
export const comparisonChangeSchema = z.enum(COMPARISON_CHANGES);
