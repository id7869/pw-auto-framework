import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_KIND_LABELS,
  ATTRIBUTION_CATEGORY_LABELS,
  ATTRIBUTION_CONFIDENCE_LABELS,
  ATTRIBUTION_DISCLAIMER,
  BASELINE_SCOPE_LABELS,
  CASE_MODE_LABELS,
  COMPARISON_CHANGE_LABELS,
  DATASET_SOURCE_LABELS,
  ERROR_CODE_LABELS,
  FAILURE_CATEGORY_LABELS,
  OUTCOME_LABELS,
  PASS_RATE_NOTE,
  RUN_STATUS_LABELS,
  VERDICT_BASIS_NOTE,
  agentLoopLabel,
  errorCodeLabel,
  failureCategoryLabel,
  labelOf,
} from './labels.ts';

describe('lib/labels：中文文案映射', () => {
  it('运行 6 态', () => {
    expect(Object.keys(RUN_STATUS_LABELS)).toEqual(['queued', 'running', 'passed', 'failed', 'cancelled', 'error']);
    expect(RUN_STATUS_LABELS.queued).toBe('排队中');
    expect(RUN_STATUS_LABELS.running).toBe('运行中');
    expect(RUN_STATUS_LABELS.passed).toBe('通过');
  });

  it('逐项结果 6 态与 10 类差异', () => {
    expect(Object.keys(OUTCOME_LABELS)).toHaveLength(6);
    expect(OUTCOME_LABELS.flaky).toContain('偶发');
    expect(Object.keys(COMPARISON_CHANGE_LABELS)).toHaveLength(10);
    expect(COMPARISON_CHANGE_LABELS.newly_failed).toBe('新增失败');
    expect(COMPARISON_CHANGE_LABELS.became_flaky).toContain('偶发');
  });

  it('产物 10 类、基线、模式、数据集来源', () => {
    expect(Object.keys(ARTIFACT_KIND_LABELS)).toHaveLength(10);
    expect(ARTIFACT_KIND_LABELS.trace).toContain('Trace');
    expect(BASELINE_SCOPE_LABELS.case).toBe('用例');
    expect(CASE_MODE_LABELS.code).toContain('原始');
    expect(DATASET_SOURCE_LABELS.csv).toContain('CSV');
  });

  it('错误码覆盖合同 §10 的固定枚举', () => {
    for (const code of [
      'INVALID_JSON',
      'PATH_FORBIDDEN',
      'CAPABILITY_DISABLED',
      'NOT_FOUND',
      'VERSION_CONFLICT',
      'CONFIRM_REQUIRED',
      'VALIDATION_FAILED',
      'INVALID_STEP',
      'UNKNOWN_COLUMN',
      'EMPTY_DATASET',
      'RUN_NOT_TERMINAL',
      'NOT_IMPLEMENTED',
      'SUBPROCESS_ERROR',
      'TOOL_TIMEOUT',
      'RUN_INTERRUPTED',
      'INTERNAL_ERROR',
    ]) {
      expect(ERROR_CODE_LABELS[code]?.length).toBeGreaterThan(0);
    }
    expect(errorCodeLabel('UNKNOWN_X')).toBe('UNKNOWN_X');
    expect(errorCodeLabel('INVALID_STEP')).toBe('步骤配置不合法');
  });

  it('归因标签与免责声明（推断）', () => {
    expect(FAILURE_CATEGORY_LABELS.locator_not_found).toBe('元素未找到');
    expect(FAILURE_CATEGORY_LABELS.unknown).toBe('无法归因');
    expect(ATTRIBUTION_CONFIDENCE_LABELS.high).toContain('置信度');
    expect(ATTRIBUTION_DISCLAIMER).toContain('推断');
    expect(VERDICT_BASIS_NOTE).toContain('胶水层计算');
    expect(PASS_RATE_NOTE).toContain('胶水层');
  });

  it('8 类失败原因分类全部有中文标签，且与旧别名一致', () => {
    const expected: Record<string, string> = {
      locator_not_found: '元素未找到',
      timeout: '超时',
      assertion_mismatch: '断言不匹配',
      navigation_error: '导航错误',
      network_error: '网络错误',
      data_error: '数据问题',
      environment_error: '环境问题',
      unknown: '无法归因',
    };
    expect(Object.keys(FAILURE_CATEGORY_LABELS)).toHaveLength(8);
    for (const [category, label] of Object.entries(expected)) {
      expect(FAILURE_CATEGORY_LABELS[category as keyof typeof FAILURE_CATEGORY_LABELS]).toBe(label);
      expect(failureCategoryLabel(category)).toBe(label);
      expect(ATTRIBUTION_CATEGORY_LABELS[category as keyof typeof ATTRIBUTION_CATEGORY_LABELS]).toBe(label);
    }
    expect(failureCategoryLabel('assertion_mismatch')).toBe('断言不匹配');
    expect(failureCategoryLabel(null)).toBe('无失败分类');
    expect(failureCategoryLabel(undefined)).toBe('无失败分类');
    expect(failureCategoryLabel('unknown_category')).toBe('unknown_category');
  });

  it('agent loop 中文标签与兜底', () => {
    expect(agentLoopLabel('claude')).toBe('Claude Code');
    expect(agentLoopLabel('vscode-legacy')).toContain('legacy');
    expect(agentLoopLabel('other')).toBe('other');
    expect(labelOf(RUN_STATUS_LABELS, 'passed')).toBe('通过');
    expect(labelOf(RUN_STATUS_LABELS, null)).toBe('—');
  });
});