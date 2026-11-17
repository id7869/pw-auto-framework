/**
 * Agent 交接面板的官方事实与命令文案。
 * 依据：docs/research/02-mcp-cli-agents.md §4（官方 https://playwright.dev/docs/test-agents，
 * 实测 @playwright/test 1.65.0 的 init-agents / mcp / cli / run-test-mcp-server）。
 *
 * 纪律：本文件只描述官方已文档化能力；不声明框架内置模型，不承诺自动生成/修复。
 */

export interface AgentDefinition {
  id: 'planner' | 'generator' | 'healer';
  name: string;
  title: string;
  officialRole: string;
  outputs: string[];
  tools: string[];
  handoff: string;
}

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: 'planner',
    name: 'planner',
    title: '测试规划',
    officialRole: '探索应用并产出 Markdown 测试计划（官方原文：explores the app and produces a Markdown test plan）。',
    outputs: ['specs/<功能>.md（测试计划）'],
    tools: ['planner_setup_page', 'planner_save_plan', 'planner_submit_plan', 'browser_* 只读探索工具'],
    handoff: '在外部 coding agent 中打开脚手架产物后，让它按 planner 定义探索目标站点并落盘计划。',
  },
  {
    id: 'generator',
    name: 'generator',
    title: '测试生成',
    officialRole: '把 Markdown 计划逐条转成 Playwright Test 文件，并用真实浏览器逐步验证（官方原文：transforms the Markdown plan into the Playwright Test files）。',
    outputs: ['tests/<分组>/<场景>.spec.ts（官方 @playwright/test 规格）'],
    tools: ['generator_setup_page', 'generator_read_log', 'generator_write_test', 'browser_* 浏览器工具'],
    handoff: '由外部 coding agent 依据计划逐场景生成；官方建议一个场景一个场景串行处理，不并行。',
  },
  {
    id: 'healer',
    name: 'healer',
    title: '失败修复',
    officialRole: '运行测试套件，定位并修复失败的测试代码（官方原文：executes the test suite and automatically repairs failing tests；由外部 coding agent 执行）。',
    outputs: ['修正后的测试文件', '必要时以 test.fixme() 标注无法修复的用例'],
    tools: ['test_run', 'test_debug', 'test_list', 'browser_* 取证工具', '文件编辑工具'],
    handoff: '先在框架「运行记录」中确认真实失败，再把失败信息交给外部 agent 的 healer 定义处理；官方也可能以 test.fixme() 收尾，不保证一次修好。',
  },
];

export interface OfficialLink {
  label: string;
  url: string;
  note: string;
}

export const OFFICIAL_LINKS: OfficialLink[] = [
  {
    label: 'Playwright Test Agents 官方文档',
    url: 'https://playwright.dev/docs/test-agents',
    note: 'planner / generator / healer 的官方定位与 init-agents 用法',
  },
  {
    label: 'Playwright MCP 官方文档',
    url: 'https://playwright.dev/mcp/introduction',
    note: '官方 MCP 服务端（交互式浏览器工具面）',
  },
  {
    label: 'Playwright Agent CLI 官方文档',
    url: 'https://playwright.dev/agent-cli/introduction',
    note: '官方 CLI 命令面（快照、点击、会话等）',
  },
  {
    label: '官方 Test Reporter（JSON）',
    url: 'https://playwright.dev/docs/test-reporters',
    note: '本框架的结果入库口径：官方 JSON 报告',
  },
  {
    label: '官方发布说明',
    url: 'https://playwright.dev/docs/release-notes',
    note: '版本变更与 Agent/CLI/MCP 能力演进',
  },
];

export type OfficialCommandCategory = 'test' | 'mcp' | 'cli' | 'agents' | 'trace';

export interface OfficialCommand {
  id: string;
  category: OfficialCommandCategory;
  label: string;
  command: string;
  description: string;
  caution?: string;
}

export const OFFICIAL_COMMAND_CATEGORY_LABELS: Record<OfficialCommandCategory, string> = {
  test: 'Test（官方测试运行器）',
  mcp: 'MCP（官方 MCP 服务端）',
  cli: 'CLI（官方命令面板）',
  agents: 'Agents（官方脚手架）',
  trace: 'Trace / 报告（官方排查工具）',
};

export const OFFICIAL_COMMANDS: OfficialCommand[] = [
  {
    id: 'test-run',
    category: 'test',
    label: '运行官方测试',
    command: 'npx playwright test',
    description: '官方 Playwright Test Runner；本框架后端执行运行时也是调用它（子进程）。',
  },
  {
    id: 'test-json',
    category: 'test',
    label: '输出官方 JSON 报告',
    command: 'npx playwright test --reporter=json',
    description: '运行历史、逐项结果与回归对比的唯一数据口径来自官方 JSON 报告。',
  },
  {
    id: 'test-retries',
    category: 'test',
    label: '带重试运行（flaky 观测）',
    command: 'npx playwright test --retries=1',
    description: '首次失败、重试通过会被官方标记为 flaky；框架按官方状态展示，不自行重算。',
  },
  {
    id: 'mcp',
    category: 'mcp',
    label: '启动官方 MCP 服务端（stdio）',
    command: 'npx playwright mcp',
    description: '供外部 coding agent 交互式探索页面、取证；不是回归执行器。',
  },
  {
    id: 'mcp-test-server',
    category: 'mcp',
    label: '启动测试 Agent 专用 MCP',
    command: 'npx playwright run-test-mcp-server',
    description: '官方 init-agents 写入 .mcp.json 时使用的服务端，提供 planner/generator/test 工具面。',
  },
  {
    id: 'cli-open',
    category: 'cli',
    label: '打开页面（CLI）',
    command: 'npx playwright cli open http://127.0.0.1:4174/',
    description: '官方 CLI 会话式命令；产物落在 .playwright-cli/ 目录（由后端受控执行并索引）。',
  },
  {
    id: 'cli-snapshot',
    category: 'cli',
    label: '页面快照（CLI，JSON）',
    command: 'npx playwright cli snapshot --json',
    description: '把页面结构快照交给外部 agent 分析；需先 open 建立会话。',
  },
  {
    id: 'cli-close',
    category: 'cli',
    label: '关闭 CLI 会话',
    command: 'npx playwright cli close',
    description: '结束当前 CLI 会话，避免浏览器进程残留。',
  },
  {
    id: 'agents-claude',
    category: 'agents',
    label: '生成 Claude Code Agent 脚手架',
    command: 'npx playwright init-agents --loop=claude',
    description: '只写文件（agent 定义、.mcp.json、seed.spec.ts、specs/README.md），不调用任何模型。',
    caution: '生成物会写入工作目录；本框架在受控目录内执行并要求二次确认。',
  },
  {
    id: 'agents-prompts',
    category: 'agents',
    label: '生成定义 + 提示词模板',
    command: 'npx playwright init-agents --loop=claude --prompts',
    description: '额外产出 plan/generate/heal/coverage 提示词；可在本页查看并复制。',
    caution: '官方要求 Playwright 升级后重新生成定义，并人工比对工具白名单变化。',
  },
  {
    id: 'agents-vscode',
    category: 'agents',
    label: '生成 VS Code Agent 脚手架',
    command: 'npx playwright init-agents --loop=vscode --prompts',
    description: '生成 VS Code 的 .github/agents/*.agent.md 与 .vscode/mcp.json。',
  },
  {
    id: 'trace',
    category: 'trace',
    label: '查看 trace',
    command: 'npx playwright show-trace <trace.zip>',
    description: '失败运行默认保留 trace；可在本框架运行详情下载产物后本地打开。',
  },
  {
    id: 'report',
    category: 'trace',
    label: '查看 HTML 报告',
    command: 'npx playwright show-report',
    description: '官方 HTML 报告；框架自身的结果页以官方 JSON 报告为准。',
  },
];

export const AGENT_LOOP_VALUES = ['claude', 'codex', 'copilot', 'opencode', 'vscode', 'vscode-legacy'] as const;

export const AGENT_LOOP_DESCRIPTIONS: Record<string, string> = {
  claude: 'Claude Code：.claude/agents/playwright-test-*.md + .mcp.json',
  codex: 'Codex：.codex/agents/playwright_test_*.toml + seed.spec.ts',
  copilot: 'GitHub Copilot（VS Code）：.github/agents/*.agent.md + .vscode/mcp.json',
  opencode: 'OpenCode：.opencode/prompts/playwright-test-*.md + opencode.json',
  vscode: 'VS Code：.github/agents/*.agent.md + .vscode/mcp.json',
  'vscode-legacy': 'VS Code（legacy chatmode）：.github/chatmodes/*.chatmode.md',
};

export const AGENT_HANDOFF_STEPS: { title: string; detail: string }[] = [
  {
    title: '1. 生成官方脚手架',
    detail: '在本页选择 claude/codex/deepseek 三入口之一并确认生成；框架调用官方 init-agents，只写文件、不调用模型（deepseek 不执行 init-agents）。',
  },
  {
    title: '2. 在外部 coding agent 中打开产物',
    detail: '用 Claude Code / Codex / DeepSeek Harness 打开生成的 agent 定义或 skills/pw-auto-test；框架不安装 skill，需用户自行复制到推荐路径。',
  },
  {
    title: '3. 交给 planner → generator → healer',
    detail: '按官方建议先规划、再逐场景生成、最后修复；模型由外部 agent 提供。',
  },
  {
    title: '4. 回到本框架执行与回归',
    detail: '把生成的用例整理进框架用例（或直接使用结构化用例），运行后按官方 JSON 报告做基线对比。',
  },
];

export const AGENT_BOUNDARY_NOTES: string[] = [
  '本框架不内置任何模型，也不在服务端调用 LLM；planner / generator / healer 的定义文件只是提示词与工具白名单。',
  '框架负责：官方脚手架生成、产物清单校验、提示词分发、运行与回归证据；模型能力由外部 coding agent 提供。',
  '官方 healer 也可能以 test.fixme() 结束，不保证一定修复成功；框架不会伪造"已修复"结论。',
  'MCP 是交互式探索与取证面，不能替代 Playwright Test 的回归执行；CLI 也不是测试生成器。',
];