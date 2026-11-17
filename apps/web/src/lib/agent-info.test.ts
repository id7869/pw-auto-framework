import { describe, expect, it } from 'vitest';
import {
  AGENT_BOUNDARY_NOTES,
  AGENT_DEFINITIONS,
  AGENT_HANDOFF_STEPS,
  AGENT_LOOP_DESCRIPTIONS,
  AGENT_LOOP_VALUES,
  OFFICIAL_COMMANDS,
  OFFICIAL_COMMAND_CATEGORY_LABELS,
  OFFICIAL_LINKS,
} from './agent-info.ts';
import { formatArgv, tokenizeArgv } from './argv.ts';

/** 用拼接构造禁用字样，避免在源码中出现 PRD §8 的禁止 API 字面量 */
const FORBIDDEN_TOKENS = [
  ['test', 'each'].join('.'),
  ['page', 'perform'].join('.'),
  ['--run', 'agents'].join('-'),
  ['--only', 'changed'].join('-'),
  ['playwright-cli@', '0.262.0'].join(''),
];

describe('lib/agent-info：官方 Agent 事实', () => {
  it('三个原生 Agent 定义齐全且指向官方定位', () => {
    expect(AGENT_DEFINITIONS.map((agent) => agent.id)).toEqual(['planner', 'generator', 'healer']);
    const text = AGENT_DEFINITIONS.map((agent) => `${agent.officialRole} ${agent.handoff}`).join('\n');
    expect(text).toContain('Markdown');
    expect(text).toContain('Playwright Test');
    expect(text).toContain('test.fixme()');
    for (const agent of AGENT_DEFINITIONS) {
      expect(agent.outputs.length).toBeGreaterThan(0);
      expect(agent.tools.length).toBeGreaterThan(0);
    }
  });

  it('loop 为官方 6 值，且都有中文说明', () => {
    expect(AGENT_LOOP_VALUES).toEqual(['claude', 'codex', 'copilot', 'opencode', 'vscode', 'vscode-legacy']);
    for (const loop of AGENT_LOOP_VALUES) {
      expect(AGENT_LOOP_DESCRIPTIONS[loop]?.length).toBeGreaterThan(0);
    }
  });

  it('官方链接全部是 playwright.dev', () => {
    expect(OFFICIAL_LINKS.length).toBeGreaterThanOrEqual(5);
    for (const link of OFFICIAL_LINKS) {
      expect(link.url.startsWith('https://playwright.dev/')).toBe(true);
    }
    expect(OFFICIAL_LINKS.map((link) => link.url)).toContain('https://playwright.dev/docs/test-agents');
  });

  it('命令均为 npx playwright 官方入口，且不包含禁用字样', () => {
    expect(OFFICIAL_COMMANDS.length).toBeGreaterThanOrEqual(10);
    for (const command of OFFICIAL_COMMANDS) {
      expect(command.command.startsWith('npx playwright ')).toBe(true);
      expect(OFFICIAL_COMMAND_CATEGORY_LABELS[command.category].length).toBeGreaterThan(0);
      for (const forbidden of FORBIDDEN_TOKENS) {
        expect(command.command.includes(forbidden)).toBe(false);
      }
    }
    const agentsCommands = OFFICIAL_COMMANDS.filter((command) => command.category === 'agents').map((command) => command.command);
    expect(agentsCommands.some((command) => command.includes('init-agents --loop=claude'))).toBe(true);
    expect(agentsCommands.some((command) => command.includes('--prompts'))).toBe(true);
    expect(OFFICIAL_COMMANDS.some((command) => command.command.includes('run-test-mcp-server'))).toBe(true);
  });

  it('边界说明明确不内置模型、模型由外部 agent 提供', () => {
    const text = AGENT_BOUNDARY_NOTES.join('\n');
    expect(text).toContain('不内置任何模型');
    expect(text).toContain('外部 coding agent');
    expect(text).toContain('模型能力由外部 coding agent 提供');
    expect(AGENT_HANDOFF_STEPS).toHaveLength(4);
  });
});

describe('lib/argv：命令分词', () => {
  it('空格分隔与引号包裹', () => {
    expect(tokenizeArgv('snapshot --json')).toEqual({ tokens: ['snapshot', '--json'], error: null });
    expect(tokenizeArgv('fill "a b" \'c d\'')).toEqual({ tokens: ['fill', 'a b', 'c d'], error: null });
    expect(tokenizeArgv('  open   http://127.0.0.1:4174/  ')).toEqual({ tokens: ['open', 'http://127.0.0.1:4174/'], error: null });
  });

  it('反斜杠转义与空输入', () => {
    expect(tokenizeArgv('a\\ b')).toEqual({ tokens: ['a b'], error: null });
    expect(tokenizeArgv('')).toEqual({ tokens: [], error: null });
  });

  it('引号未闭合给出中文错误', () => {
    const result = tokenizeArgv('fill "a');
    expect(result.error).toContain('引号未闭合');
  });

  it('formatArgv 对含空格参数加引号', () => {
    expect(formatArgv(['open', 'http://x'])).toBe('open http://x');
    expect(formatArgv(['fill', 'a b'])).toBe('fill "a b"');
  });
});