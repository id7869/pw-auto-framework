/**
 * MCP 会话合同（官方 `playwright mcp` 子进程）。权威来源：docs/api-contract.md §8。
 *
 * 纪律：
 * - 工具白名单**逐条来自官方 `tools/list` 实测清单**，不凭想象放行；
 * - unsafe 段（run-code / evaluate / *_xy）默认关闭，需 PW_ENABLE_UNSAFE_TOOLS=1 + confirm。
 */

import { z } from 'zod';
import { isoDateTimeSchema, looseDateTimeSchema, resourceIdSchema } from './common.ts';

/**
 * 官方 `--caps` 取值（官方 config.d.ts 的 ToolCapability 联合类型 + /mcp/capabilities 文档，
 * 见 docs/research/02-mcp-cli-agents.md §2.4：network/storage/testing/vision/pdf/devtools/config）。
 * 注意：core 能力始终开启，不是 `--caps` 取值。
 */
export const MCP_CAPS = ['testing', 'storage', 'network', 'devtools', 'pdf', 'vision', 'config'] as const;
export type McpCap = (typeof MCP_CAPS)[number];
export const mcpCapSchema = z.enum(MCP_CAPS);

export const DEFAULT_MCP_CAPS: readonly McpCap[] = ['testing', 'storage', 'network'];

export const MCP_SESSION_STATUSES = ['starting', 'ready', 'closing', 'closed', 'error'] as const;
export type McpSessionStatus = (typeof MCP_SESSION_STATUSES)[number];
export const mcpSessionStatusSchema = z.enum(MCP_SESSION_STATUSES);

export const mcpToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

export type McpTool = z.infer<typeof mcpToolSchema>;

export const mcpSessionSchema = z
  .object({
    id: resourceIdSchema,
    status: mcpSessionStatusSchema,
    serverInfo: z
      .object({
        name: z.string(),
        version: z.string(),
      })
      .strict()
      .nullable(),
    protocolVersion: z.string().nullable(),
    caps: z.array(mcpCapSchema),
    tools: z.array(mcpToolSchema),
    headless: z.boolean(),
    isolated: z.boolean(),
    workDir: z.string(),
    pid: z.number().int().nullable(),
    startedAt: isoDateTimeSchema,
    endedAt: looseDateTimeSchema.nullable(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type McpSession = z.infer<typeof mcpSessionSchema>;

export const createMcpSessionRequestSchema = z
  .object({
    caps: z.array(mcpCapSchema).max(10).optional(),
    headless: z.boolean().default(true),
    browser: z.string().min(1).max(40).optional(),
    isolated: z.boolean().default(true),
  })
  .strict();

export type CreateMcpSessionRequest = z.infer<typeof createMcpSessionRequestSchema>;

export const mcpToolCallRequestSchema = z
  .object({
    tool: z.string().min(1).max(120),
    arguments: z.record(z.string(), z.unknown()).optional(),
    /** unsafe 段工具（run-code / evaluate / 视觉坐标）需显式确认 */
    confirm: z.boolean().optional(),
  })
  .strict();

export type McpToolCallRequest = z.infer<typeof mcpToolCallRequestSchema>;

export const mcpToolCallResponseSchema = z
  .object({
    content: z.array(z.unknown()),
    isError: z.boolean(),
    durationMs: z.number().nonnegative(),
  })
  .strict();

export type McpToolCallResponse = z.infer<typeof mcpToolCallResponseSchema>;

/**
 * 默认允许的官方工具（api-contract §8.1 清单，来自官方 `tools/list` 实测）。
 * 未列出的名字一律 403 CAPABILITY_DISABLED。
 */
export const MCP_TOOL_WHITELIST = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_find',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
  'browser_hover',
  'browser_select_option',
  'browser_wait_for',
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_take_screenshot',
  'browser_tabs',
  'browser_resize',
  'browser_emulate_media',
  'browser_generate_locator',
  'browser_verify_element_visible',
  'browser_verify_text_visible',
  'browser_verify_list_visible',
  'browser_verify_value',
  'browser_close',
  'browser_drag',
  'browser_drop',
  'browser_file_upload',
  'browser_handle_dialog',
] as const;

export type McpWhitelistedTool = (typeof MCP_TOOL_WHITELIST)[number];

/**
 * unsafe 段工具：只认**官方已文档化**的名字（research 02 §2.4 实测工具面）：
 * - 任意代码：`browser_run_code_unsafe`、`browser_evaluate`（官方描述 RCE-equivalent）；
 * - vision 视觉坐标组（`--caps=vision` 的 browser_mouse_*）。
 * 其它 `browser_mouse_*` / `*_xy` 变体一律不是 unsafe → 走白名单判定并 403，避免"前缀即放行"。
 */
export const MCP_UNSAFE_TOOL_NAMES = [
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_mouse_move_xy',
  'browser_mouse_click_xy',
  'browser_mouse_drag_xy',
  'browser_mouse_down',
  'browser_mouse_up',
  'browser_mouse_wheel',
] as const;

export type McpUnsafeTool = (typeof MCP_UNSAFE_TOOL_NAMES)[number];

/** 判断是否为 unsafe 段工具（需 PW_ENABLE_UNSAFE_TOOLS + confirm） */
export function isUnsafeMcpTool(tool: string): boolean {
  return (MCP_UNSAFE_TOOL_NAMES as readonly string[]).includes(tool);
}

export function isWhitelistedMcpTool(tool: string): boolean {
  return (MCP_TOOL_WHITELIST as readonly string[]).includes(tool);
}

export const MCP_MAX_SESSIONS = 2;