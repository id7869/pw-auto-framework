import { describe, expect, it } from 'vitest';
import {
  APP_VERSION,
  PLAYWRIGHT_VERSION,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  healthResponseSchema,
  isTerminalRunStatus,
  runStatusSchema,
} from '../index.ts';

describe('contracts/version', () => {
  it('官方承重版本钉死为 1.65.0', () => {
    expect(PLAYWRIGHT_VERSION).toBe('1.65.0');
  });

  it('框架版本为语义化三段式', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('contracts/run-status', () => {
  it('状态机恰好 6 态且终态为 4 个', () => {
    expect(RUN_STATUSES).toHaveLength(6);
    expect(TERMINAL_RUN_STATUSES).toHaveLength(4);
    expect(RUN_STATUSES).toEqual(['queued', 'running', 'passed', 'failed', 'cancelled', 'error']);
  });

  it('终态判定只认终态集合', () => {
    expect(isTerminalRunStatus('passed')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);
    expect(isTerminalRunStatus('queued')).toBe(false);
  });

  it('schema 拒绝非法状态', () => {
    expect(runStatusSchema.safeParse('running').success).toBe(true);
    expect(runStatusSchema.safeParse('cancelling').success).toBe(false);
  });
});

describe('contracts/health', () => {
  it('健康响应 schema 可校验并通过中文版本号', () => {
    const parsed = healthResponseSchema.safeParse({
      status: 'ok',
      uptimeMs: 1234,
      db: 'ok',
      version: APP_VERSION,
    });
    expect(parsed.success).toBe(true);
  });

  it('缺字段时校验失败', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok' }).success).toBe(false);
  });
});
