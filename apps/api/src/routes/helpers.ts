/**
 * 路由公共小工具：幂等键、If-Match、分页查询解析、强类型参数读取。
 */

import { idempotencyKeySchema } from '@pw-auto/contracts';
import { AppError } from '../errors.ts';
import { parseSchema, type RequestContext } from '../http/router.ts';
import { parseIfMatch } from '../services/cases.ts';

export function param(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (value === undefined || value === '') {
    throw new AppError('INVALID_PATH', `路径参数缺失或非法：${name}`);
  }
  return value;
}

/** Idempotency-Key：缺省 null；格式非法 → 422（不静默忽略） */
export function idempotencyKeyOf(ctx: RequestContext): string | null {
  const header = ctx.header('idempotency-key');
  if (header === undefined || header.trim() === '') return null;
  return parseSchema<string>(idempotencyKeySchema, header.trim(), 'Idempotency-Key');
}

export function ifMatchOf(ctx: RequestContext): number {
  return parseIfMatch(ctx.header('if-match'));
}

export function idempotencyHeaders(key: string | null, replayed: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (key !== null) headers['idempotency-key'] = key;
  if (replayed) headers['idempotent-replay'] = 'true';
  return headers;
}