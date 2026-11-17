import { z } from 'zod';
import { APP_NAME, APP_VERSION } from './version.ts';

/**
 * 健康检查响应（GET /api/health），见 docs/api-contract.md §1.1。
 * 脚手架阶段只定义形状，具体实现由 t6 完成。
 */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeMs: z.number().int().nonnegative(),
  db: z.enum(['ok', 'error']),
  version: z.string().min(1),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** 统一的成功信封（见 api-contract §0.1） */
export interface ApiSuccess<T> {
  data: T;
  meta?: { requestId: string; durationMs?: number };
}

/** 统一的错误信封（见 api-contract §0.2） */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
    requestId: string;
  };
}

export const DEFAULT_HEALTH_PAYLOAD: HealthResponse = {
  status: 'ok',
  uptimeMs: 0,
  db: 'ok',
  version: APP_VERSION,
};

export const FRAMEWORK_NAME = APP_NAME;
