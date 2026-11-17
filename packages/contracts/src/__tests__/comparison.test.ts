import { describe, expect, it } from 'vitest';
import {
  buildItemKey,
  caseIdFromItemKey,
  computeComparisonChange,
  computeVerdict,
  deriveRunStatus,
  rowIndexFromItemKey,
  summarizeComparison,
} from '../index.ts';

describe('contracts/comparison 归一化规则表', () => {
  // api-contract §6.2 表格逐格断言（5×5 = 25 格）
  const table: Record<string, Record<string, string>> = {
    expected: {
      expected: 'still_passed',
      unexpected: 'newly_failed',
      flaky: 'became_flaky',
      skipped: 'skipped',
      missing: 'missing_item',
    },
    unexpected: {
      expected: 'newly_passed',
      unexpected: 'still_failed',
      flaky: 'flaky',
      skipped: 'skipped',
      missing: 'missing_item',
    },
    flaky: {
      expected: 'flaky',
      unexpected: 'flaky',
      flaky: 'flaky',
      skipped: 'skipped',
      missing: 'missing_item',
    },
    skipped: {
      expected: 'new_item',
      unexpected: 'new_item',
      flaky: 'new_item',
      skipped: 'skipped',
      missing: 'missing_item',
    },
    missing: {
      expected: 'new_item',
      unexpected: 'new_item',
      flaky: 'new_item',
      skipped: 'new_item',
      missing: 'unknown',
    },
  };

  it('25 个组合与合同表完全一致', () => {
    for (const [base, row] of Object.entries(table)) {
      for (const [target, expected] of Object.entries(row)) {
        const actual = computeComparisonChange(base as never, target as never);
        expect(`${base}->${target}=${actual}`).toBe(`${base}->${target}=${expected}`);
      }
    }
  });

  it('涉及 unknown 的组合保守判 unknown', () => {
    expect(computeComparisonChange('unknown', 'expected')).toBe('unknown');
    expect(computeComparisonChange('expected', 'unknown')).toBe('unknown');
  });
});

describe('contracts/comparison verdict 推导', () => {
  it('newly_failed 优先判 regression', () => {
    expect(computeVerdict({ newly_failed: 1, newly_passed: 3, flaky: 2, became_flaky: 1 })).toBe('regression');
  });

  it('无新增失败但有新增通过判 improvement', () => {
    expect(computeVerdict({ newly_failed: 0, newly_passed: 2, flaky: 0, became_flaky: 0 })).toBe('improvement');
  });

  it('flaky/became_flaky 判 mixed', () => {
    expect(computeVerdict({ newly_failed: 0, newly_passed: 0, flaky: 1, became_flaky: 0 })).toBe('mixed');
    expect(computeVerdict({ newly_failed: 0, newly_passed: 0, flaky: 0, became_flaky: 1 })).toBe('mixed');
  });

  it('全 0 判 unchanged', () => {
    expect(computeVerdict({ newly_failed: 0, newly_passed: 0, flaky: 0, became_flaky: 0 })).toBe('unchanged');
  });

  it('summary 计数与 verdictBasis 固定为 computed', () => {
    const summary = summarizeComparison(['still_passed', 'newly_failed', 'missing_item', 'skipped']);
    expect(summary.total).toBe(4);
    expect(summary.still_passed).toBe(1);
    expect(summary.newly_failed).toBe(1);
    expect(summary.missing_item).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.verdict).toBe('regression');
    expect(summary.verdictBasis).toBe('computed');
  });
});

describe('contracts/run 状态与 itemKey', () => {
  it('itemKey 生成与反解一致', () => {
    expect(buildItemKey('case_1', null)).toBe('case_1');
    expect(buildItemKey('case_1', 3)).toBe('case_1#row:3');
    expect(buildItemKey('case_1', 3, 1)).toBe('case_1#row:3#idx:1');

    expect(caseIdFromItemKey('case_1')).toBe('case_1');
    expect(caseIdFromItemKey('case_1#row:3')).toBe('case_1');
    expect(caseIdFromItemKey('case_1#row:3#idx:1')).toBe('case_1');

    expect(rowIndexFromItemKey('case_1')).toBeNull();
    expect(rowIndexFromItemKey('case_1#row:7')).toBe(7);
  });

  it('passed 判定：unexpected 与 exitCode 必须归零', () => {
    expect(deriveRunStatus({ stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0, durationMs: 1 }, exitCode: 0, failOnFlaky: false })).toBe('passed');
    expect(deriveRunStatus({ stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0, durationMs: 1 }, exitCode: 0, failOnFlaky: false })).toBe('failed');
    expect(deriveRunStatus({ stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0, durationMs: 1 }, exitCode: 1, failOnFlaky: false })).toBe('failed');
  });

  it('failOnFlaky 关闭时 flaky 不导致 failed，开启时导致 failed', () => {
    const stats = { expected: 1, unexpected: 0, flaky: 1, skipped: 0, durationMs: 1 };
    expect(deriveRunStatus({ stats, exitCode: 0, failOnFlaky: false })).toBe('passed');
    expect(deriveRunStatus({ stats, exitCode: 0, failOnFlaky: true })).toBe('failed');
  });
});