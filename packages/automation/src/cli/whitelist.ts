/**
 * 官方 `playwright cli` 命令白名单（docs/api-contract.md §9）。
 *
 * 白名单来源：R-02 §3.3 实测命令集 + 合同冻结列表；不在列表内的官方命令（install/attach/config-print/route 等）
 * 一律拒绝，理由分别是“有副作用”或“未证实/不在本轮范围”。
 */

export const CLI_ALLOWED_COMMANDS = [
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

export type CliCommand = (typeof CLI_ALLOWED_COMMANDS)[number];

/** 需二次确认（等价任意 Playwright 代码执行）。 */
export const CLI_CONFIRM_COMMANDS = ['run-code', 'eval'] as const;

/** 显式拒绝（即使上游未来加入白名单讨论也不得放行）。 */
export const CLI_DENIED_COMMANDS = ['install', 'install-browser', 'attach', 'config-print'] as const;

export function isAllowedCliCommand(command: string): boolean {
  return (CLI_ALLOWED_COMMANDS as readonly string[]).includes(command);
}

export function needsConfirmCliCommand(command: string): boolean {
  return (CLI_CONFIRM_COMMANDS as readonly string[]).includes(command);
}

export function isDeniedCliCommand(command: string): boolean {
  return (CLI_DENIED_COMMANDS as readonly string[]).includes(command);
}

/** 供 GET /api/v1/cli/commands 直接返回。 */
export function describeCliCommands(): { allow: string[]; needsConfirm: string[]; deny: string[] } {
  return {
    allow: [...CLI_ALLOWED_COMMANDS],
    needsConfirm: [...CLI_CONFIRM_COMMANDS],
    deny: [...CLI_DENIED_COMMANDS],
  };
}