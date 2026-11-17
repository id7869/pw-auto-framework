/**
 * 用例（Case）资源与请求合同。
 * 权威来源：docs/api-contract.md §2、附录 A.3。
 */

import { z } from 'zod';
import { isoDateTimeSchema, resourceIdSchema } from './common.ts';
import { createNlSourceInputSchema, nlSourceSchema, stepOriginSchema } from './nl.ts';
import { stepSchema } from './step.ts';

export const CASE_MODES = ['steps', 'code'] as const;
export type CaseMode = (typeof CASE_MODES)[number];
export const caseModeSchema = z.enum(CASE_MODES);

export const CASE_STATUSES = ['active', 'archived'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const caseStatusSchema = z.enum(CASE_STATUSES);

export const tagSchema = z.string().min(1).max(30);

export const caseSchema = z
  .object({
    id: resourceIdSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(2000),
    mode: caseModeSchema,
    steps: z.array(stepSchema).max(200),
    code: z.string().max(200000).nullable(),
    tags: z.array(tagSchema).max(20),
    status: caseStatusSchema,
    /** NL-first 增量（R6）：只读派生视图；无 NL 的旧用例不返回该字段值（null） */
    nl: nlSourceSchema.nullable().optional(),
    /** stepId → NL 行号映射（accept 写入；手改 steps 后可能缺项） */
    stepOrigin: stepOriginSchema.nullable().optional(),
    version: z.number().int().min(1),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    deletedAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export type Case = z.infer<typeof caseSchema>;

/** 列表项：省略 steps/code，只给 stepsCount（api-contract §2.3） */
export const caseListItemSchema = caseSchema
  .omit({ steps: true, code: true })
  .extend({
    stepsCount: z.number().int().nonnegative(),
    hasCode: z.boolean(),
  })
  .strict();

export type CaseListItem = z.infer<typeof caseListItemSchema>;

export const createCaseRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    mode: caseModeSchema.default('steps'),
    steps: z.array(stepSchema).max(200).default([]),
    code: z.string().max(200000).nullable().default(null),
    tags: z.array(tagSchema).max(20).default([]),
    /** 可选 NL 初值（只接受 text；status/sourceHash/lines 由服务端派生） */
    nl: createNlSourceInputSchema.optional(),
  })
  .strict();

export type CreateCaseRequest = z.infer<typeof createCaseRequestSchema>;

export const patchCaseRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    mode: caseModeSchema.optional(),
    steps: z.array(stepSchema).max(200).optional(),
    code: z.string().max(200000).nullable().optional(),
    tags: z.array(tagSchema).max(20).optional(),
    status: caseStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

export type PatchCaseRequest = z.infer<typeof patchCaseRequestSchema>;

export const caseListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().min(1).max(100).optional(),
  status: caseStatusSchema.optional(),
  tag: z.string().min(1).max(30).optional(),
});

export type CaseListQuery = z.infer<typeof caseListQuerySchema>;

export const validateCaseRequestSchema = z
  .object({
    datasetId: z.string().min(1).max(160).optional(),
  })
  .strict();

export type ValidateCaseRequest = z.infer<typeof validateCaseRequestSchema>;

export const validationWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    stepId: z.string().min(1).optional(),
  })
  .strict();

export type ValidationWarning = z.infer<typeof validationWarningSchema>;

export const validateCaseResponseSchema = z
  .object({
    ok: z.boolean(),
    compiledSpecPath: z.string().nullable(),
    stepsCount: z.number().int().nonnegative(),
    rowsCount: z.number().int().nonnegative(),
    warnings: z.array(validationWarningSchema),
  })
  .strict();

export type ValidateCaseResponse = z.infer<typeof validateCaseResponseSchema>;