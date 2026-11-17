/**
 * NL-first 增量合同（R6）与 Harness 入口（R7）。
 * 权威来源：docs/api-contract.md §12/§13、附录 A.7/A.8；docs/NL_AGENT_SKILL_DESIGN.md。
 *
 * 纪律：
 * - `mode` 不变（steps|code）；NL 只是"生成输入"，`accept` 后才写 steps/stepOrigin；
 * - 不内置 LLM：本包只定义模型与状态，生成由外部 harness（claude/codex/deepseek）完成；
 * - 无任何 skill 安装 schema（设计裁定：只给推荐路径）。
 */

import { z } from 'zod';
import { isoDateTimeSchema, resourceIdSchema } from './common.ts';
import { stepSchema } from './step.ts';

// ---------------------------------------------------------------------------
// NL 用例（R6）
// ---------------------------------------------------------------------------

export const NL_STATUSES = ['draft', 'generating', 'generated', 'stale', 'invalid'] as const;
export type NlStatus = (typeof NL_STATUSES)[number];
export const nlStatusSchema = z.enum(NL_STATUSES);

export const NL_ORIGINS = ['agent', 'rule'] as const;
export type NlOrigin = (typeof NL_ORIGINS)[number];
export const nlOriginSchema = z.enum(NL_ORIGINS);

export const NL_WARNING_CODES = [
  'NL_LINE_UNMAPPED',
  'NL_TARGET_AMBIGUOUS',
  'NL_UNSUPPORTED_ACTION',
  'NL_NO_ASSERTION',
] as const;
export type NlWarningCode = (typeof NL_WARNING_CODES)[number];
export const nlWarningCodeSchema = z.enum(NL_WARNING_CODES);

export const NL_LINE_KINDS = ['blank', 'comment', 'instruction', 'step', 'unmapped'] as const;
export type NlLineKind = (typeof NL_LINE_KINDS)[number];
export const nlLineKindSchema = z.enum(NL_LINE_KINDS);

export const nlLineSchema = z
  .object({
    line: z.number().int().min(1),
    text: z.string(),
    kind: nlLineKindSchema,
    stepId: z.string().nullable().optional(),
  })
  .strict();

export type NlLine = z.infer<typeof nlLineSchema>;

export const nlWarningSchema = z
  .object({
    code: nlWarningCodeSchema,
    line: z.number().int().min(0),
    message: z.string().min(1),
  })
  .strict();

export type NlWarning = z.infer<typeof nlWarningSchema>;

export const nlSourceSchema = z
  .object({
    text: z.string().min(1).max(200000),
    status: nlStatusSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{16}$/),
    origin: nlOriginSchema.nullable(),
    generatorVersion: z.string().max(64).nullable(),
    warnings: z.array(nlWarningSchema).max(500),
    lines: z.array(nlLineSchema).max(1000),
    updatedAt: isoDateTimeSchema,
    generatedAt: isoDateTimeSchema.nullable().optional(),
  })
  .strict();

export type NlSource = z.infer<typeof nlSourceSchema>;

export const stepOriginSchema = z.record(
  z.string().min(1).max(64),
  z.object({ nlLine: z.number().int().min(1) }).strict(),
);

export type StepOrigin = z.infer<typeof stepOriginSchema>;

/** PUT /cases/{id}/nl 的请求体 */
export const putNlRequestSchema = z
  .object({
    text: z.string().min(1).max(200000),
  })
  .strict();

export type PutNlRequest = z.infer<typeof putNlRequestSchema>;

/** POST /cases 里的可选 NL 初值（只接受 text，其余服务端派生） */
export const createNlSourceInputSchema = z
  .object({
    text: z.string().min(1).max(200000),
  })
  .strict();

export type CreateNlSourceInput = z.infer<typeof createNlSourceInputSchema>;

/** 服务端派生出的 NlSource 存储形态（与 A.7 一致，status/lines 读取时派生） */
export interface NlSourceRecord {
  text: string;
  sourceHash: string;
  origin: NlOrigin | null;
  generatorVersion: string | null;
  warnings: NlWarning[];
  updatedAt: string;
  generatedAt: string | null;
}

// ---------------------------------------------------------------------------
// 生成任务（R6）
// ---------------------------------------------------------------------------

export const NL_GENERATION_STATUSES = [
  'queued',
  'running',
  'ready',
  'accepted',
  'rejected',
  'failed',
  'cancelled',
] as const;
export type NlGenerationStatus = (typeof NL_GENERATION_STATUSES)[number];
export const nlGenerationStatusSchema = z.enum(NL_GENERATION_STATUSES);

export const NL_GENERATORS = ['agent', 'rule'] as const;
export type NlGenerator = (typeof NL_GENERATORS)[number];
export const nlGeneratorSchema = z.enum(NL_GENERATORS);

/** 活跃任务状态（同 case 只允许 1 个） */
export const NL_ACTIVE_GENERATION_STATUSES = ['queued', 'running', 'ready'] as const;

export const nlGenerationSchema = z
  .object({
    id: resourceIdSchema,
    caseId: resourceIdSchema,
    generator: nlGeneratorSchema,
    status: nlGenerationStatusSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{16}$/),
    origin: nlOriginSchema.nullable(),
    generatorVersion: z.string().max(64).nullable(),
    leaseId: z.string().nullable(),
    leaseExpiresAt: isoDateTimeSchema.nullable(),
    leaseAttempts: z.number().int().min(0).max(3),
    fallback: z.boolean(),
    caseName: z.string(),
    nlText: z.string(),
    datasetColumns: z.array(z.string()),
    /** 队列消费便利字段（§12.3 队列响应要求含 hints；开发生成任务时快照） */
    hints: z.record(z.string().max(64), z.string().max(2000)).optional(),
    /** submit 时提交的行号映射（accept 写回用例；A.8 未列，属 §12.3 实现必要增量） */
    stepOrigin: stepOriginSchema.nullable().optional(),
    steps: z.array(z.unknown()).nullable(),
    code: z.string().nullable(),
    warnings: z.array(nlWarningSchema),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .strict()
      .nullable(),
    submittedAt: isoDateTimeSchema.nullable(),
    acceptedAt: isoDateTimeSchema.nullable(),
    rejectedAt: isoDateTimeSchema.nullable(),
    failedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type NlGeneration = z.infer<typeof nlGenerationSchema>;

export const createNlGenerationRequestSchema = z
  .object({
    generator: nlGeneratorSchema.default('agent'),
    hints: z.record(z.string().max(64), z.string().max(2000)).optional(),
    force: z.boolean().default(false),
  })
  .strict();

export type CreateNlGenerationRequest = z.infer<typeof createNlGenerationRequestSchema>;

export const claimNlGenerationRequestSchema = z
  .object({
    leaseSeconds: z.number().int().min(5).max(600).optional(),
  })
  .strict();

export type ClaimNlGenerationRequest = z.infer<typeof claimNlGenerationRequestSchema>;

export const submitNlGenerationRequestSchema = z
  .object({
    leaseId: z.string().min(8).max(80),
    steps: z.array(stepSchema).max(500).optional(),
    code: z.string().max(200000).nullable().optional(),
    warnings: z.array(nlWarningSchema).max(500).optional(),
    generatorVersion: z.string().min(1).max(64),
    stepOrigin: stepOriginSchema.optional(),
    datasetId: z.string().min(1).max(160).optional(),
  })
  .strict();

export type SubmitNlGenerationRequest = z.infer<typeof submitNlGenerationRequestSchema>;

export const acceptNlGenerationRequestSchema = z
  .object({
    force: z.boolean().default(false),
    /** 仅当生成结果带 code 且人工选择代码模式时使用（默认 steps） */
    code: z.boolean().default(false),
  })
  .strict();

export type AcceptNlGenerationRequest = z.infer<typeof acceptNlGenerationRequestSchema>;

export const rejectNlGenerationRequestSchema = z
  .object({
    reason: z.string().min(1).max(2000),
  })
  .strict();

export type RejectNlGenerationRequest = z.infer<typeof rejectNlGenerationRequestSchema>;

export const nlGenerationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  status: z.string().min(1).max(64).optional(),
});

export type NlGenerationListQuery = z.infer<typeof nlGenerationListQuerySchema>;

export const nlGenerationQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  /** 逗号分隔的状态集合（默认 queued,running,ready） */
  status: z.string().min(1).max(120).optional(),
});

export type NlGenerationQueueQuery = z.infer<typeof nlGenerationQueueQuerySchema>;

export const nlSpecPreviewQuerySchema = z.object({
  preview: z.literal('1'),
});

export type NlSpecPreviewQuery = z.infer<typeof nlSpecPreviewQuerySchema>;

export const nlSpecPreviewSchema = z
  .object({
    text: z.string(),
    stepsCount: z.number().int().nonnegative(),
    rowsCount: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })
  .strict();

export type NlSpecPreview = z.infer<typeof nlSpecPreviewSchema>;

// ---------------------------------------------------------------------------
// Harness 入口（R7；无安装 schema）
// ---------------------------------------------------------------------------

export const AGENT_ENTRIES = ['claude', 'codex', 'deepseek'] as const;
export type AgentEntry = (typeof AGENT_ENTRIES)[number];
export const agentEntrySchema = z.enum(AGENT_ENTRIES);

export const HARNESS_SKILL_SCOPES = ['project', 'user', 'shared'] as const;
export type HarnessSkillScope = (typeof HARNESS_SKILL_SCOPES)[number];

export const harnessSkillPathSchema = z
  .object({
    scope: z.enum(HARNESS_SKILL_SCOPES),
    path: z.string().min(1),
  })
  .strict();

export type HarnessSkillPath = z.infer<typeof harnessSkillPathSchema>;

export const harnessInfoSchema = z
  .object({
    entry: agentEntrySchema,
    label: z.string().min(1),
    /** deepseek 官方 6 loop 无对应值 → null（不伪造） */
    officialLoop: z.enum(['claude', 'codex']).nullable(),
    /** skill 只调框架 HTTP API，MCP 由框架托管 → 恒 false */
    requiresMcp: z.literal(false),
    skillPaths: z.array(harnessSkillPathSchema).min(1).max(3),
    notes: z.string().optional(),
  })
  .strict();

export type HarnessInfo = z.infer<typeof harnessInfoSchema>;

/** GET /agents/loops 的三入口等价信息（不再暴露 copilot/opencode/vscode/vscode-legacy） */
export const agentEntryInfoSchema = z
  .object({
    entry: agentEntrySchema,
    loop: z.enum(['claude', 'codex']).nullable(),
    description: z.string().min(1),
  })
  .strict();

export type AgentEntryInfo = z.infer<typeof agentEntryInfoSchema>;