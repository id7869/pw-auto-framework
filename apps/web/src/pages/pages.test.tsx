import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { ApiProvider } from '../api/context.tsx';
import { Api } from '../api/endpoints.ts';
import { ApiClient } from '../api/http.ts';
import { App } from '../app.tsx';
import { CasesPage } from './CasesPage.tsx';
import { CaseEditorPage } from './CaseEditorPage.tsx';
import { DatasetsPage } from './DatasetsPage.tsx';
import { SuitesPage } from './SuitesPage.tsx';
import { RunsPage } from './RunsPage.tsx';
import { RunDetailPage } from './RunDetailPage.tsx';
import { RegressionPage } from './RegressionPage.tsx';
import { AgentsPage } from './AgentsPage.tsx';
import { HealthPage } from './HealthPage.tsx';

const api = new Api(
  new ApiClient({
    fetchImpl: (async () =>
      new Response(JSON.stringify({ data: { items: [], nextCursor: null, hasMore: false } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch,
    getRetries: 0,
    sleep: async () => undefined,
  }),
);

function renderPage(node: ReactElement): string {
  return renderToStaticMarkup(<ApiProvider api={api}>{node}</ApiProvider>);
}

describe('pages：九个页面 SSR 初始渲染（加载/空态）', () => {
  it('用例列表：标题、新建入口、筛选与加载态', () => {
    const output = renderPage(<CasesPage />);
    expect(output).toContain('测试用例');
    expect(output).toContain('新建用例');
    expect(output).toContain('搜索与筛选');
    expect(output).toContain('正在加载用例…');
  });

  it('用例编辑器：新建默认 NL 业务模式，不渲染动作下拉', () => {
    const output = renderPage(<CaseEditorPage />);
    expect(output).toContain('新建自然语言用例');
    expect(output).toContain('业务句子');
    expect(output).toContain('业务（NL）');
    expect(output).toContain('步骤（只读）');
    expect(output).toContain('代码（只读）');
    expect(output).toContain('用例名称');
    expect(output).toContain('版本信息');
    expect(output).toContain('编译校验');
    // 普通用户只看到业务句子输入；结构化 StepEditor 的动作下拉不得渲染
    expect(output).not.toContain('pw-add-step-action');
    expect(output).not.toContain('添加步骤');
    expect(output).not.toContain('保存草稿');
  });

  it('数据集页：选择用例与加载态', () => {
    const output = renderPage(<DatasetsPage />);
    expect(output).toContain('数据集');
    expect(output).toContain('选择用例');
    expect(output).toContain('正在加载用例列表…');
  });

  it('套件页：新建与加载态', () => {
    const output = renderPage(<SuitesPage />);
    expect(output).toContain('套件');
    expect(output).toContain('新建套件');
    expect(output).toContain('正在加载套件…');
  });

  it('运行列表：筛选、新建运行、加载态', () => {
    const output = renderPage(<RunsPage />);
    expect(output).toContain('运行记录');
    expect(output).toContain('新建运行');
    expect(output).toContain('正在加载运行记录…');
    expect(output).toContain('运行历史');
  });

  it('运行详情：缺少 runId 时给出明确提示', () => {
    const output = renderPage(<RunDetailPage />);
    expect(output).toContain('缺少运行 ID');
  });

  it('回归页：基线、对比与手工创建基线', () => {
    const output = renderPage(<RegressionPage />);
    expect(output).toContain('回归对比');
    expect(output).toContain('创建对比');
    expect(output).toContain('手工创建基线');
    expect(output).toContain('基线');
  });

  it('Agent 交接页：三 harness 入口、skill 放置与非安装边界', () => {
    const output = renderPage(<AgentsPage />);
    expect(output).toContain('Agent 交接');
    expect(output).toContain('三 harness 入口');
    expect(output).toContain('Skill 使用');
    expect(output).toContain('skills/pw-auto-test');
    expect(output).toContain('MCP 会话');
    expect(output).toContain('CLI 命令面板');
    expect(output).toContain('不内置任何模型');
    expect(output).toContain('外部 coding agent');
    // 旧 6 loop 入口/安装按钮不得出现在 Agent 页
    expect(output).not.toContain('Agentic loop');
    expect(output).not.toContain('6 个官方值');
    expect(output).not.toContain('scaffold-loop');
    expect(output).not.toContain('copilot');
    expect(output).not.toContain('opencode');
    expect(output).not.toContain('vscode');
    expect(output).not.toMatch(/<button[^>]*>[^<]*安装/u);
    // 不得出现官方不支持的“一键”式 AI 承诺（用拼接避免源码中出现该字样）
    const fakePromise = new RegExp(['一键', 'AI'].join('\\s*'), 'u');
    expect(output).not.toMatch(fakePromise);
  });

  it('健康页：连接状态、版本元信息与安全边界', () => {
    const output = renderPage(<HealthPage />);
    expect(output).toContain('API 连接状态');
    expect(output).toContain('正在检查后端连接…');
    expect(output).toContain('官方版本与运行环境');
    expect(output).toContain('安全与数据边界');
    expect(output).toContain('不显示密钥');
  });

  it('应用外壳：七个导航、跳转链接与官方依据页脚', () => {
    const output = renderToStaticMarkup(
      <ApiProvider api={api}>
        <App />
      </ApiProvider>,
    );
    for (const label of ['测试用例', '数据集', '套件', '运行记录', '回归对比', 'Agent 交接', '设置与健康']) {
      expect(output).toContain(label);
    }
    expect(output).toContain('跳到主内容');
    expect(output).toContain('https://playwright.dev/docs/test-agents');
    expect(output).toContain('不内置模型');
    expect(output).toContain('aria-label="主导航"');
  });
});