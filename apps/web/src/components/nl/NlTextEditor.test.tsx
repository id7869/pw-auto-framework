import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NlTextEditor } from './NlTextEditor.tsx';

describe('components/nl/NlTextEditor：业务句子输入', () => {
  it('显示行号/字符数/注释与 {{列}} 提示，不出现动作下拉', () => {
    const output = renderToStaticMarkup(
      <NlTextEditor value={'打开首页\n点击登录\n# 注释'} onChange={() => undefined} columns={['用户名', '期望']} />,
    );
    expect(output).toContain('业务句子');
    expect(output).toContain('1');
    expect(output).toContain('2');
    expect(output).toContain('3');
    expect(output).toContain('3 行');
    expect(output).toContain('注释');
    expect(output).toContain('{{用户名}}');
    expect(output).toContain('{{期望}}');
    expect(output).toContain('不需要选择 goto/click/fill');
    expect(output).not.toContain('<select');
    expect(output).not.toContain('pw-add-step-action');
    expect(output).not.toContain('添加步骤');
  });

  it('无数据集列时不渲染插入按钮，但有基础说明', () => {
    const output = renderToStaticMarkup(<NlTextEditor value={''} onChange={() => undefined} />);
    expect(output).toContain('1 行');
    expect(output).not.toContain('插入数据集列');
    expect(output).not.toContain('<button');
    expect(output).toContain('0/200000 字符');
  });
});