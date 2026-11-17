/**
 * 官方 MCP 工具白名单与 unsafe 分组（docs/api-contract.md §8）。
 *
 * 单一事实来源：`@pw-auto/contracts` 的 `MCP_TOOL_WHITELIST` / `MCP_UNSAFE_TOOL_NAMES` /
 * `DEFAULT_MCP_CAPS`。automation 不再维护第二份名单，也不按前缀/正则猜测 unsafe。
 *
 * unsafe 段是**精确集合**（8 个官方已文档化工具名，含 vision 的 mouse down/up/wheel）：
 * 需 PW_ENABLE_UNSAFE_TOOLS=1 且请求体 confirm:true，否则 403 CAPABILITY_DISABLED。
 */

import {
  DEFAULT_MCP_CAPS,
  MCP_TOOL_WHITELIST,
  MCP_UNSAFE_TOOL_NAMES,
} from '@pw-auto/contracts';

/** 默认 caps（testing,storage,network），与 contracts 完全一致。 */
export const MCP_DEFAULT_CAPS = DEFAULT_MCP_CAPS;

/** 合同默认允许的官方工具（28 项），与 contracts 完全一致。 */
export const MCP_DEFAULT_ALLOWED_TOOLS = MCP_TOOL_WHITELIST;

/** unsafe 精确集合（8 项），与 contracts 完全一致。 */
export const MCP_UNSAFE_TOOLS = MCP_UNSAFE_TOOL_NAMES;

/** 精确成员判定：不在 contracts 名单内的名字一律不是 unsafe（走白名单/未知工具拒绝）。 */
export function isUnsafeMcpTool(toolName: string): boolean {
  return (MCP_UNSAFE_TOOLS as readonly string[]).includes(toolName);
}

/** 是否在合同默认白名单内。 */
export function isDefaultAllowedMcpTool(toolName: string): boolean {
  return (MCP_DEFAULT_ALLOWED_TOOLS as readonly string[]).includes(toolName);
}
