/**
 * 统一错误类型：所有业务错误都必须携带**机器可读错误码**（api-contract §10）。
 * HTTP 层只做「AppError → 错误信封」的映射，不再自行拼错误码。
 */

import { ERROR_CODES, ERROR_HTTP_STATUS, type ErrorCode, type ErrorDetail } from '@pw-auto/contracts';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[], status?: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? ERROR_HTTP_STATUS[code];
    this.details = details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function notFound(message: string): AppError {
  return new AppError('NOT_FOUND', message);
}

export function validationFailed(message: string, details?: ErrorDetail[]): AppError {
  return new AppError('VALIDATION_FAILED', message, details);
}

/** 断言辅助：便于在 service 内表达「必须存在」的前置条件 */
export function assertFound<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw notFound(message);
  return value;
}

/**
 * 官方适配层（`@pw-auto/automation` 的 AutomationError）→ AppError。
 *
 * 纪律：适配层抛出的错误码与 api-contract §10 同名（INVALID_PATH / PATH_FORBIDDEN /
 * CAPABILITY_DISABLED / NOT_IMPLEMENTED / SUBPROCESS_ERROR / TOOL_TIMEOUT / SESSION_NOT_READY …），
 * 必须**原样保留**，不得一律压成 502。
 */
export function fromAdapterError(error: unknown, context: string, fallbackCode: ErrorCode = 'SUBPROCESS_ERROR'): AppError {
  if (isAppError(error)) return error;
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
  const rawCode = record?.['code'];
  const message =
    (typeof record?.['message'] === 'string' && record['message']) ||
    (error instanceof Error ? error.message : String(error));
  const code =
    typeof rawCode === 'string' && (ERROR_CODES as readonly string[]).includes(rawCode)
      ? (rawCode as ErrorCode)
      : fallbackCode;
  return new AppError(code, `${context}：${message || '未知错误'}`);
}