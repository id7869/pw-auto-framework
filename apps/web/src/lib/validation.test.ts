import { describe, expect, it } from 'vitest';
import type { Step } from '../api/types.ts';
import {
  DEFAULT_RUN_OPTIONS,
  errorsFor,
  firstError,
  formatTagsInput,
  parseTagsInput,
  toCaseInput,
  toCasePatchInput,
  toDatasetInput,
  toFieldErrors,
  validateBaselineForm,
  validateCaseForm,
  validateComparisonForm,
  validateDatasetForm,
  validateRunOptions,
  validateSuiteForm,
} from './validation.ts';

const defaultTarget = { by: 'testId' as const, testId: 'hello' };

function step(overrides: Partial<Step> = {}): Step {
  return { id: 'st_1', action: 'click', target: defaultTarget, ...overrides };
}

function validCaseForm(overrides: Partial<Parameters<typeof validateCaseForm>[0]> = {}) {
  return {
    name: '首页用例',
    description: '',
    mode: 'steps' as const,
    steps: [step()],
    code: '',
    tagsText: '',
    status: 'active' as const,
    ...overrides,
  };
}

describe('lib/validation：用例表单', () => {
  it('名称必填且有 200 字符上限', () => {
    expect(validateCaseForm(validCaseForm({ name: '' }))[0]?.message).toBe('请填写用例名称');
    expect(validateCaseForm(validCaseForm({ name: 'x'.repeat(201) }))[0]?.message).toContain('200');
    expect(validateCaseForm(validCaseForm())).toEqual([]);
  });

  it('描述 2000 字符上限', () => {
    expect(validateCaseForm(validCaseForm({ description: 'x'.repeat(2001) }))[0]?.path).toBe('description');
  });

  it('标签数量与长度', () => {
    const many = Array.from({ length: 21 }, (_, index) => `@tag${String(index)}`).join(', ');
    expect(parseTagsInput(many)).toHaveLength(21);
    expect(validateCaseForm(validCaseForm({ tagsText: many }))[0]?.message).toContain('20');
    expect(validateCaseForm(validCaseForm({ tagsText: 'x'.repeat(31) }))[0]?.message).toContain('30');
    expect(parseTagsInput('@fast, 首页，回归\n@fast')).toEqual(['@fast', '首页', '回归']);
    expect(formatTagsInput(['@fast', '首页'])).toBe('@fast, 首页');
  });

  it('代码模式必须填代码且上限 200000', () => {
    expect(validateCaseForm(validCaseForm({ mode: 'code', code: '   ' }))[0]?.message).toContain('原始代码模式');
    expect(validateCaseForm(validCaseForm({ mode: 'code', code: 'x'.repeat(200001) }))[0]?.message).toContain('200000');
    expect(validateCaseForm(validCaseForm({ mode: 'code', code: "test('x', async () => {});" }))).toEqual([]);
  });

  it('步骤模式校验每个步骤', () => {
    const errors = validateCaseForm(validCaseForm({ steps: [{ id: 'st_1', action: 'click' }] }));
    expect(errors.some((error) => error.path === 'steps[0].target')).toBe(true);
  });

  it('toCaseInput 归一化名称/标签/步骤并清空另一模式字段', () => {
    const input = toCaseInput(
      validCaseForm({
        name: '  首页用例  ',
        description: ' 描述 ',
        tagsText: '@fast, @fast, 首页',
        steps: [{ id: 'st_1', action: 'click', target: { by: 'label', text: '用户名', selector: '#x' }, exact: true }],
      }),
    );
    expect(input.name).toBe('首页用例');
    expect(input.description).toBe('描述');
    expect(input.tags).toEqual(['@fast', '首页']);
    expect(input.mode).toBe('steps');
    expect(input.code).toBeNull();
    expect(input.steps?.[0]?.target).toEqual({ by: 'label', text: '用户名' });
  });

  it('toCaseInput 代码模式提交代码、清空步骤', () => {
    const input = toCaseInput(validCaseForm({ mode: 'code', code: "test('x', async () => {});" }));
    expect(input.mode).toBe('code');
    expect(input.code).toBe("test('x', async () => {});");
    expect(input.steps).toEqual([]);
  });

  it('创建请求不含 status（合同 §2.4），PATCH 请求携带 status', () => {
    const createInput = toCaseInput(validCaseForm({ status: 'archived' }));
    expect('status' in createInput).toBe(false);
    expect(createInput.name).toBe('首页用例');
    expect(createInput.description).toBe('');
    expect(createInput.mode).toBe('steps');
    expect(createInput.tags).toEqual([]);
    expect(createInput.steps).toHaveLength(1);
    expect(createInput.code).toBeNull();

    const patchInput = toCasePatchInput(validCaseForm({ status: 'archived' }));
    expect(patchInput.status).toBe('archived');
    expect(patchInput.name).toBe('首页用例');
  });
});

describe('lib/validation：数据集表单', () => {
  const valid = {
    name: '三行数据',
    source: 'json' as const,
    columns: ['名字', '期望'],
    rows: [
      { enabled: true, values: { 名字: '张三', 期望: '你好，张三' } },
      { enabled: false, values: { 名字: '李四', 期望: '你好，李四' } },
    ],
  };

  it('名称 / 列 / 行必填', () => {
    expect(validateDatasetForm({ ...valid, name: '' })[0]?.message).toContain('数据集名称');
    expect(validateDatasetForm({ ...valid, columns: [], rows: [] })[0]?.message).toContain('数据列');
    expect(validateDatasetForm(valid)).toEqual([]);
  });

  it('列名非法、重复与列数上限', () => {
    const duplicate = validateDatasetForm({ ...valid, columns: ['名字', '名字'], rows: [] });
    expect(duplicate.some((error) => error.message.includes('重复'))).toBe(true);
    const invalid = validateDatasetForm({ ...valid, columns: ['{{坏列}}'], rows: [{ enabled: true, values: { '{{坏列}}': '' } }] });
    expect(invalid.some((error) => error.message.includes('不合法'))).toBe(true);
    const tooMany = validateDatasetForm({ ...valid, columns: Array.from({ length: 51 }, (_, index) => `c${String(index)}`), rows: [] });
    expect(tooMany.some((error) => error.message.includes('50'))).toBe(true);
  });

  it('行数上限 500、单元格上限 8192', () => {
    const rows = Array.from({ length: 501 }, () => ({ enabled: true, values: { 名字: 'x', 期望: 'y' } }));
    expect(validateDatasetForm({ ...valid, rows }).some((error) => error.message.includes('500'))).toBe(true);
    const longCell = validateDatasetForm({ ...valid, rows: [{ enabled: true, values: { 名字: 'x'.repeat(8193), 期望: '' } }] });
    expect(longCell.some((error) => error.message.includes('8192'))).toBe(true);
  });

  it('行单元格数量必须与列一致', () => {
    const mismatch = validateDatasetForm({ ...valid, rows: [{ enabled: true, values: { 名字: '张三' } }] });
    expect(mismatch.some((error) => error.message.includes('单元格数量'))).toBe(true);
  });

  it('toDatasetInput 输出合同 rows 形态', () => {
    const input = toDatasetInput(valid, 'json');
    expect(input.name).toBe('三行数据');
    expect(input.source).toBe('json');
    expect(input.rows).toHaveLength(2);
    expect(input.rows[0]).toEqual({ data: { 名字: '张三', 期望: '你好，张三' }, enabled: true });
    expect(input.rows[1]?.enabled).toBe(false);
  });
});

describe('lib/validation：套件 / 运行选项 / 基线 / 对比', () => {
  it('套件必须至少一个用例且不超过 100', () => {
    expect(validateSuiteForm({ name: '回归', description: '', caseIds: [] })[0]?.message).toContain('至少选择');
    expect(validateSuiteForm({ name: '回归', description: '', caseIds: ['case_1', 'case_1'] })[0]?.message).toContain('重复');
    const many = Array.from({ length: 101 }, (_, index) => `case_${String(index)}`);
    expect(validateSuiteForm({ name: '回归', description: '', caseIds: many })[0]?.message).toContain('100');
    expect(validateSuiteForm({ name: '回归', description: '', caseIds: ['case_1'] })).toEqual([]);
  });

  it('运行选项边界（0~5 / 1~4 / 1000~3600000）', () => {
    expect(validateRunOptions(DEFAULT_RUN_OPTIONS)).toEqual([]);
    expect(validateRunOptions({ ...DEFAULT_RUN_OPTIONS, retries: 6 })[0]?.path).toBe('options.retries');
    expect(validateRunOptions({ ...DEFAULT_RUN_OPTIONS, workers: 0 })[0]?.path).toBe('options.workers');
    expect(validateRunOptions({ ...DEFAULT_RUN_OPTIONS, timeoutMs: 999 })[0]?.path).toBe('options.timeoutMs');
    expect(validateRunOptions({ ...DEFAULT_RUN_OPTIONS, trace: 'always' as never })[0]?.path).toBe('options.trace');
    expect(validateRunOptions(DEFAULT_RUN_OPTIONS, 'x'.repeat(201))[0]?.path).toBe('reason');
  });

  it('基线与对比表单', () => {
    expect(
      validateBaselineForm({ scope: 'case', scopeId: 'case_1', runId: 'run_1', name: '基线', note: '', createdBy: 'user' }),
    ).toEqual([]);
    expect(
      validateBaselineForm({ scope: 'case', scopeId: '', runId: '', name: '', note: '', createdBy: 'user' }),
    ).toHaveLength(3);
    expect(validateComparisonForm({ baselineId: '', runId: '' })).toHaveLength(2);
    expect(validateComparisonForm({ baselineId: 'base_1', runId: 'run_1' })).toEqual([]);
  });

  it('错误索引工具', () => {
    const errors = [
      { path: 'name', message: 'a' },
      { path: 'steps[0].target', message: 'b' },
      { path: 'steps[1].value', message: 'c' },
    ];
    expect(errorsFor(errors, 'steps')).toHaveLength(2);
    expect(firstError(errors)?.message).toBe('a');
    expect(toFieldErrors([{ path: 'name', message: 'server' }])).toEqual([{ path: 'name', message: 'server' }]);
    expect(toFieldErrors(undefined)).toEqual([]);
  });
});