/**
 * 版本与身份常量。
 * 说明：本文件是脚手架占位，真实业务合同由 t6 在 packages/contracts 内扩展。
 */

export const APP_NAME = 'pw-auto-framework' as const;

/** 框架自身版本（与根 package.json 的 version 保持一致） */
export const APP_VERSION = '0.1.0' as const;

/** 官方承重版本，钉死；`GET /api/v1/meta` 必须回显该值并与实际 CLI 校验 */
export const PLAYWRIGHT_VERSION = '1.65.0' as const;

/** 官方能力入口（全部来自 @playwright/test@1.65.0 内置子命令） */
export const OFFICIAL_ENTRYPOINTS = ['test', 'cli', 'mcp', 'trace', 'init-agents'] as const;
export type OfficialEntrypoint = (typeof OFFICIAL_ENTRYPOINTS)[number];