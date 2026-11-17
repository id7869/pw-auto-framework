/**
 * 套件（Suite）合同。权威来源：docs/api-contract.md §4。
 */

import { z } from 'zod';
import { isoDateTimeSchema, resourceIdSchema } from './common.ts';

export const suiteSchema = z
  .object({
    id: resourceIdSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(2000),
    caseIds: z.array(resourceIdSchema).min(1).max(100),
    casesCount: z.number().int().nonnegative(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type Suite = z.infer<typeof suiteSchema>;

const caseIdsSchema = z.array(z.string().min(1).max(160)).min(1).max(100);

export const createSuiteRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    caseIds: caseIdsSchema,
  })
  .strict();

export type CreateSuiteRequest = z.infer<typeof createSuiteRequestSchema>;

export const patchSuiteRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

export type PatchSuiteRequest = z.infer<typeof patchSuiteRequestSchema>;

export const putSuiteCasesRequestSchema = z
  .object({
    caseIds: caseIdsSchema,
  })
  .strict();

export type PutSuiteCasesRequest = z.infer<typeof putSuiteCasesRequestSchema>;

export const suiteListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().min(1).max(100).optional(),
});

export type SuiteListQuery = z.infer<typeof suiteListQuerySchema>;