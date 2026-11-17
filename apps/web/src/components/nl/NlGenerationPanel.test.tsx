import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NlGeneration, NlSource } from '../../api/types.ts';
import { NlGenerationPanel } from './NlGenerationPanel.tsx';

function source(overrides: Partial<NlSource> = {}): NlSource {
  return {
    text: '打开 https://demo.example.com/\n点击「登录」\n应该看到「欢迎」',
    status: 'generated',
    sourceHash: 'ab12cd34ef56ab12',
    origin: 'agent',
    generatorVersion: 'skill/1.0.0',
    warnings: [],
    lines: [
      { line: 1, text: '打开 https://demo.example.com/', kind: 'instruction' },
      { line: 2, text: '点击「登录」', kind: 'step' },
      { line: 3, text: '应该看到「欢迎」', kind: 'step' },
    ],
    updatedAt: '2026-11-12T02:00:00.000Z',
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

function renderPanel(generationItem: NlGeneration, sourceItem: NlSource | null = source()): string {
  return renderToStaticMarkup(
    <NlGenerationPanel
      generation={generationItem}
      nlSource={sourceItem}
      busy={false}
      error={null}
      rejectReason=""
      acceptForce={false}
      onRejectReasonChange={() => undefined}
      onAcceptForceChange={() => undefined}
      onAccept={() => undefined}
      onReject={() => undefined}
      onCancel={() => undefined}
      onRegenerate={() => undefined}
    />,
  );
}

describe('components/nl/NlGenerationPanel：生成状态与验收', () => {
  it('queued/running 展示等待外部 agent 与取消按钮，不显示 Accept', () => {
    const queued = renderPanel(generation({ status: 'queued', steps: null }));
    expect(queued).toContain('排队中（等待外部 agent）');
    expect(queued).toContain('等待外部 coding agent');
    expect(queued).toContain('取消生成');
    expect(queued).toContain('本框架不内置模型');
    expect(queued).not.toContain('接受（Accept）并写入 steps');

    const running = renderPanel(generation({ status: 'running', steps: null }));
    expect(running).toContain('生成中');
    expect(running).toContain('取消生成');
  });

  it('ready 展示步骤卡片（来源 NL 行/动作/定位器/值/依据）与 Accept/Reject', () => {
    const output = renderPanel(generation());
    expect(output).toContain('第 2 步');
    expect(output).toContain('来源 NL 行');
    expect(output).toContain('第 2 行');
    expect(output).toContain('点击「登录」');
    expect(output).toContain('定位器');
    expect(output).toContain('值 / 参数');
    expect(output).toContain('依据');
    expect(output).toContain('接受（Accept）并写入 steps');
    expect(output).toContain('拒绝（Reject）');
    expect(output).toContain('拒绝原因（Reject 必填）');
    expect(output).not.toContain('生成结果已过期');
  });

  it('ready 且文本已修改时提示 stale，强制接受未勾选时 Accept 禁用', () => {
    const output = renderPanel(generation(), source({ sourceHash: 'ffffffffffffffff' }));
    expect(output).toContain('生成结果已过期（stale）');
    expect(output).toContain('重新生成并验收');
    expect(output).toContain('强制接受过期结果（force）');
    expect(output).toContain('disabled=""');
  });

  it('accepted 后仍展示步骤映射，但不再显示 Accept/Reject 控件', () => {
    const output = renderPanel(generation({ status: 'accepted', acceptedAt: '2026-11-12T02:10:00.000Z' }));
    expect(output).toContain('已接受生成结果');
    expect(output).toContain('执行真相是以本次生成写入的 steps');
    expect(output).toContain('第 2 行');
    expect(output).toContain('依据');
    expect(output).not.toContain('接受（Accept）并写入 steps');
    expect(output).not.toContain('拒绝（Reject）');
  });

  it('展示服务端 warnings 与行号；rejected 状态可重新生成', () => {
    const output = renderPanel(
      generation({
        status: 'rejected',
        warnings: [{ code: 'NL_LINE_UNMAPPED', line: 3, message: '第 3 行未能映射为步骤' }],
      }),
    );
    expect(output).toContain('服务端告警');
    expect(output).toContain('该行未能映射为步骤');
    expect(output).toContain('NL 第 3 行');
    expect(output).toContain('第 3 行未能映射为步骤');
    expect(output).toContain('已拒绝');
    expect(output).toContain('重新生成');
  });

  it('错误信封（如未知列/提交无效）按中文消息展示', () => {
    const output = renderToStaticMarkup(
      <NlGenerationPanel
        generation={generation({ status: 'ready' })}
        nlSource={source()}
        busy={false}
        error={{ code: 'NL_SUBMIT_INVALID', message: '步骤引用了不存在的数据列：不存在' }}
        rejectReason=""
        acceptForce={false}
        onRejectReasonChange={() => undefined}
        onAcceptForceChange={() => undefined}
        onAccept={() => undefined}
        onReject={() => undefined}
        onCancel={() => undefined}
        onRegenerate={() => undefined}
      />,
    );
    expect(output).toContain('NL_SUBMIT_INVALID');
    expect(output).toContain('步骤引用了不存在的数据列：不存在');
  });
});