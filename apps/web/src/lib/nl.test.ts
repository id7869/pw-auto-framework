import { describe, expect, it } from 'vitest';
import type { Case, NlGeneration, NlSource, StepOrigin } from '../api/types.ts';
import {
  caseStepSources,
  formatNlLines,
  generatedStepSources,
  insertNlVariable,
  isGenerationActive,
  isGenerationStale,
  nlLineText,
  nlLinesFromStepOrigin,
  nlRunBlockReason,
  parseGeneratedSteps,
  splitNlLines,
} from './nl.ts';

function source(overrides: Partial<NlSource> = {}): NlSource {
  return {
    text: '打开 https://demo.example.com/\n点击「登录」\n应该看到「欢迎」',
    status: 'generated',
    sourceHash: 'ab12cd34ef56ab12',
    origin: 'agent',
    generatorVersion: 'skill/1.0.0',
    warnings: [],
    lines: [
      { line: 1, text: '打开 https://demo.example.com/', kind: 'instruction', stepId: 's1' },
      { line: 2, text: '点击「登录」', kind: 'step', stepId: 's2' },
      { line: 3, text: '应该看到「欢迎」', kind: 'step', stepId: 's3' },
    ],
    updatedAt: '2026-11-12T02:00:00.000Z',
    generatedAt: '2026-11-12T02:10:00.000Z',
    ...overrides,
  };
}

function generation(overrides: Partial<NlGeneration> = {}): NlGeneration {
  return {
    id: 'nlg_1',
    caseId: 'case_1',
    generator: 'agent',
    status: 'ready',
    sourceHash: 'ab12cd34ef56ab12',
    origin: 'agent',
    generatorVersion: 'skill/1.0.0',
    leaseId: null,
    leaseExpiresAt: null,
    leaseAttempts: 1,
    fallback: false,
    caseName: '登录',
    nlText: '打开 https://demo.example.com/\n点击「登录」\n应该看到「欢迎」',
    datasetColumns: [],
    stepOrigin: { s2: { nlLine: 2 }, s3: { nlLine: 3 } },
    steps: [
      { id: 's2', action: 'click', target: { by: 'role', role: 'button', name: '登录' } },
      { id: 's3', action: 'expectText', target: { by: 'css', selector: 'h1' }, value: '欢迎' },
    ],
    code: null,
    warnings: [],
    error: null,
    submittedAt: '2026-11-12T02:09:00.000Z',
    acceptedAt: null,
    rejectedAt: null,
    failedAt: null,
    createdAt: '2026-11-12T02:08:00.000Z',
    updatedAt: '2026-11-12T02:09:00.000Z',
    ...overrides,
  };
}

describe('lib/nl：行号、变量与状态', () => {
  it('splitNlLines 保留空行，行号与文本一一对应', () => {
    expect(splitNlLines('a\n\nc')).toEqual(['a', '', 'c']);
    expect(splitNlLines('').length).toBe(1);
  });

  it('insertNlVariable 在光标处插入并替换选区', () => {
    expect(insertNlVariable('hello', 5, 5, '用户名')).toEqual({ text: 'hello{{用户名}}', cursor: 12 });
    expect(insertNlVariable('hello world', 6, 11, '期望')).toEqual({ text: 'hello {{期望}}', cursor: 12 });
    expect(insertNlVariable('abc', 99, 99, 'x')).toEqual({ text: 'abc{{x}}', cursor: 8 });
  });

  it('stepOrigin → 唯一升序 NL 行', () => {
    const origin: StepOrigin = { s1: { nlLine: 3 }, s2: { nlLine: 1 }, s3: { nlLine: 3 } };
    expect(nlLinesFromStepOrigin(origin)).toEqual([1, 3]);
    expect(nlLinesFromStepOrigin(null)).toEqual([]);
    expect(formatNlLines([2, 5])).toBe('第 2、5 行');
    expect(formatNlLines([])).toBe('—');
  });

  it('nlLineText 找不到行时为空串', () => {
    expect(nlLineText(source(), 2)).toBe('点击「登录」');
    expect(nlLineText(source(), 99)).toBe('');
    expect(nlLineText(null, 1)).toBe('');
  });

  it('生成结果步骤解析只保留合法 action，避免伪造/崩溃', () => {
    expect(parseGeneratedSteps(null)).toEqual([]);
    expect(parseGeneratedSteps([{ id: 's1', action: 'not-real' }, { id: 's2', action: 'goto', url: 'https://x' }, 'bad'])).toHaveLength(1);
  });

  it('generatedStepSources 带来源行与原文（未映射为 null）', () => {
    const rows = generatedStepSources(generation());
    expect(rows[0]?.line).toBe(2);
    expect(rows[0]?.text).toBe('点击「登录」');
    expect(rows[1]?.line).toBe(3);
    const noMap = generatedStepSources(generation({ stepOrigin: {} }));
    expect(noMap[0]?.line).toBeNull();
    expect(noMap[0]?.text).toBeNull();
  });

  it('caseStepSources 使用用例 steps + stepOrigin；旧用例无 NL 时仍可展示步骤', () => {
    const caseItem: Case = {
      id: 'case_1',
      name: '登录',
      description: '',
      mode: 'steps',
      steps: [{ id: 's1', action: 'goto', url: 'https://x' }],
      code: null,
      tags: [],
      status: 'active',
      version: 1,
      createdAt: '2026-11-12T02:00:00.000Z',
      updatedAt: '2026-11-12T02:00:00.000Z',
      deletedAt: null,
      nl: source(),
      stepOrigin: { s1: { nlLine: 1 } },
    };
    expect(caseStepSources(caseItem)[0]).toMatchObject({ line: 1, text: '打开 https://demo.example.com/' });
    expect(caseStepSources({ ...caseItem, stepOrigin: null })[0]?.line).toBeNull();
  });

  it('生成任务 stale 判定与运行门禁', () => {
    expect(isGenerationStale(generation(), source())).toBe(false);
    expect(isGenerationStale(generation({ sourceHash: 'ffffffffffffffff' }), source())).toBe(true);
    expect(isGenerationStale(generation(), null)).toBe(true);
    expect(isGenerationActive('queued')).toBe(true);
    expect(isGenerationActive('ready')).toBe(false);
    expect(nlRunBlockReason(null)).toContain('没有 NL');
    expect(nlRunBlockReason(source({ status: 'draft' }))).toContain('尚未生成');
    expect(nlRunBlockReason(source({ status: 'generating' }))).toContain('正在生成');
    expect(nlRunBlockReason(source({ status: 'invalid' }))).toContain('无效');
    expect(nlRunBlockReason(source({ status: 'stale' }))).toContain('allowStaleNl');
    expect(nlRunBlockReason(source({ status: 'generated' }))).toBeNull();
  });
});