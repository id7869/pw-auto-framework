import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/http.ts';
import type { Run, RunStatus } from '../api/types.ts';
import {
  RUN_POLL_DELAYS_MS,
  RUN_SSE_EVENTS,
  canUseSse,
  isTerminalStatus,
  nextPollDelayMs,
  pollRunUntilTerminal,
  runPhase,
} from './polling.ts';

function run(status: RunStatus, id = 'run_1'): Run {
  return {
    id,
    kind: 'case',
    caseId: 'case_1',
    suiteId: null,
    datasetId: null,
    options: {
      retries: 0,
      workers: 1,
      timeoutMs: 60000,
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      video: 'off',
      headed: false,
      browser: 'chromium',
      failOnFlaky: false,
    },
    status,
    queuePosition: null,
    requestedAt: '2026-11-11T02:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    exitCode: null,
    stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
    itemsCount: 0,
    artifactsCount: 0,
    environment: { node: '24', playwright: '1.65.0', browser: 'chromium', os: 'win', timezone: 'Asia/Shanghai' },
    error: null,
    diagnostics: { playwrightCliPath: '', command: [], specPath: null, reportPath: null, workspaceDir: '', warnings: [] },
    idempotencyKey: null,
  };
}

describe('lib/polling：退避与状态机', () => {
  it('退避序列 1s → 2s → 5s → 10s（之后固定 10s）', () => {
    expect(RUN_POLL_DELAYS_MS).toEqual([1000, 2000, 5000, 10000]);
    expect(nextPollDelayMs(0)).toBe(1000);
    expect(nextPollDelayMs(1)).toBe(2000);
    expect(nextPollDelayMs(2)).toBe(5000);
    expect(nextPollDelayMs(3)).toBe(10000);
    expect(nextPollDelayMs(9)).toBe(10000);
    expect(nextPollDelayMs(-1)).toBe(1000);
  });

  it('6 态终态判定与阶段', () => {
    expect(isTerminalStatus('passed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('error')).toBe(true);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
    expect(runPhase('queued')).toBe('queue');
    expect(runPhase('running')).toBe('active');
    expect(runPhase('passed')).toBe('terminal');
    expect(runPhase('weird')).toBe('unknown');
  });

  it('SSE 仅在浏览器支持且后端声明可用时启用；事件名来自合同', () => {
    expect(canUseSse(true, true)).toBe(true);
    expect(canUseSse(false, true)).toBe(false);
    expect(canUseSse(true, false)).toBe(false);
    expect(RUN_SSE_EVENTS).toEqual(['run.updated', 'item.updated', 'run.log', 'heartbeat']);
  });
});

describe('lib/polling：轮询到终态（mock API）', () => {
  it('queued → running → passed，按退避睡眠并在终态停止', async () => {
    const statuses: RunStatus[] = ['queued', 'running', 'passed'];
    const sleeps: number[] = [];
    let index = 0;
    const updates: RunStatus[] = [];
    const result = await pollRunUntilTerminal({
      fetchRun: async (): Promise<ApiResult<Run>> => {
        const status = statuses[Math.min(index, statuses.length - 1)] ?? 'passed';
        index += 1;
        return { ok: true, data: run(status) };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onUpdate: (result) => {
        if (result.ok) updates.push(result.data.status);
      },
    });
    expect(result.stopReason).toBe('terminal');
    expect(result.data?.status).toBe('passed');
    expect(result.attempts).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(updates).toEqual(['queued', 'running', 'passed']);
  });

  it('轮询失败不伪造状态，继续重试并记录错误', async () => {
    let index = 0;
    const result = await pollRunUntilTerminal({
      fetchRun: async (): Promise<ApiResult<Run>> => {
        index += 1;
        if (index === 1) {
          return { ok: false, error: { code: 'NETWORK_ERROR', message: '连接中断' } };
        }
        return { ok: true, data: run('failed') };
      },
      sleep: async () => undefined,
    });
    expect(result.stopReason).toBe('terminal');
    expect(result.data?.status).toBe('failed');
    expect(result.attempts).toBe(2);
    expect(result.error).toBeNull();
  });

  it('signal 取消时停止（attempts 计数正确）', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await pollRunUntilTerminal({
      fetchRun: async () => ({ ok: true, data: run('running') }),
      signal: controller.signal,
      sleep: async () => undefined,
    });
    expect(result.stopReason).toBe('cancelled');
    expect(result.attempts).toBe(0);
  });

  it('maxAttempts 上限保护（用于测试/调试）', async () => {
    let calls = 0;
    const result = await pollRunUntilTerminal({
      fetchRun: async () => {
        calls += 1;
        return { ok: true, data: run('running') };
      },
      sleep: async () => undefined,
      maxAttempts: 3,
    });
    expect(calls).toBe(3);
    expect(result.stopReason).toBe('max-attempts');
    expect(result.data?.status).toBe('running');
  });
});