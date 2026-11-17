import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import {
  Card,
  ChangePill,
  CheckboxField,
  CodeText,
  ConfirmButton,
  CopyButton,
  EmptyState,
  ErrorState,
  KeyValueList,
  LoadingState,
  Notice,
  OutcomePill,
  PlainText,
  SelectField,
  StatusPill,
  TagList,
  TextField,
  VerdictPill,
} from './ui.tsx';

function html(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

describe('components/ui：四态与徽标（SSR 渲染）', () => {
  it('LoadingState 有 role=status 与中文文案', () => {
    const output = html(<LoadingState label="正在加载用例…" />);
    expect(output).toContain('role="status"');
    expect(output).toContain('正在加载用例…');
    expect(output).toContain('spinner');
  });

  it('EmptyState 展示标题、说明与动作', () => {
    const output = html(
      <EmptyState title="还没有测试用例" description="新建一个用例" action={<a href="#/cases/new">新建用例</a>} />,
    );
    expect(output).toContain('还没有测试用例');
    expect(output).toContain('新建一个用例');
    expect(output).toContain('href="#/cases/new"');
  });

  it('ErrorState 展示错误信封（code/message/details/requestId）与重试', () => {
    const output = html(
      <ErrorState
        error={{
          code: 'INVALID_STEP',
          message: '第 2 步缺少 target',
          details: [{ path: 'steps[1].target', message: '必填' }],
          requestId: 'req_1',
          httpStatus: 422,
        }}
        onRetry={() => undefined}
      />,
    );
    expect(output).toContain('role="alert"');
    expect(output).toContain('第 2 步缺少 target');
    expect(output).toContain('INVALID_STEP');
    expect(output).toContain('req_1');
    expect(output).toContain('steps[1].target');
    expect(output).toContain('重试');
    expect(output).toContain('HTTP 422');
  });

  it('错误信封无重试时不渲染重试按钮', () => {
    const output = html(<ErrorState error={{ code: 'NOT_FOUND', message: '用例不存在或已删除' }} />);
    expect(output).not.toContain('重试');
    expect(output).toContain('用例不存在或已删除');
  });

  it('运行状态 / 结果 / 差异 / 结论徽标', () => {
    expect(html(<StatusPill status="queued" />)).toContain('排队中');
    expect(html(<StatusPill status="passed" />)).toContain('通过');
    expect(html(<StatusPill status="weird" />)).toContain('未知状态');
    expect(html(<OutcomePill outcome="flaky" />)).toContain('偶发失败（重试通过）');
    expect(html(<ChangePill change="newly_failed" />)).toContain('新增失败');
    expect(html(<VerdictPill verdict="regression" />)).toContain('回归');
  });

  it('Notice 的语义角色：警示为 alert、信息为 status', () => {
    expect(html(<Notice tone="warning" title="注意">内容</Notice>)).toContain('role="alert"');
    expect(html(<Notice tone="info" title="说明">内容</Notice>)).toContain('role="status"');
  });

  it('Card 使用 aria-labelledby 关联标题', () => {
    const output = html(
      <Card title="基本信息" description="说明">
        <p>内容</p>
      </Card>,
    );
    expect(output).toContain('aria-labelledby=');
    expect(output).toContain('基本信息');
    expect(output).toContain('内容');
  });

  it('KeyValueList 渲染为 dl 且带 aria-label', () => {
    const output = html(<KeyValueList ariaLabel="版本信息" items={[{ label: 'Playwright', value: '1.65.0' }]} />);
    expect(output).toContain('<dl');
    expect(output).toContain('aria-label="版本信息"');
    expect(output).toContain('<dt>Playwright</dt>');
    expect(output).toContain('1.65.0');
  });

  it('TagList 空数组兜底为占位符', () => {
    expect(html(<TagList tags={[]} />)).toContain('—');
    expect(html(<TagList tags={['@fast', '首页']} />)).toContain('@fast');
  });
});

describe('components/ui：表单字段（label 关联与校验提示）', () => {
  it('TextField 关联 label、必填标记、提示与错误', () => {
    const output = html(
      <TextField
        id="case-name"
        label="用例名称"
        value="首页用例"
        onChange={() => undefined}
        required
        hint="1~200 字符"
        error="请填写用例名称"
      />,
    );
    expect(output).toContain('for="case-name"');
    expect(output).toContain('id="case-name"');
    expect(output).toContain('（必填）');
    expect(output).toContain('aria-invalid="true"');
    expect(output).toContain('aria-describedby="case-name-hint case-name-error"');
    expect(output).toContain('1~200 字符');
    expect(output).toContain('role="alert"');
    expect(output).toContain('请填写用例名称');
  });

  it('字段级提示/错误同样剥离 ANSI（后端 details 映射）', () => {
    const output = html(
      <TextField
        id="field-ansi"
        label="字段"
        value=""
        onChange={() => undefined}
        hint={'\u001b[2m提示\u001b[0m'}
        error={'\u001b[31m该字段必填\u001b[0m'}
      />,
    );
    expect(output).not.toContain('\u001b');
    expect(output).toContain('提示');
    expect(output).toContain('该字段必填');
  });

  it('SelectField 空选项与禁用选项', () => {
    const output = html(
      <SelectField
        id="mode"
        label="编辑模式"
        value="steps"
        options={[
          { value: 'steps', label: '结构化步骤' },
          { value: 'code', label: '原始 Test 代码', disabled: true },
        ]}
        onChange={() => undefined}
        emptyLabel="请选择"
      />,
    );
    expect(output).toContain('<option value="">请选择</option>');
    expect(output).toContain('结构化步骤');
    expect(output).toContain('disabled');
  });

  it('CheckboxField 渲染勾选态与说明', () => {
    const output = html(
      <CheckboxField id="confirm" label="已确认" checked onChange={() => undefined} hint="会写入文件" />,
    );
    expect(output).toContain('type="checkbox"');
    expect(output).toContain('checked');
    expect(output).toContain('已确认');
    expect(output).toContain('会写入文件');
  });

  it('ConfirmButton 初始只显示入口按钮（不直接执行）', () => {
    const output = html(<ConfirmButton label="删除" onConfirm={() => undefined} />);
    expect(output).toContain('删除');
    expect(output).not.toContain('确认删除');
  });

  it('CopyButton 有可复制的按钮与状态区域', () => {
    const output = html(<CopyButton text="npx playwright test" label="复制命令" />);
    expect(output).toContain('复制命令');
    expect(output).toContain('aria-live="polite"');
  });

  it('ErrorState 展示前剥离 ANSI（message 与 details）', () => {
    const output = html(
      <ErrorState
        error={{
          code: 'ENGINE_ERROR',
          message: '\u001b[31m引擎错误：断言失败\u001b[0m',
          details: [{ path: 'steps[1]', message: '\u001b[33m字段缺少 target\u001b[0m' }],
        }}
      />,
    );
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0007');
    expect(output).toContain('引擎错误：断言失败');
    expect(output).toContain('字段缺少 target');
  });

  it('Notice 的直接文本节点统一剥离 ANSI（后端错误提示）', () => {
    const output = html(
      <Notice tone="danger" title="操作失败">
        {'\u001b[31m保存失败：版本冲突\u001b[0m'}（错误码：VERSION_CONFLICT）
      </Notice>,
    );
    expect(output).not.toContain('\u001b');
    expect(output).toContain('保存失败：版本冲突');
  });

  it('CodeText 与 PlainText 展示时剥离 ANSI，保留可读文本', () => {
    const code = html(<CodeText>{'\u001b[32mstdout line\u001b[0m\n\u001b[31merr line\u001b[0m'}</CodeText>);
    expect(code).not.toContain('\u001b');
    expect(code).toContain('stdout line');
    expect(code).toContain('err line');
    expect(code.split('\n')).toHaveLength(2);

    const plain = html(<PlainText text={'\u001b[1m普通文本\u001b[0m'} />);
    expect(plain).toBe('普通文本');
  });
});