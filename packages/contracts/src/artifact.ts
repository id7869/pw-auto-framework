/**
 * 产物（Artifact）合同。权威来源：docs/api-contract.md §5.5。
 *
 * 安全约束：content 端点只允许读取本运行工作区内**已登记**的文件；
 * 该类型不暴露磁盘绝对路径，避免前端/agent 借此探测文件系统。
 */

import { z } from 'zod';
import { isoDateTimeSchema, resourceIdSchema } from './common.ts';

export const ARTIFACT_KINDS = [
  'trace',
  'screenshot',
  'video',
  'json-report',
  'stdout',
  'stderr',
  'spec',
  'snapshot',
  'console',
  'other',
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const artifactKindSchema = z.enum(ARTIFACT_KINDS);

export const artifactSchema = z
  .object({
    id: resourceIdSchema,
    runId: resourceIdSchema,
    itemKey: z.string().min(1).nullable(),
    kind: artifactKindSchema,
    fileName: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    contentType: z.string().min(1),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type Artifact = z.infer<typeof artifactSchema>;

export const artifactListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  kind: artifactKindSchema.optional(),
});

export type ArtifactListQuery = z.infer<typeof artifactListQuerySchema>;

/** kind → 默认 Content-Type（api-contract §5.5） */
export const ARTIFACT_CONTENT_TYPES: Record<ArtifactKind, string> = {
  trace: 'application/zip',
  screenshot: 'image/png',
  video: 'video/webm',
  'json-report': 'application/json',
  stdout: 'text/plain',
  stderr: 'text/plain',
  spec: 'text/plain',
  snapshot: 'text/yaml',
  console: 'text/plain',
  other: 'application/octet-stream',
};