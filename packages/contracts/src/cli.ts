/**
 * CLI 执行合同（官方 `playwright cli` 子进程）。权威来源：docs/api-contract.md §9。
 *
 * 纪律：argv[0] 必须是白名单命令；安装类/连接真实浏览器类命令一律禁止；
 * 命令通过 `spawn(exe, argv, {shell:false})` 传递（Windows 禁止拼接命令行）。
 */

import { z } from 'zod';

/** 允许的 CLI 命令（api-contract §9.1，与官方 `playwright cli --help` 实测集一致） */
export const CLI_ALLOW_COMMANDS = [
  'open',
  'close',
  'close-all',
  'kill-all',
  'goto',
  'type',
  'click',
  'dblclick',
  'fill',
  'press',
  'check',
  'uncheck',
  'select',
  'hover',
  'drag',
  'drop',
  'upload',
  'snapshot',
  'find',
  'screenshot',
  'pdf',
  'tab-list',
  'tab-new',
  'tab-close',
  'tab-select',
  'state-save',
  'state-load',
  'cookie-list',
  'cookie-get',
  'cookie-set',
  'cookie-delete',
  'cookie-clear',
  'localstorage-list',
  'localstorage-get',
  'localstorage-set',
  'localstorage-delete',
  'localstorage-clear',
  'sessionstorage-list',
  'sessionstorage-get',
  'sessionstorage-set',
  'sessionstorage-delete',
  'sessionstorage-clear',
  'console',
  'requests',
  'request',
  'request-headers',
  'request-body',
  'response-headers',
  'response-body',
  'tracing-start',
  'tracing-stop',
  'video-start',
  'video-stop',
  'generate-locator',
  'highlight',
  'list',
  'resize',
  'go-back',
  'go-forward',
  'reload',
  'mousemove',
  'mousedown',
  'mouseup',
  'mousewheel',
  'keydown',
  'keyup',
  'dialog-accept',
  'dialog-dismiss',
  'delete-data',
  'set-color-scheme',
  'clear-color-scheme',
  'network-state-set',
] as const;

/** 需二次确认（且需 PW_ENABLE_UNSAFE_TOOLS=1） */
export const CLI_NEEDS_CONFIRM_COMMANDS = ['run-code', 'eval'] as const;

/** 禁止（安装副作用 / 连接本机真实浏览器 / 未证实命令） */
export const CLI_DENY_COMMANDS = ['install', 'install-browser', 'attach', 'config-print'] as const;

export const cliCommandRoleSchema = z.enum(['allow', 'needsConfirm', 'deny']);

export const cliCommandsResponseSchema = z
  .object({
    allow: z.array(z.string()),
    needsConfirm: z.array(z.string()),
    deny: z.array(z.string()),
  })
  .strict();

export type CliCommandsResponse = z.infer<typeof cliCommandsResponseSchema>;

export const cliExecRequestSchema = z
  .object({
    argv: z.array(z.string().max(4096)).min(1).max(32),
    session: z.string().min(1).max(120).optional(),
    workDir: z.string().min(1).max(1024).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).default(30000),
    confirm: z.boolean().default(false),
  })
  .strict();

export type CliExecRequest = z.infer<typeof cliExecRequestSchema>;

export const cliArtifactRefSchema = z
  .object({
    kind: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();

export type CliArtifactRef = z.infer<typeof cliArtifactRefSchema>;

export const cliExecResponseSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    json: z.unknown().nullable(),
    parsed: z.unknown().nullable(),
    durationMs: z.number().nonnegative(),
    artifacts: z.array(cliArtifactRefSchema),
  })
  .strict();

export type CliExecResponse = z.infer<typeof cliExecResponseSchema>;

/** argv[0] 分类：allow / needsConfirm / deny / unknown */
export function classifyCliCommand(command: string): 'allow' | 'needsConfirm' | 'deny' | 'unknown' {
  if ((CLI_ALLOW_COMMANDS as readonly string[]).includes(command)) return 'allow';
  if ((CLI_NEEDS_CONFIRM_COMMANDS as readonly string[]).includes(command)) return 'needsConfirm';
  if ((CLI_DENY_COMMANDS as readonly string[]).includes(command)) return 'deny';
  return 'unknown';
}