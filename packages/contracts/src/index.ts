/**
 * 共享合同包出口（前后端唯一事实来源）。
 * 新增导出只允许**增量**：禁止重命名/删除已发布字段与导出名（api-contract 冻结纪律）。
 */

export * from './version.ts';
export * from './run-status.ts';
export * from './health.ts';
export * from './common.ts';
export * from './target.ts';
export * from './step.ts';
export * from './case.ts';
export * from './dataset.ts';
export * from './suite.ts';
export * from './run.ts';
export * from './artifact.ts';
export * from './baseline.ts';
export * from './comparison.ts';
export * from './agent.ts';
export * from './nl.ts';
export * from './mcp.ts';
export * from './cli.ts';
export * from './meta.ts';
export * from './events.ts';
export * from './surfaces.ts';
export * from './locale.ts';

// 统一中文校验文案（前后端一致；幂等）
import { configureChineseValidationMessages } from './locale.ts';
configureChineseValidationMessages();