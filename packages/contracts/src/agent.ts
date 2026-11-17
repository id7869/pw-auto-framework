/**
 * Agent 交接（官方 `playwright init-agents`）合同。
 * 权威来源：docs/api-contract.md §7；官方能力见 docs/research/02-mcp-cli-agents.md。
 *
 * 纪律：框架只调用官方 `init-agents` 生成脚手架并索引产物；
 * 框架**不内置 LLM**、不声称「已生成测试/已修复」、不做自动修复。
 */

import { z } from 'zod';
import { isoDateTimeSchema, resourceIdSchema } from './common.ts';
import { agentEntrySchema, type AgentEntryInfo, agentEntryInfoSchema } from './nl.ts';

/** 官方 loop 仅 claude/codex 两个入口（用户裁定：后端只保留三 harness） */
export const AGENT_LOOPS = ['claude', 'codex'] as const;
export type AgentLoop = (typeof AGENT_LOOPS)[number];
export const agentLoopSchema = z.enum(AGENT_LOOPS);

/**
 * GET /agents/loops 的三入口等价信息（用户裁定：后端不再提供 6 loop 兼容）。
 * 保留导出名以兼容既有引用；返回内容仅 claude/codex/deepseek。
 */
export const agentLoopInfoSchema = agentEntryInfoSchema;
export type AgentLoopInfo = AgentEntryInfo;

export const SCAFFOLD_STATUSES = ['completed', 'failed'] as const;
export type ScaffoldStatus = (typeof SCAFFOLD_STATUSES)[number];

export const scaffoldFileSchema = z
  .object({
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type ScaffoldFile = z.infer<typeof scaffoldFileSchema>;

export const scaffoldSchema = z
  .object({
    id: resourceIdSchema,
    /** 实际执行的官方 loop（deepseek 无官方 loop → null，不伪造） */
    loop: z.string().min(1).nullable(),
    entry: agentEntrySchema,
    officialLoop: z.enum(['claude', 'codex']).nullable(),
    prompts: z.boolean(),
    targetDir: z.string().min(1),
    status: z.enum(SCAFFOLD_STATUSES),
    command: z.array(z.string()),
    files: z.array(scaffoldFileSchema),
    missing: z.array(z.string()),
    notes: z.string().optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .strict()
      .nullable(),
    createdAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema,
  })
  .strict();

export type Scaffold = z.infer<typeof scaffoldSchema>;

export const createScaffoldRequestSchema = z
  .object({
    /** 三入口（用户裁定）：claude|codex|deepseek；非三值由业务层映射 422 HARNESS_NOT_SUPPORTED */
    entry: z.string().min(1).max(32).optional(),
    /** 旧字段仅用于明确拒绝（→ 422 HARNESS_NOT_SUPPORTED），不再接受任意 loop */
    loop: z.string().min(1).max(32).optional(),
    prompts: z.boolean().default(false),
    /** 危险/有副作用操作必须显式确认（api-contract §0） */
    confirm: z.boolean().optional(),
  })
  .strict();

export type CreateScaffoldRequest = z.infer<typeof createScaffoldRequestSchema>;

export const PROMPT_KEYS = ['plan', 'generate', 'heal', 'coverage'] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];
export const promptKeySchema = z.enum(PROMPT_KEYS);

export const PROMPT_SOURCES = ['official', 'framework'] as const;
export type PromptSource = (typeof PROMPT_SOURCES)[number];

export const agentPromptSchema = z
  .object({
    key: promptKeySchema,
    title: z.string().min(1),
    body: z.string(),
    source: z.enum(PROMPT_SOURCES),
  })
  .strict();

export type AgentPrompt = z.infer<typeof agentPromptSchema>;

export const agentWorkspaceEntrySchema = z
  .object({
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    mtime: isoDateTimeSchema,
  })
  .strict();

export type AgentWorkspaceEntry = z.infer<typeof agentWorkspaceEntrySchema>;

export const agentWorkspaceQuerySchema = z.object({
  path: z.string().max(1024).optional(),
  scaffoldId: z.string().min(1).max(160).optional(),
});

export type AgentWorkspaceQuery = z.infer<typeof agentWorkspaceQuerySchema>;

/** GET /agents/prompts?entry= 的查询参数（三入口；不再暴露 6 loop） */
export const agentPromptsQuerySchema = z.object({
  entry: agentEntrySchema.optional(),
});

export type AgentPromptsQuery = z.infer<typeof agentPromptsQuerySchema>;

/**
 * 官方脚手架期望产物的结构校验基线（**只做存在性结论，不代表内容正确**）。
 * 逐 loop 的文件名来自 docs/research/02-mcp-cli-agents.md §4.4 的实测清单；
 * 用户裁定只保留 claude/codex 两个官方 loop（deepseek 无官方 loop，走 prompts 模板）。
 */
export const SCAFFOLD_EXPECTED_PATHS: Record<AgentLoop, readonly string[]> = {
  claude: [
    '.claude/agents/playwright-test-planner.md',
    '.claude/agents/playwright-test-generator.md',
    '.claude/agents/playwright-test-healer.md',
    '.mcp.json',
    'seed.spec.ts',
    'specs/README.md',
  ],
  codex: [
    '.codex/agents/playwright_test_planner.toml',
    '.codex/agents/playwright_test_generator.toml',
    '.codex/agents/playwright_test_healer.toml',
    'seed.spec.ts',
    'specs/README.md',
  ],
};

/** 官方 `--prompts` 附加产物文件名（`playwright-test-{plan,generate,heal,coverage}.md`） */
export const SCAFFOLD_PROMPT_FILENAMES: Record<string, string> = {
  'playwright-test-plan.md': 'plan',
  'playwright-test-generate.md': 'generate',
  'playwright-test-heal.md': 'heal',
  'playwright-test-coverage.md': 'coverage',
};