/**
 * 回归基线（Baseline）合同。权威来源：docs/api-contract.md §6.1。
 *
 * 约束：只有 `run.status === "passed"` 的运行可设基线（错误码 BASELINE_SCOPE_MISMATCH）。
 */

import { z } from 'zod';
import { isoDateTimeSchema, resourceIdSchema } from './common.ts';

export const BASELINE_SCOPES = ['case', 'suite'] as const;
export type BaselineScope = (typeof BASELINE_SCOPES)[number];
export const baselineScopeSchema = z.enum(BASELINE_SCOPES);

export const BASELINE_CREATED_BY = ['user', 'agent', 'system'] as const;
export type BaselineCreatedBy = (typeof BASELINE_CREATED_BY)[number];
export const baselineCreatedBySchema = z.enum(BASELINE_CREATED_BY);

export const baselineSchema = z
  .object({
    id: resourceIdSchema,
    scope: baselineScopeSchema,
    scopeId: resourceIdSchema,
    runId: resourceIdSchema,
    name: z.string().min(1).max(200),
    note: z.string().max(2000).nullable(),
    isDefault: z.boolean(),
    archivedAt: isoDateTimeSchema.nullable(),
    createdBy: baselineCreatedBySchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type Baseline = z.infer<typeof baselineSchema>;

export const createBaselineRequestSchema = z
  .object({
    scope: baselineScopeSchema,
    scopeId: z.string().min(1).max(160),
    runId: z.string().min(1).max(160),
    name: z.string().min(1).max(200),
    note: z.string().max(2000).nullable().optional(),
    createdBy: baselineCreatedBySchema.default('user'),
  })
  .strict();

export type CreateBaselineRequest = z.infer<typeof createBaselineRequestSchema>;

export const baselineListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  scope: baselineScopeSchema.optional(),
  scopeId: z.string().min(1).max(160).optional(),
  archived: z.enum(['true', 'false']).optional(),
});

export type BaselineListQuery = z.infer<typeof baselineListQuerySchema>;

export const baselineConfirmRequestSchema = z
  .object({
    confirm: z.boolean().optional(),
  })
  .strict()
  .default({});

export type BaselineConfirmRequest = z.infer<typeof baselineConfirmRequestSchema>;