import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComparisonItem } from '../api/types.ts';
import { ComparisonRow } from './RegressionPage.tsx';

function renderRow(item: ComparisonItem): string {
  return renderToStaticMarkup(
    <table>
      <tbody>
        <ComparisonRow item={item} />
      </tbody>
    </table>,
  );
}

function baseItem(overrides: Partial<ComparisonItem>): ComparisonItem {
  return {
    itemKey: 'case_1#row:1',
    rowIndex: 1,
    change: 'newly_failed',
    baseOutcome: 'expected',
    targetOutcome: 'unexpected',
    errorChanged: true,
    baseErrorHash: null,
    targetErrorHash: 'abcdef1234567890',
    durationDeltaMs: 800,
    artifactDelta: { added: ['trace'], removed: [] },
    attribution: null,
    ...overrides,
  };
}

describe('pages/RegressionPage：失败分类展示', () => {
  it('优先展示 failureCategory 中文（断言不匹配），不把 new_failure 当失败原因', () => {
    const output = renderRow(
      baseItem({
        attribution: {
          category: 'new_failure',
          failureCategory: 'assertion_mismatch',
          confidence: 'high',
          evidence: ['官方 error.message：Expected: “你好”'],
        },
      }),
    );
    expect(output).toContain('断言不匹配');
    expect(output).toContain('失败原因分类（规则推断，非官方结论）');
    expect(output).toContain('新增失败'); // change 仍在“差异”列独立展示
    expect(output).not.toContain('new_failure');
    expect(output).not.toContain('>new_failure<');
  });

  it('failureCategory=null 时显示无失败分类并回退 change 说明，不显示原始 category', () => {
    const output = renderRow(
      baseItem({
        change: 'newly_passed',
        baseOutcome: 'unexpected',
        targetOutcome: 'expected',
        errorChanged: false,
        attribution: {
          category: 'fixed',
          failureCategory: null,
          confidence: 'high',
          evidence: ['基线为失败、本次为通过（回归变化）'],
        },
      }),
    );
    expect(output).toContain('无失败分类');
    expect(output).toContain('变化类型：由失败转通过');
    expect(output).toContain('该项不是失败类变化');
    expect(output).not.toContain('>fixed<');
  });

  it('无归因时显示需人工判断', () => {
    const output = renderRow(baseItem({ attribution: null }));
    expect(output).toContain('无归因（需人工判断）');
    expect(output).toContain('新增失败');
  });
});