/**
 * Harness 入口静态定义（R7，用户裁定：后端只有 claude/codex/deepseek 三入口）。
 *
 * - 不做 6 loop 兼容；`loop` 仅 claude/codex 有官方值，deepseek 为 null（不伪造）；
 * - `requiresMcp` 恒 false：skill 只调框架 HTTP API，MCP 由框架托管；
 * - 无安装态：这里只有推荐放置路径（框架不复制、不落盘 skills 目录）。
 */

import type { HarnessInfo } from '@pw-auto/contracts';

export const HARNESSES: HarnessInfo[] = [
  {
    entry: 'claude',
    label: 'Claude Code',
    officialLoop: 'claude',
    requiresMcp: false,
    skillPaths: [
      { scope: 'project', path: '<repo>/.claude/skills/pw-auto-test/' },
      { scope: 'user', path: '~/.claude/skills/pw-auto-test/' },
    ],
    notes: '通用 skill：skills/pw-auto-test/（用户自行放置，框架不安装）；官方 loop=claude',
  },
  {
    entry: 'codex',
    label: 'Codex CLI',
    officialLoop: 'codex',
    requiresMcp: false,
    skillPaths: [
      { scope: 'user', path: '~/.codex/skills/pw-auto-test/' },
      { scope: 'project', path: '<repo>/.codex/skills/pw-auto-test/' },
      { scope: 'shared', path: '~/.agents/skills/pw-auto-test/' },
    ],
    notes: '落点依据 openai/codex 源码；.agents/skills 运行时加载待证实',
  },
  {
    entry: 'deepseek',
    label: 'DeepSeek Harness',
    officialLoop: null,
    requiresMcp: false,
    skillPaths: [
      { scope: 'user', path: '~/.dsh/skills/pw-auto-test/' },
      { scope: 'shared', path: '<repo>/.agents/skills/pw-auto-test/' },
    ],
    notes: '官方 6 loop 无 deepseek（officialLoop:null）；能力=官方 --prompts 同构模板 + skill + AGENTS.md',
  },
];

export const DEEPSEEK_SCAFFOLD_NOTES =
  'deepseek 无官方 Playwright loop（officialLoop:null）；未执行 init-agents，已写入框架内与官方 --prompts 同构的 4 个交接模板（source=framework）';