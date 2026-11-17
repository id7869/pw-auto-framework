/**
 * @pw-auto/automation 公共出口。
 *
 * apps/api 只从这里导入执行引擎与官方能力适配器；本包是唯一允许 spawn 子进程 / 触碰 Playwright 的层。
 */

export * from './types.ts';
export * from './errors.ts';
export * from './engine.ts';
export * from './playwrightCli.ts';
export * from './capabilities.ts';

export { compileCaseSnapshot, normalizeDatasetRows, sanitizeCaseId, buildSpecFileName, itemKeyFor } from './compiler/specCompiler.ts';
export { compileValueExpression, compileTargetExpression, compileMatcher, globToRegExpSource } from './compiler/expressions.ts';
export { buildPlaywrightConfig, mapBrowserSelection, PLAYWRIGHT_PROJECT_NAME } from './runner/config.ts';
export { parseJsonReport, parseRowIndexFromTitle, normalizeErrorMessage, hashErrorMessage, truncateUtf8 } from './runner/jsonReport.ts';
export { indexRunArtifacts, toPosixRelative, pathKey } from './runner/artifacts.ts';
export { PlaywrightTestRunner, readEnvironmentFingerprint, type PlaywrightTestRunnerOptions } from './runner/testRunner.ts';
export { ProcessRegistry, isProcessAlive, killProcessTree, runProcess, type ProcessRunOptions, type ProcessRunResult, type ProcessRegistration } from './process/process-tree.ts';

export { McpAdapter, createMcpAdapter, MCP_PROTOCOL_VERSION, type McpAdapterOptions, type McpCallOptions, type McpCallResult, type McpCreateSessionInput, type McpSessionInfo, type McpSessionStatus } from './mcp/client.ts';
export { MCP_DEFAULT_CAPS, MCP_DEFAULT_ALLOWED_TOOLS, MCP_UNSAFE_TOOLS, isUnsafeMcpTool, isDefaultAllowedMcpTool } from './mcp/whitelist.ts';

export { CliAdapter, createCliAdapter, type CliAdapterOptions, type CliExecRequest, type CliExecResult, type CliExecArtifact } from './cli/client.ts';
export { CLI_ALLOWED_COMMANDS, CLI_CONFIRM_COMMANDS, CLI_DENIED_COMMANDS, describeCliCommands, isAllowedCliCommand, isDeniedCliCommand, needsConfirmCliCommand, type CliCommand } from './cli/whitelist.ts';

export { AgentsAdapter, createAgentsAdapter, AGENT_LOOPS, AGENT_LOOP_DESCRIPTIONS, AGENT_LOOP_FILES, listAgentLoops, type AgentLoop, type AgentScaffoldFile, type AgentScaffoldInput, type AgentScaffoldResult, type AgentPromptsInput, type AgentWorkspaceEntry, type AgentWorkspaceInput, type AgentsAdapterOptions } from './agents/scaffold.ts';
export { FRAMEWORK_PROMPT_TEMPLATES, AGENT_PROMPT_KEYS, getFrameworkPromptTemplates, type AgentPromptKey, type AgentPromptTemplate } from './agents/prompts.ts';