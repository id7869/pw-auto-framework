import { describe, expect, it } from 'vitest';
import {
  NAV_ITEMS,
  buildHref,
  hrefForCase,
  hrefForComparison,
  hrefForDatasets,
  hrefForRun,
  hrefForSuites,
  navItemFor,
  parseRoute,
  routeTitle,
} from './hash-router.ts';

describe('lib/hash-router：解析固定路由表（架构 §6）', () => {
  it('空 hash 与根路径回到用例页', () => {
    expect(parseRoute('')).toEqual({ name: 'cases', query: {} });
    expect(parseRoute('#/')).toEqual({ name: 'cases', query: {} });
    expect(parseRoute('/cases')).toEqual({ name: 'cases', query: {} });
  });

  it('九个页面路由', () => {
    expect(parseRoute('#/cases').name).toBe('cases');
    expect(parseRoute('#/cases/new')).toEqual({ name: 'case-new', query: {} });
    expect(parseRoute('#/cases/case_1/edit')).toEqual({ name: 'case-edit', caseId: 'case_1', query: {} });
    expect(parseRoute('#/datasets')).toEqual({ name: 'datasets', query: {} });
    expect(parseRoute('#/suites')).toEqual({ name: 'suites', query: {} });
    expect(parseRoute('#/runs').name).toBe('runs');
    expect(parseRoute('#/runs/run_1')).toEqual({ name: 'run-detail', runId: 'run_1', query: {} });
    expect(parseRoute('#/regression').name).toBe('regression');
    expect(parseRoute('#/agents').name).toBe('agents');
    expect(parseRoute('#/health').name).toBe('health');
  });

  it('查询参数与编码 id', () => {
    const datasets = parseRoute('#/datasets?caseId=case_1&datasetId=ds_1');
    expect(datasets).toMatchObject({ name: 'datasets', caseId: 'case_1', datasetId: 'ds_1' });
    const runDetail = parseRoute('#/runs/run%231');
    expect(runDetail.name === 'run-detail' && runDetail.runId).toBe('run#1');
    const regression = parseRoute('#/regression?comparisonId=cmp_1');
    expect(regression.name === 'regression' && regression.comparisonId).toBe('cmp_1');
    const runs = parseRoute('#/runs?status=failed');
    expect(runs.name === 'runs' && runs.status).toBe('failed');
  });

  it('尾斜杠与未知路由', () => {
    expect(parseRoute('#/cases/').name).toBe('cases');
    expect(parseRoute('#/cases/case_1')).toEqual({ name: 'not-found', path: '/cases/case_1', query: {} });
    expect(parseRoute('#/wat').name).toBe('not-found');
  });

  it('中文标签与导航归属', () => {
    expect(routeTitle(parseRoute('#/cases/new'))).toBe('新建用例');
    expect(navItemFor(parseRoute('#/cases/case_1/edit'))?.path).toBe('/cases');
    expect(navItemFor(parseRoute('#/runs/run_1'))?.path).toBe('/runs');
    expect(navItemFor(parseRoute('#/regression'))?.path).toBe('/regression');
    expect(NAV_ITEMS).toHaveLength(7);
  });

  it('buildHref 编码并跳过空值', () => {
    expect(buildHref('/cases')).toBe('#/cases');
    expect(buildHref('/datasets', { caseId: 'case_1', datasetId: undefined })).toBe('#/datasets?caseId=case_1');
    expect(buildHref('/regression', { comparisonId: 'cmp 1' })).toBe('#/regression?comparisonId=cmp+1');
    expect(buildHref('cases')).toBe('#/cases');
    expect(hrefForCase('case_1')).toBe('#/cases/case_1/edit');
    expect(hrefForRun('run_1')).toBe('#/runs/run_1');
    expect(hrefForDatasets('case_1', 'ds_1')).toBe('#/datasets?caseId=case_1&datasetId=ds_1');
    expect(hrefForSuites('suite_1')).toBe('#/suites?suiteId=suite_1');
    expect(hrefForComparison('cmp_1')).toBe('#/regression?comparisonId=cmp_1');
  });
});