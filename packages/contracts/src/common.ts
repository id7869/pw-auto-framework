/**
 * 通用合同：错误码目录、错误信封、分页容器、时间与 ID 约束。
 * 权威来源：docs/api-contract.md §0、§10、附录 A.1/A.2。
 *
 * 约束：本文件是前后端唯一事实来源；apps/api 与 apps/web 不得各自复写错误码。
 */

import { z } from 'zod';

/** 固定错误码枚举（34 项，见 api-contract §10，顺序与文档一致） */
export const ERROR_CODES = [
  'INVALID_JSON',
  'INVALID_PATH',
  'PATH_FORBIDDEN',
  'CAPABILITY_DISABLED',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'BASELINE_SCOPE_MISMATCH',
  'COMPARISON_SCOPE_MISMATCH',
  'SESSION_NOT_READY',
  'CONFIRM_REQUIRED',
  'VALIDATION_FAILED',
  'INVALID_STEP',
  'UNKNOWN_COLUMN',
  'INVALID_DATASET',
  'EMPTY_DATASET',
  'ROW_LIMIT_EXCEEDED',
  'ROW_TOO_LARGE',
  'UNKNOWN_CASE',
  'RUN_NOT_TERMINAL',
  'TOO_MANY_RUNS',
  'TOO_MANY_MCP_SESSIONS',
  'NOT_IMPLEMENTED',
  'SUBPROCESS_ERROR',
  'ENGINE_ERROR',
  'TOOL_TIMEOUT',
  'RUN_TIMEOUT',
  'RUN_INTERRUPTED',
  'INTERNAL_ERROR',
  // R6/R7 增量（NL 与 harness 入口）
  'NL_NOT_GENERATED',
  'NL_STALE',
  'NL_GENERATION_CONFLICT',
  'NL_GENERATION_TIMEOUT',
  'NL_SUBMIT_INVALID',
  'NL_RULE_FALLBACK_DISABLED',
  'HARNESS_NOT_SUPPORTED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

/** 错误码 → HTTP 状态（api-contract §10 逐条映射） */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_JSON: 400,
  INVALID_PATH: 400,
  PATH_FORBIDDEN: 403,
  CAPABILITY_DISABLED: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  BASELINE_SCOPE_MISMATCH: 409,
  COMPARISON_SCOPE_MISMATCH: 409,
  SESSION_NOT_READY: 409,
  CONFIRM_REQUIRED: 428,
  VALIDATION_FAILED: 422,
  INVALID_STEP: 422,
  UNKNOWN_COLUMN: 422,
  INVALID_DATASET: 422,
  EMPTY_DATASET: 422,
  ROW_LIMIT_EXCEEDED: 422,
  ROW_TOO_LARGE: 422,
  UNKNOWN_CASE: 422,
  RUN_NOT_TERMINAL: 422,
  TOO_MANY_RUNS: 429,
  TOO_MANY_MCP_SESSIONS: 429,
  NOT_IMPLEMENTED: 501,
  SUBPROCESS_ERROR: 502,
  ENGINE_ERROR: 502,
  TOOL_TIMEOUT: 504,
  RUN_TIMEOUT: 504,
  RUN_INTERRUPTED: 502,
  INTERNAL_ERROR: 500,
  NL_NOT_GENERATED: 422,
  NL_STALE: 409,
  NL_GENERATION_CONFLICT: 409,
  NL_GENERATION_TIMEOUT: 504,
  NL_SUBMIT_INVALID: 422,
  NL_RULE_FALLBACK_DISABLED: 403,
  HARNESS_NOT_SUPPORTED: 422,
};

export const errorDetailSchema = z
  .object({
    path: z.string(),
    message: z.string(),
  })
  .strict();

export type ErrorDetail = z.infer<typeof errorDetailSchema>;

/** 统一错误信封（api-contract 附录 A.1） */
export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: errorCodeSchema,
        message: z.string().min(1),
        details: z.array(errorDetailSchema).optional(),
        requestId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** 分页容器（api-contract 附录 A.2） */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function makePageSchema<T extends z.ZodType>(itemSchema: T): z.ZodType<Page<z.infer<T>>> {
  return z
    .object({
      items: z.array(itemSchema),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    })
    .strict() as unknown as z.ZodType<Page<z.infer<T>>>;
}

/** 列表通用查询：limit(1..100，默认 20) + cursor + order */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** 时间：UTC ISO-8601 毫秒（api-contract §0） */
export const ISO_UTC_MS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const isoDateTimeSchema = z
  .string()
  .regex(ISO_UTC_MS_PATTERN, '必须是 UTC ISO-8601 毫秒时间（如 2026-11-11T02:03:04.567Z）');

/** 外部来源（引擎/官方报告）的时间串：只要求非空，不强制格式，避免伪造校验失败 */
export const looseDateTimeSchema = z.string().min(1);

/** 不透明资源 id（api-contract §0：≥16 字符、稳定、不可猜测） */
export const resourceIdSchema = z.string().min(1).max(160);

export const idempotencyKeySchema = z
  .string()
  .regex(/^[\x21-\x7e]{8,64}$/, 'Idempotency-Key 必须是 8..64 个可见 ASCII 字符');

/** 审计动作名（audit_log.action） */
export const AUDIT_ACTIONS = [
  'case.create',
  'case.update',
  'case.delete',
  'dataset.create',
  'dataset.update',
  'dataset.delete',
  'dataset.rows.replace',
  'suite.create',
  'suite.update',
  'suite.delete',
  'suite.cases.replace',
  'run.create',
  'run.cancel',
  'baseline.create',
  'baseline.default',
  'baseline.archive',
  'comparison.create',
  'scaffold.create',
  'mcp.session.create',
  'mcp.tool.call',
  'mcp.session.close',
  'cli.exec',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];