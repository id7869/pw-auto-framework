/**
 * packages/automation 的统一错误类型。
 *
 * 设计目标：
 * 1. 错误码与 docs/api-contract.md §10 的固定枚举保持一致，由 apps/api 直接映射 HTTP 状态码；
 * 2. message 一律中文、可直接展示给最终用户；
 * 3. details 保持 `{ path, message }[]` 形态，便于 zod/表单定位；detail 承载诊断附加值。
 *
 * 注意：本文件属于“胶水层”，不复制任何 Playwright 内部错误类型。
 */

/** 与 api-contract §10 对齐的自动化层错误码（仅使用本层会产生的子集）。 */
export const AUTOMATION_ERROR_CODES = [
  'INVALID_PATH',
  'PATH_FORBIDDEN',
  'CAPABILITY_DISABLED',
  'NOT_FOUND',
  'SESSION_NOT_READY',
  'CONFIRM_REQUIRED',
  'VALIDATION_FAILED',
  'INVALID_STEP',
  'UNKNOWN_COLUMN',
  'INVALID_DATASET',
  'EMPTY_DATASET',
  'ROW_LIMIT_EXCEEDED',
  'ROW_TOO_LARGE',
  'NOT_IMPLEMENTED',
  'SUBPROCESS_ERROR',
  'ENGINE_ERROR',
  'TOOL_TIMEOUT',
  'RUN_TIMEOUT',
] as const;

export type AutomationErrorCode = (typeof AUTOMATION_ERROR_CODES)[number];

export interface AutomationErrorDetailItem {
  path: string;
  message: string;
}

export interface AutomationErrorOptions {
  /** 字段级错误，映射 api-contract 的 error.details[]。 */
  details?: AutomationErrorDetailItem[];
  /** 诊断附加值（stdout 摘要、session 快照、命令回显等），不直接暴露给普通用户。 */
  detail?: unknown;
  /** 保留底层错误，便于日志。 */
  cause?: unknown;
}

export class AutomationError extends Error {
  readonly code: AutomationErrorCode;
  readonly details?: AutomationErrorDetailItem[];
  readonly detail?: unknown;

  constructor(code: AutomationErrorCode, message: string, options?: AutomationErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AutomationError';
    this.code = code;
    if (options?.details !== undefined) this.details = options.details;
    if (options?.detail !== undefined) this.detail = options.detail;
  }

  /** 供 JSON 日志/HTTP 错误信封直接序列化。 */
  toJSON(): { code: AutomationErrorCode; message: string; details?: AutomationErrorDetailItem[]; detail?: unknown } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}

export function isAutomationError(value: unknown): value is AutomationError {
  return value instanceof AutomationError;
}

/** 把未知异常归一为 AutomationError（不吞掉原始 message）。 */
export function toAutomationError(value: unknown, fallbackCode: AutomationErrorCode = 'ENGINE_ERROR'): AutomationError {
  if (isAutomationError(value)) return value;
  if (value instanceof Error) {
    return new AutomationError(fallbackCode, value.message, { cause: value });
  }
  return new AutomationError(fallbackCode, String(value), { cause: value });
}