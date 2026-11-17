/**
 * 创建运行/脚手架的幂等键生命周期（纯函数，便于单测）。
 *
 * 规则（api-contract §0.3）：
 * - 同一个对话框/意图内失败重试必须复用同一 Idempotency-Key，避免重复执行；
 * - 成功后清空，下一次意图重新生成；
 * - 空键时生成新键（正常不会发生，防御性兜底）。
 */
import { createIdempotencyKey } from '../api/http.ts';

export function nextIdempotencyKey(
  current: string,
  success: boolean,
  generate: () => string = createIdempotencyKey,
): string {
  if (success) return '';
  return current !== '' ? current : generate();
}