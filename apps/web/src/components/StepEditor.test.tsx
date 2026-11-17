import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Step } from '../api/types.ts';
import { StepEditor } from './StepEditor.tsx';
import { validateSteps } from '../lib/steps.ts';

const steps: Step[] = [
  { id: 'st_1', action: 'goto', url: 'http://127.0.0.1:4174/' },
  { id: 'st_2', action: 'expectVisible', target: { by: 'role', role: 'heading', name: '演示站' } },
  { id: 'st_3', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '你好，自动化' },
];

describe('components/StepEditor（SSR 渲染）', () => {
  it('渲染三个步骤的动作、目标与值', () => {
    const output = renderToStaticMarkup(<StepEditor steps={steps} errors={[]} onChange={() => undefined} />);
    expect(output).toContain('第 1 步 · 打开页面');
    expect(output).toContain('第 2 步 · 断言可见');
    expect(output).toContain('第 3 步 · 断言文本');
    expect(output).toContain('页面地址');
    expect(output).toContain('http://127.0.0.1:4174/');
    expect(output).toContain('定位方式');
    expect(output).toContain('heading');
    expect(output).toContain('演示站');
    expect(output).toContain('你好，自动化');
    expect(output).toContain('添加步骤');
    expect(output).toContain('上移');
    expect(output).toContain('下移');
    expect(output).toContain('删除');
  });

  it('空步骤给出引导文案', () => {
    const output = renderToStaticMarkup(<StepEditor steps={[]} errors={[]} onChange={() => undefined} />);
    expect(output).toContain('还没有步骤');
  });

  it('步骤校验错误就地展示（含第 N 步定位）', () => {
    const invalid: Step[] = [
      { id: 'st_1', action: 'fill', target: { by: 'testId', testId: 'hello' } },
      { id: 'st_2', action: 'goto', url: 'ftp://x' },
    ];
    const errors = validateSteps(invalid);
    const output = renderToStaticMarkup(<StepEditor steps={invalid} errors={errors} onChange={() => undefined} />);
    expect(output).toContain('该步骤需要修正');
    expect(output).toContain('第 1 步：请填写值');
    expect(output).toContain('第 2 步：页面地址必须以 http:// 或 https:// 开头');
  });

  it('必填目标缺失时提示补充，并展示动作说明', () => {
    const output = renderToStaticMarkup(
      <StepEditor steps={[{ id: 'st_1', action: 'click' }]} errors={[]} onChange={() => undefined} />,
    );
    expect(output).toContain('添加目标定位器（必填）');
    expect(output).toContain('官方 locator.click()');
  });

  it('禁用态下按钮与输入不可用', () => {
    const output = renderToStaticMarkup(<StepEditor steps={steps} errors={[]} onChange={() => undefined} disabled />);
    expect(output).toContain('disabled');
    expect(output).toContain('disabled=""');
  });
});