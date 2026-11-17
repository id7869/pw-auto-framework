import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHarness } from '../api/types.ts';
import { HarnessCard } from './AgentsPage.tsx';

const harnesses: AgentHarness[] = [
  {
    entry: 'claude',
    label: 'Claude Code',
    officialLoop: 'claude',
    requiresMcp: false,
    skillPaths: [
      { scope: 'project', path: '.claude/skills/pw-auto-test' },
      { scope: 'user', path: '~/.claude/skills/pw-auto-test' },
    ],
  },
  {
    entry: 'codex',
    label: 'Codex CLI',
    officialLoop: 'codex',
    requiresMcp: false,
    skillPaths: [{ scope: 'project', path: '.codex/skills/pw-auto-test' }],
    notes: '以官方 init-agents 产物为准。',
  },
  {
    entry: 'deepseek',
    label: 'DeepSeek Harness',
    officialLoop: null,
    requiresMcp: false,
    skillPaths: [
      { scope: 'user', path: '~/.dsh/skills/pw-auto-test' },
      { scope: 'shared', path: '.agents/skills/pw-auto-test' },
    ],
    notes: '无官方 Playwright loop，使用 prompts 四模板 + 通用 skill。',
  },
];

describe('pages/AgentsPage：三 harness 卡片', () => {
  it('恰展示 claude/codex/deepseek 三张卡片，deepseek officialLoop=null', () => {
    const output = renderToStaticMarkup(
      <div>
        {harnesses.map((harness) => (
          <HarnessCard key={harness.entry} harness={harness} />
        ))}
      </div>,
    );
    expect(output).toContain('Claude Code');
    expect(output).toContain('Codex CLI');
    expect(output).toContain('DeepSeek Harness');
    expect(output).toContain('officialLoop：');
    expect(output).toContain('无（DeepSeek 无官方 loop，不伪造）');
    expect(output).toContain('requiresMcp: false');
    expect(output).toContain('.claude/skills/pw-auto-test');
    expect(output).toContain('~/.dsh/skills/pw-auto-test');
    expect(output).toContain('.agents/skills/pw-auto-test');
    expect(output).toContain('skills/pw-auto-test/');
    expect(output).toContain('框架没有安装按钮/安装状态');
    // 不得渲染旧 6 loop 或安装按钮
    expect(output).not.toContain('copilot');
    expect(output).not.toContain('opencode');
    expect(output).not.toContain('vscode');
    expect(output).not.toMatch(/<button[^>]*>[^<]*安装/u);
    expect(output).not.toContain('已安装');
  });
});