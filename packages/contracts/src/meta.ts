/**
 * 元信息（GET /api/v1/meta）与能力开关合同。
 * 权威来源：docs/api-contract.md §1.2。
 *
 * 注意：`env` 只暴露绑定地址/端口/数据目录等非敏感信息，**禁止**任何密钥。
 */

import { z } from 'zod';
import { BROWSERS } from './run.ts';
import { agentEntrySchema } from './nl.ts';

export const metaResponseSchema = z
  .object({
    app: z
      .object({
        name: z.string().min(1),
      })
      .strict(),
    versions: z
      .object({
        node: z.string().min(1),
        playwright: z.string().min(1),
        playwrightCliPath: z.string(),
        /**
         * 版本来源（增量字段）：
         * - `cli`：启动时执行 `node <cli.js> --version` 解析得到的真实版本；
         * - `fallback`：探测失败，回退到冻结常量（此时 `playwrightVersionError` 给出原因）。
         */
        playwrightSource: z.enum(['cli', 'fallback']).optional(),
        playwrightVersionError: z.string().optional(),
        browser: z
          .object({
            name: z.string().min(1),
            channel: z.string().optional(),
            version: z.string().optional(),
          })
          .strict(),
        os: z.string().min(1),
      })
      .strict(),
    limits: z
      .object({
        runTimeoutMs: z.number().int().positive(),
        caseTimeoutMs: z.number().int().positive(),
        maxConcurrentRuns: z.number().int().min(1).max(2),
        keepRuns: z.number().int().min(5),
        bodyLimitBytes: z.number().int().positive(),
      })
      .strict(),
    env: z
      .object({
        bindHost: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        dataDir: z.string().min(1),
        staticDir: z.string().nullable(),
        corsOrigins: z.array(z.string()),
      })
      .strict(),
    capabilities: z
      .object({
        mcp: z
          .object({
            enabled: z.boolean(),
            sessions: z.number().int().nonnegative(),
          })
          .strict(),
        cli: z
          .object({
            enabled: z.boolean(),
            unsafeEnabled: z.boolean(),
          })
          .strict(),
        agents: z
          .object({
            /** 用户裁定：仅三入口（claude/codex/deepseek），不再暴露 6 loop */
            entries: z.array(agentEntrySchema),
          })
          .strict(),
        sse: z.boolean(),
        unsafeTools: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type MetaResponse = z.infer<typeof metaResponseSchema>;

export const browserNameSchema = z.enum(BROWSERS);

/** 服务端能力探测结果（内部用，同时决定 /meta 的 enabled 字段） */
export interface SurfaceAvailability {
  mcp: boolean;
  cli: boolean;
  agents: boolean;
  sse: boolean;
  unsafeTools: boolean;
  reasons: Record<string, string>;
}