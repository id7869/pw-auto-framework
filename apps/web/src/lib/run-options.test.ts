import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS } from './validation.ts';

describe('lib/validation：NL 运行选项', () => {
  it('默认不允许 stale NL 运行（与 api-contract §5.3 一致）', () => {
    expect(DEFAULT_RUN_OPTIONS.allowStaleNl).toBe(false);
  });
});