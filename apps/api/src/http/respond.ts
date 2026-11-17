/**
 * 统一响应写出（api-contract §0.1/§0.2）：
 * - 成功：`{ data, meta? }`，`meta.requestId` 必带；
 * - 错误：`{ error: { code, message, details?, requestId } }`；
 * - 全部响应：`Cache-Control: no-store` + `X-Request-Id`。
 */

import type { ServerResponse } from 'node:http';
import { ERROR_HTTP_STATUS, type ErrorCode, type ErrorDetail } from '@pw-auto/contracts';

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export type ResponseHeaders = Record<string, string | number>;

export function sendJson(res: ServerResponse, status: number, payload: unknown, requestId: string, extra?: ResponseHeaders): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-request-id': requestId,
    ...extra,
  });
  res.end(body);
}

export function sendData(res: ServerResponse, status: number, data: unknown, requestId: string, extra?: ResponseHeaders): void {
  sendJson(res, status, { data, meta: { requestId } }, requestId, extra);
}

export function sendError(
  res: ServerResponse,
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: ErrorDetail[],
  extra?: ResponseHeaders,
): void {
  const status = ERROR_HTTP_STATUS[code];
  const error: { code: ErrorCode; message: string; details?: ErrorDetail[]; requestId: string } = {
    code,
    message: message.trim() === '' ? '请求处理失败' : message,
    requestId,
  };
  if (details && details.length > 0) error.details = details;
  sendJson(res, status, { error }, requestId, extra);
}

export function sendNoContent(res: ServerResponse, requestId: string, extra?: ResponseHeaders): void {
  res.writeHead(204, {
    'cache-control': 'no-store',
    'x-request-id': requestId,
    ...extra,
  });
  res.end();
}