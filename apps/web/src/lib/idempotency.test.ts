import { describe, expect, it } from 'vitest';
import { nextIdempotencyKey } from './idempotency.ts';

describe('lib/idempotency：幂等键生命周期', () => {
  it('失败（网络/服务端）重试复用同一键', () => {
    const key = 'pw-run-key-123';
    expect(nextIdempotencyKey(key, false)).toBe(key);
    // 连续失败仍复用
    expect(nextIdempotencyKey(nextIdempotencyKey(key, false), false)).toBe(key);
  });

  it('成功后清空，下一次意图重新生成', () => {
    expect(nextIdempotencyKey('pw-run-key-123', true)).toBe('');
    let generated = 0;
    const generate = (): string => {
      generated += 1;
      return `generated-${String(generated)}`;
    };
    expect(nextIdempotencyKey('', false, generate)).toBe('generated-1');
    expect(generated).toBe(1);
    expect(nextIdempotencyKey('generated-1', false, generate)).toBe('generated-1');
    expect(generated).toBe(1);
  });

  it('空键且未成功时生成新键（防御性兜底）', () => {
    const generated = nextIdempotencyKey('', false, () => 'fallback-key');
    expect(generated).toBe('fallback-key');
    expect(generated.length).toBeGreaterThan(0);
  });
});