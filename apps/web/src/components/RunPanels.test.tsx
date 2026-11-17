import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Artifact, Run, RunItem, RunItemAttempt } from '../api/types.ts';
import {
  ArtifactsTable,
  AttemptCard,
  DiagnosticsPanel,
  FlakyNotice,
  RunEnvironmentPanel,
  RunErrorNotice,
  RunItemsTable,
  RunMetaPanel,
  RunStatsGrid,
} from './RunPanels.tsx';

const run: Run = {
  id: 'run_1234567890abcdef',
  kind: 'case',
  caseId: 'case_1',
  suiteId: null,
  datasetId: 'ds_1',
  options: {
    retries: 1,
    workers: 1,
    timeoutMs: 60000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    headed: false,
    browser: 'chromium',
    failOnFlaky: false,
  },
  status: 'failed',
  queuePosition: null,
  requestedAt: '2026-11-11T02:00:00.000Z',
  startedAt: '2026-11-11T02:00:01.000Z',
  finishedAt: '2026-11-11T02:00:04.000Z',
  cancelRequestedAt: null,
  exitCode: 1,
  stats: { expected: 2, unexpected: 1, flaky: 1, skipped: 0, durationMs: 3000 },
  itemsCount: 3,
  artifactsCount: 1,
  environment: { node: '24.22.1', playwright: '1.65.0', browser: 'chromium-1254', os: 'win32 x64', timezone: 'Asia/Shanghai' },
  error: { code: 'RUN_TIMEOUT', message: '运行级超时' },
  diagnostics: {
    playwrightCliPath: 'C:\\repo\\node_modules\\@playwright\\test\\cli.js',
    command: ['node', 'playwright', 'test', 'specs/case_1.spec.ts', '--reporter=json'],
    specPath: 'C:\\repo\\.data\\runs\\run_1\\specs\\case_1.spec.ts',
    reportPath: 'C:\\repo\\.data\\runs\\run_1\\report.json',
    workspaceDir: 'C:\\repo\\.data\\runs\\run_1',
    warnings: ['步骤 2 使用了 css 兜底定位'],
  },
  idempotencyKey: null,
};

const item: RunItem = {
  itemKey: 'case_1#row:1',
  caseId: 'case_1',
  rowIndex: 1,
  title: '首页问候 [row:1]',
  projectName: 'chromium',
  outcome: 'unexpected',
  durationMs: 1500,
  attempts: [
    {
      attempt: 0,
      status: 'failed',
      durationMs: 1500,
      startTime: '2026-11-11T02:00:02.000Z',
      error: {
        message: 'expect(locator).toHaveText: 断言不匹配',
        stack: 'Error: expect(...)\n  at spec.ts:12:3',
        snippet: 'await expect(locator).toHaveText("错误文本")',
        location: { file: 'case_1.spec.ts', line: 12, column: 3 },
      },
      errorHash: 'abc123hash',
      steps: [{ title: '步骤 3/3：断言文本', durationMs: 100, error: '断言失败' }],
      attachments: [{ name: 'trace.zip', contentType: 'application/zip', artifactId: 'art_1' }],
      stdout: 'console log',
      stderr: '',
      truncated: false,
    },
  ],
};

const artifact: Artifact = {
  id: 'art_1',
  runId: run.id,
  itemKey: 'case_1#row:1',
  kind: 'trace',
  fileName: 'trace.zip',
  sizeBytes: 2048,
  sha256: 'abcdef0123456789',
  contentType: 'application/zip',
  createdAt: '2026-11-11T02:00:04.000Z',
};

describe('components/RunPanels（SSR 渲染）', () => {
  it('统计网格展示通过/失败/flaky/跳过/耗时/退出码', () => {
    const output = renderToStaticMarkup(<RunStatsGrid stats={run.stats} exitCode={run.exitCode} />);
    expect(output).toContain('通过（expected）');
    expect(output).toContain('失败（unexpected）');
    expect(output).toContain('偶发（flaky）');
    expect(output).toContain('3 秒');
    expect(output).toContain('<dd>2</dd>');
  });

  it('产物表展示官方产物与内容链接', () => {
    const output = renderToStaticMarkup(
      <ArtifactsTable artifacts={[artifact]} contentUrl={(item) => `/api/v1/runs/${run.id}/artifacts/${item.id}/content`} />,
    );
    expect(output).toContain('Trace（官方追踪）');
    expect(output).toContain('trace.zip');
    expect(output).toContain('2 KB');
    expect(output).toContain('/api/v1/runs/run_1234567890abcdef/artifacts/art_1/content');
  });

  it('无产物时为空态', () => {
    const output = renderToStaticMarkup(<ArtifactsTable artifacts={[]} contentUrl={() => '#'} />);
    expect(output).toContain('暂无产物');
  });

  it('逐项结果展示 itemKey、行号、状态、错误摘要与展开按钮', () => {
    const output = renderToStaticMarkup(
      <RunItemsTable
        items={[item]}
        artifacts={[artifact]}
        contentUrl={(artifactItem) => `/content/${artifactItem.id}`}
      />,
    );
    expect(output).toContain('case_1#row:1');
    expect(output).toContain('首页问候 [row:1]');
    expect(output).toContain('第 1 行');
    expect(output).toContain('失败');
    expect(output).toContain('断言不匹配');
    expect(output).toContain('展开');
    expect(output).toContain('aria-expanded="false"');
  });

  it('逐行结果回标 NL 行并提供 trace/截图证据链接', () => {
    const output = renderToStaticMarkup(
      <RunItemsTable
        items={[item]}
        artifacts={[artifact]}
        nlLines={[2, 3]}
        contentUrl={(artifactItem) => `/content/${artifactItem.id}`}
      />,
    );
    expect(output).toContain('NL 行');
    expect(output).toContain('第 2、3 行');
    expect(output).toContain('证据');
    expect(output).toContain('/content/art_1');
    expect(output).toContain('trace');
  });

  it('无逐项结果时为空态', () => {
    const output = renderToStaticMarkup(<RunItemsTable items={[]} artifacts={[]} contentUrl={() => '#'} />);
    expect(output).toContain('暂无逐项结果');
  });

  it('诊断面板回显官方命令与路径，并提供复制', () => {
    const output = renderToStaticMarkup(<DiagnosticsPanel run={run} />);
    expect(output).toContain('诊断与复现');
    expect(output).toContain('playwright test');
    expect(output).toContain('specs/case_1.spec.ts');
    expect(output).toContain('report.json');
    expect(output).toContain('复制命令');
    expect(output).toContain('步骤 2 使用了 css 兜底定位');
  });

  it('环境与参数面板展示官方版本与运行选项', () => {
    const output = renderToStaticMarkup(<RunEnvironmentPanel run={run} />);
    expect(output).toContain('24.22.1');
    expect(output).toContain('1.65.0');
    expect(output).toContain('Asia/Shanghai');
    expect(output).toContain('retain-on-failure');
  });

  it('flaky 告警条与运行级错误提示', () => {
    expect(renderToStaticMarkup(<FlakyNotice run={run} />)).toContain('flaky');
    expect(renderToStaticMarkup(<RunErrorNotice run={run} />)).toContain('RUN_TIMEOUT');
    const healthy = { ...run, status: 'passed' as const, error: null, stats: { ...run.stats, flaky: 0, unexpected: 0 } };
    expect(renderToStaticMarkup(<FlakyNotice run={healthy} />)).toBe('');
    expect(renderToStaticMarkup(<RunErrorNotice run={healthy} />)).toBe('');
  });

  it('运行元信息展示 id/状态归属/时间与固定链接', () => {
    const output = renderToStaticMarkup(<RunMetaPanel run={run} />);
    expect(output).toContain('run_1234567890abcdef');
    expect(output).toContain('用例');
    expect(output).toContain('数据集 ID');
    expect(output).toContain('ds_1');
    expect(output).toContain('#/runs/run_1234567890abcdef');
  });

  it('attempt 详情剥离 ANSI（message/stack/snippet/stdout/stderr），原始值可复制', () => {
    const firstAttempt = item.attempts[0]!;
    const ansiAttempt: RunItemAttempt = {
      ...firstAttempt,
      error: {
        message: '\u001b[1m\u001b[31mexpect(locator).toHaveText: 断言不匹配\u001b[0m\n\u001b[2mExpected:\u001b[0m \u001b[32m"你好"\u001b[0m',
        stack: '\u001b[31mError: expect(...)\u001b[0m\n  at case_1.spec.ts:12:3',
        snippet: '\u001b[33mawait expect(locator).toHaveText("错误文本")\u001b[0m',
        location: { file: 'case_1.spec.ts', line: 12, column: 3 },
      },
      stdout: '\u001b[32mconsole log line\u001b[0m',
      stderr: '\u001b[31mstderr line\u001b[0m',
    };
    // 原始数据保留 ANSI（不篡改接口/产物），仅展示层剥离（F3 回归点）
    expect(ansiAttempt.error?.message.includes('\u001b')).toBe(true);
    expect(ansiAttempt.error?.stack?.includes('\u001b')).toBe(true);
    expect(ansiAttempt.stdout.includes('\u001b')).toBe(true);
    expect(ansiAttempt.stderr.includes('\u001b')).toBe(true);

    const output = renderToStaticMarkup(
      <AttemptCard attempt={ansiAttempt} itemKey={item.itemKey} artifacts={[artifact]} contentUrl={() => '#'} />,
    );
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0007');
    expect(output).toContain('expect(locator).toHaveText: 断言不匹配');
    expect(output).toContain('Expected:');
    expect(output).toContain('你好');
    expect(output).toContain('console log line');
    expect(output).toContain('stderr line');
    expect(output).toContain('复制原始错误（含控制符）');
    expect(output).toContain('复制原始 stdout');
    expect(output).toContain('复制原始 stderr');
    expect(output).toContain('原始 message 仍保存在接口与产物中');
  });

  it('逐项结果摘要剥离 ANSI（不能出现原始 ESC 片段）', () => {
    const firstAttempt = item.attempts[0]!;
    const ansiItem: RunItem = {
      ...item,
      attempts: [
        {
          ...firstAttempt,
          error: {
            ...firstAttempt.error!,
            message: '\u001b[31m断言不匹配：期望「你好」\u001b[0m，实际「错误文本」',
          },
        },
      ],
    };
    const output = renderToStaticMarkup(<RunItemsTable items={[ansiItem]} artifacts={[]} contentUrl={() => '#'} />);
    expect(output).not.toContain('\u001b');
    expect(output).toContain('断言不匹配：期望「你好」');
    expect(output).toContain('实际「错误文本」');
  });

  it('诊断警告与运行级错误剥离 ANSI，并保留原始复制入口', () => {
    const ansiRun: Run = {
      ...run,
      diagnostics: {
        ...run.diagnostics,
        warnings: ['\u001b[33m步骤 2 使用了 css 兜底定位\u001b[0m'],
      },
      error: { code: 'RUN_TIMEOUT', message: '\u001b[31m运行级超时：600000ms\u001b[0m' },
    };
    const diagnostics = renderToStaticMarkup(<DiagnosticsPanel run={ansiRun} />);
    expect(diagnostics).not.toContain('\u001b');
    expect(diagnostics).toContain('步骤 2 使用了 css 兜底定位');

    const errorNotice = renderToStaticMarkup(<RunErrorNotice run={ansiRun} />);
    expect(errorNotice).not.toContain('\u001b');
    expect(errorNotice).toContain('运行级超时：600000ms');
    expect(errorNotice).toContain('复制原始运行错误（含控制符）');
  });

  it('附件 artifactId=null 时按 itemKey+附件名匹配产物并显示链接', () => {
    const firstAttempt = item.attempts[0]!;
    const fallbackAttempt: RunItemAttempt = {
      ...firstAttempt,
      attachments: [{ name: 'trace.zip', contentType: 'application/zip', artifactId: null }],
    };
    const output = renderToStaticMarkup(
      <AttemptCard
        attempt={fallbackAttempt}
        itemKey={item.itemKey}
        artifacts={[artifact]}
        contentUrl={(artifactItem) => `/api/v1/runs/${run.id}/artifacts/${artifactItem.id}/content`}
      />,
    );
    expect(output).toContain('trace.zip');
    expect(output).toContain('/api/v1/runs/run_1234567890abcdef/artifacts/art_1/content');
    expect(output).toContain('按附件名/类型匹配到产物');
    expect(output).not.toContain('产物未登记或已被清理');
  });

  it('附件无法匹配任何产物时明确提示未登记（不伪造链接）', () => {
    const firstAttempt = item.attempts[0]!;
    const unmatched: RunItemAttempt = {
      ...firstAttempt,
      attachments: [{ name: 'missing.zip', contentType: 'application/zip', artifactId: null }],
    };
    const output = renderToStaticMarkup(
      <AttemptCard attempt={unmatched} itemKey={item.itemKey} artifacts={[]} contentUrl={() => '#'} />,
    );
    expect(output).toContain('missing.zip');
    expect(output).toContain('产物未登记或已被清理');
    expect(output).not.toContain('按附件名/类型匹配到产物');
  });
});