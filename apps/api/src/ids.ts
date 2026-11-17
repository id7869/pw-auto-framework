/**
 * 资源 id 生成（api-contract §0：不透明、稳定、不可猜测、带类型前缀、≥16 字符）。
 * 生成方式为实现自由，这里用 16 字节随机 + 前缀，永不使用自增数字。
 */

import { randomBytes } from 'node:crypto';

export const ID_PREFIX = {
  case: 'case',
  dataset: 'ds',
  row: 'row',
  suite: 'suite',
  run: 'run',
  item: 'item',
  artifact: 'art',
  baseline: 'base',
  comparison: 'cmp',
  scaffold: 'scf',
  mcpSession: 'mcps',
  nlGeneration: 'nlg',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${randomBytes(16).toString('hex')}`;
}

/** 请求 id：`req_` + UUID（同时写入响应头与错误信封，便于日志关联） */
export function newRequestId(): string {
  return `req_${randomBytes(16).toString('hex')}`;
}