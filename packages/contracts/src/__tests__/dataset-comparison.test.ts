import { describe, expect, it } from 'vitest';
import {
  DATASET_LIMITS,
  FAILURE_CATEGORIES,
  FAILURE_CATEGORIES as CATEGORIES,
  comparisonAttributionSchema,
  createDatasetRequestSchema,
  patchDatasetRequestSchema,
  putDatasetRowsRequestSchema,
} from '../index.ts';

describe('contracts/dataset 结构化硬上限与业务错误码分工', () => {
  const oneRow = { data: { a: '1' } };

  it('2001 行可被 schema 接受（业务层据此返回 422 ROW_LIMIT_EXCEEDED）', () => {
    const rows = Array.from({ length: 2001 }, (_, index) => ({ data: { a: String(index) } }));
    expect(createDatasetRequestSchema.safeParse({ name: '边界', rows }).success).toBe(true);
    expect(putDatasetRowsRequestSchema.safeParse({ rows }).success).toBe(true);
    expect(rows.length).toBeGreaterThan(DATASET_LIMITS.maxRows);
  });

  it('超过结构化硬上限（10 万行）才由 schema 拒绝，防止内存放大', () => {
    const rows = Array.from({ length: DATASET_LIMITS.maxRequestRows + 1 }, (_, index) => ({ data: { a: String(index) } }));
    expect(createDatasetRequestSchema.safeParse({ name: '超硬上限', rows }).success).toBe(false);
  });

  it('8193 字符单元格 / 61 字符列名可由 schema 接受（业务层返回 ROW_TOO_LARGE / INVALID_DATASET）', () => {
    const longCell = 'x'.repeat(DATASET_LIMITS.maxCellChars + 1);
    expect(createDatasetRequestSchema.safeParse({ name: '长单元格', rows: [{ data: { a: longCell } }] }).success).toBe(true);
    const longColumn = 'c'.repeat(DATASET_LIMITS.maxColumnNameChars + 1);
    expect(createDatasetRequestSchema.safeParse({ name: '长列名', rows: [{ data: { [longColumn]: 'x' } }] }).success).toBe(true);
  });

  it('PATCH 数据集：name 可选但至少提供一个字段', () => {
    expect(patchDatasetRequestSchema.safeParse({}).success).toBe(false);
    expect(patchDatasetRequestSchema.safeParse({ name: '新名' }).success).toBe(true);
    expect(patchDatasetRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(createDatasetRequestSchema.safeParse({ name: '空行数据集', rows: [] }).success).toBe(true);
    expect(createDatasetRequestSchema.safeParse({ name: 'x', rows: [oneRow] }).success).toBe(true);
  });
});

describe('contracts/comparison PRD R3.5 失败原因分类', () => {
  it('failureCategory 枚举恰为 PRD R3.5 的 8 类', () => {
    expect(FAILURE_CATEGORIES).toEqual([
      'locator_not_found',
      'timeout',
      'assertion_mismatch',
      'navigation_error',
      'network_error',
      'data_error',
      'environment_error',
      'unknown',
    ]);
    expect(CATEGORIES).toHaveLength(8);
  });

  it('attribution 允许 category + failureCategory(null/枚举) + confidence + evidence', () => {
    expect(
      comparisonAttributionSchema.safeParse({
        category: 'new_failure',
        failureCategory: 'locator_not_found',
        confidence: 'high',
        evidence: ['官方 error.message：...'],
      }).success,
    ).toBe(true);
    expect(
      comparisonAttributionSchema.safeParse({
        category: 'fixed',
        failureCategory: null,
        confidence: 'high',
        evidence: [],
      }).success,
    ).toBe(true);
    expect(
      comparisonAttributionSchema.safeParse({
        category: 'new_failure',
        failureCategory: 'not_a_category',
        confidence: 'high',
        evidence: [],
      }).success,
    ).toBe(false);
  });
});