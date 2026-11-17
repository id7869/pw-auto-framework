/**
 * 数据集（Dataset）与行（DatasetRow）合同。
 * 权威来源：docs/api-contract.md §3。
 *
 * 说明：schema 只做「结构性硬边界」（防炸内存），业务边界（列数/行数/单元格长度）
 * 由 apps/api 用固定错误码（INVALID_DATASET / ROW_LIMIT_EXCEEDED / ROW_TOO_LARGE）判定，
 * 避免 zod 校验把契约错误码降级成 VALIDATION_FAILED。
 */

import { z } from 'zod';
import { isoDateTimeSchema, looseDateTimeSchema, resourceIdSchema } from './common.ts';

export const DATASET_SOURCES = ['manual', 'json', 'csv'] as const;
export type DatasetSource = (typeof DATASET_SOURCES)[number];
export const datasetSourceSchema = z.enum(DATASET_SOURCES);

/** 业务边界（给 apps/api 判定合同错误码）+ 结构化硬边界（防炸内存，不参与业务错误码） */
export const DATASET_LIMITS = {
  /** 业务边界（api-contract §3.1）：超过 → 422 ROW_LIMIT_EXCEEDED */
  maxRows: 500,
  maxColumns: 50,
  minColumns: 1,
  /** 业务边界：单元格字符串 ≤ 8192 字符，超过 → 422 ROW_TOO_LARGE */
  maxCellChars: 8192,
  /** 业务边界：列名 1..60 字符，超过 → 422 INVALID_DATASET */
  maxColumnNameChars: 60,
  /** 结构化硬边界（防炸内存）：请求体行数/列名/单元格的绝对上限 */
  maxRequestRows: 100_000,
  maxRequestColumnNameChars: 4096,
  maxRequestCellChars: 1_000_000,
} as const;

/** 单元格：只允许这四类标量（api-contract §3.1）；长度上限只是防炸内存的硬边界 */
export const cellValueSchema = z.union([
  z.string().max(DATASET_LIMITS.maxRequestCellChars),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type CellValue = z.infer<typeof cellValueSchema>;

/**
 * 列名硬边界放宽到 4096：业务上限 60 字符必须由 apps/api 判定并返回 422 INVALID_DATASET，
 * 不能让 zod 把它降级成 VALIDATION_FAILED（review F-契约错误码）。
 */
export const rowDataSchema = z.record(z.string().min(1).max(DATASET_LIMITS.maxRequestColumnNameChars), cellValueSchema);
export type RowData = z.infer<typeof rowDataSchema>;

export const datasetSchema = z
  .object({
    id: resourceIdSchema,
    caseId: resourceIdSchema,
    name: z.string().min(1).max(200),
    source: datasetSourceSchema,
    columns: z.array(z.string().min(1).max(200)).max(200),
    rowsCount: z.number().int().nonnegative(),
    enabledRowsCount: z.number().int().nonnegative(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type Dataset = z.infer<typeof datasetSchema>;

export const datasetRowSchema = z
  .object({
    id: resourceIdSchema,
    datasetId: resourceIdSchema,
    rowIndex: z.number().int().nonnegative(),
    data: rowDataSchema,
    enabled: z.boolean(),
    createdAt: looseDateTimeSchema,
    updatedAt: looseDateTimeSchema,
  })
  .strict();

export type DatasetRow = z.infer<typeof datasetRowSchema>;

export const datasetRowInputSchema = z
  .object({
    data: rowDataSchema,
    enabled: z.boolean().default(true),
  })
  .strict();

export type DatasetRowInput = z.infer<typeof datasetRowInputSchema>;

export const createDatasetRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
    source: datasetSourceSchema.default('manual'),
    // 结构化硬上限只用于防炸内存；业务边界（≤500 行）由 apps/api 统一给出 422 ROW_LIMIT_EXCEEDED
    rows: z.array(datasetRowInputSchema).max(DATASET_LIMITS.maxRequestRows).default([]),
  })
  .strict();

export type CreateDatasetRequest = z.infer<typeof createDatasetRequestSchema>;

/** PATCH：合同 §3.2 为 `{ name? }`；空对象无意义，refine 要求至少一个字段 */
export const patchDatasetRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined, { message: '至少提供一个待更新字段（name）' });

export type PatchDatasetRequest = z.infer<typeof patchDatasetRequestSchema>;

export const putDatasetRowsRequestSchema = z
  .object({
    rows: z.array(datasetRowInputSchema).max(DATASET_LIMITS.maxRequestRows),
  })
  .strict();

export type PutDatasetRowsRequest = z.infer<typeof putDatasetRowsRequestSchema>;

export const datasetRowListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  enabled: z.enum(['true', 'false']).optional(),
});

export type DatasetRowListQuery = z.infer<typeof datasetRowListQuerySchema>;

/** 列名不得含模板定界符（api-contract §3.1） */
export function isValidColumnName(name: string): boolean {
  return name.length >= 1 && name.length <= DATASET_LIMITS.maxColumnNameChars && !name.includes('{{') && !name.includes('}}');
}