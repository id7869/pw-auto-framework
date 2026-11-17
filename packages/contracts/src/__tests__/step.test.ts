import { describe, expect, it } from 'vitest';
import {
  collectStepVariables,
  extractVariables,
  splitStepIssues,
  stepSchema,
  validateStepColumns,
  validateSteps,
  type Step,
} from '../index.ts';

function step(partial: Partial<Step> & { id: string; action: Step['action'] }): Step {
  return stepSchema.parse(partial);
}

describe('contracts/step 变量提取', () => {
  it('提取 {{列名}} 并去重', () => {
    expect(extractVariables('{{a}}/{{ b }}/{{a}}')).toEqual(['a', 'b']);
    expect(extractVariables('无变量')).toEqual([]);
    expect(extractVariables(undefined)).toEqual([]);
  });

  it('收集步骤内所有字段的变量（含 target 文本）', () => {
    const value = step({
      id: 'st_1',
      action: 'fill',
      target: { by: 'label', text: '{{labelText}}' },
      value: '{{name}}',
    });
    expect(collectStepVariables(value)).toEqual(['name', 'labelText']);
  });
});

describe('contracts/step 语义校验', () => {
  it('合法步骤不报错', () => {
    const issues = validateSteps([
      step({ id: 'st_1', action: 'goto', url: 'http://127.0.0.1:4174/' }),
      step({ id: 'st_2', action: 'click', target: { by: 'role', role: 'button', name: '提交' } }),
      step({ id: 'st_3', action: 'expectVisible', target: { by: 'text', text: '成功' } }),
    ]);
    expect(issues).toEqual([]);
  });

  it('goto 缺 url / 非 http(s) 协议 → INVALID_STEP', () => {
    const missing = validateSteps([step({ id: 'st_1', action: 'goto' })]);
    expect(missing.map((issue) => issue.code)).toEqual(['INVALID_STEP']);
    const fileUrl = validateSteps([step({ id: 'st_1', action: 'goto', url: 'file:///etc/passwd' })]);
    expect(fileUrl[0]?.message).toContain('http/https');
  });

  it('含变量的 URL 不做协议预判（运行时按行值校验）', () => {
    const issues = validateSteps([step({ id: 'st_1', action: 'goto', url: '{{baseUrl}}/list' })]);
    expect(issues.filter((issue) => issue.code === 'INVALID_STEP')).toEqual([]);
  });

  it('fill 缺 target 与 value 各报一条', () => {
    const issues = validateSteps([step({ id: 'st_1', action: 'fill' })]);
    expect(issues.map((issue) => issue.path)).toEqual(['steps[0].target', 'steps[0].value']);
  });

  it('press 只需 key，target 可选', () => {
    expect(validateSteps([step({ id: 'st_1', action: 'press', key: 'Enter' })]).filter((i) => i.code === 'INVALID_STEP')).toEqual([]);
    expect(validateSteps([step({ id: 'st_1', action: 'press' })])[0]?.code).toBe('INVALID_STEP');
  });

  it('setViewport 缺宽高 → INVALID_STEP', () => {
    const issues = validateSteps([step({ id: 'st_1', action: 'setViewport', width: 800 })]);
    expect(issues[0]?.code).toBe('INVALID_STEP');
  });

  it('css 兜底定位只产生 CSS_SELECTOR 警告', () => {
    const issues = validateSteps([step({ id: 'st_1', action: 'click', target: { by: 'css', selector: '#submit' } })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('CSS_SELECTOR');
    const split = splitStepIssues(issues);
    expect(split.errors).toEqual([]);
    expect(split.warnings).toHaveLength(1);
  });

  it('重复步骤 id → INVALID_STEP', () => {
    const issues = validateSteps([
      step({ id: 'st_1', action: 'goto', url: 'http://127.0.0.1:1/' }),
      step({ id: 'st_1', action: 'screenshot' }),
    ]);
    expect(issues.some((issue) => issue.code === 'INVALID_STEP' && issue.path === 'steps[1].id')).toBe(true);
  });

  it('引用不存在的数据列 → UNKNOWN_COLUMN', () => {
    const issues = validateStepColumns(
      [step({ id: 'st_1', action: 'fill', target: { by: 'label', text: '名称' }, value: '{{name}}' })],
      ['title'],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('UNKNOWN_COLUMN');
    expect(issues[0]?.message).toContain('name');
  });

  it('引用存在的数据列不报错', () => {
    const issues = validateStepColumns(
      [step({ id: 'st_1', action: 'fill', target: { by: 'label', text: '名称' }, value: '{{name}}' })],
      ['name'],
    );
    expect(issues).toEqual([]);
  });

  it('未知动作被 schema 拒绝（不虚构官方 API 之外的语义）', () => {
    expect(stepSchema.safeParse({ id: 'st_1', action: 'scroll' }).success).toBe(false);
  });
});