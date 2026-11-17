/**
 * fake 执行引擎：只用于 apps/api 单测，不触碰 Playwright/浏览器/子进程。
 * 行为可控：正常返回、延迟、闸门（并发/取消测试）、挂起（超时测试）、抛错。
 *
 * 说明：类型按 `@pw-auto/automation` 当前公开接口（EngineRunResult 含 runId/diagnostics，
 * EngineRunItem 含 caseId，CompileResult 含 errors/specSource/specFileName/itemKeys）实现。
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CaseSnapshot,
  CompileResult,
  EngineRunArtifact,
  EngineRunItem,
  EngineRunRequest,
  EngineRunResult,
  ExecutionEngine,
} from '@pw-auto/automation';
import type { ItemOutcome } from '@pw-auto/contracts';

type EngineAttempt = EngineRunItem['attempts'][number];
type AttemptStatus = EngineAttempt['status'];

export interface FakeEngineState {
  outcome: ItemOutcome;
  failMessage: string;
  /** 失败时的官方 error.snippet（用于断言 attempt.error.snippet 透传） */
  failSnippet: string | null;
  exitCode: number;
  /** 覆盖 items（用于构造新增/消失项的回归场景） */
  itemKeys: string[] | null;
}

export interface FakeEngineConfig {
  delayMs?: number;
  gate?: boolean;
  hang?: boolean;
  rejectWith?: string;
  compile?: CompileResult;
  writeReport?: boolean;
  artifacts?: EngineRunArtifact[];
  /** 指定成员用例返回「引擎级 error」结果（模拟编译失败/无报告等），其余成员正常 */
  engineErrorByCase?: Record<string, { code: string; message: string }>;
  /** 指定成员用例直接抛错（模拟子进程/引擎异常） */
  caseRejectByCase?: Record<string, string>;
  state?: Partial<FakeEngineState>;
}

export interface FakeEngine extends ExecutionEngine {
  calls: EngineRunRequest[];
  /** 记录 compile 入参：用于断言「validate 是否把数据集列/行传给官方编译」（F2 回归） */
  compileCalls: { caseSnapshot: CaseSnapshot }[];
  cancelCalls: string[];
  state: FakeEngineState;
  /** 按 caseId 注入「引擎级 error」结果；可在用例创建之后写入（run 时读取） */
  engineErrors: Record<string, { code: string; message: string }>;
  /** 按 caseId 注入抛错；可在用例创建之后写入 */
  caseRejects: Record<string, string>;
  release(): void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function hashOf(message: string | null): string {
  if (message === null || message.trim() === '') return '';
  return createHash('sha256').update(message).digest('hex');
}

function attemptOf(
  status: AttemptStatus,
  attempt: number,
  failMessage: string,
  failSnippet: string | null,
): EngineAttempt {
  const failed = status === 'failed' || status === 'timedOut';
  const error = failed
    ? {
        message: failMessage,
        ...(failSnippet === null ? {} : { snippet: failSnippet }),
        location: { file: 'fake.spec.ts', line: 10, column: 5 },
      }
    : null;
  return {
    attempt,
    status,
    durationMs: 8 + attempt,
    startTime: new Date().toISOString(),
    error,
    errorHash: hashOf(error?.message ?? null),
    steps: [],
    attachments: [],
    stdout: '',
    stderr: '',
    truncated: false,
  };
}

function attemptsFor(outcome: ItemOutcome, failMessage: string, failSnippet: string | null): EngineAttempt[] {
  if (outcome === 'expected') return [attemptOf('passed', 0, failMessage, failSnippet)];
  if (outcome === 'skipped') return [attemptOf('skipped', 0, failMessage, failSnippet)];
  if (outcome === 'flaky') {
    return [attemptOf('failed', 0, failMessage, failSnippet), attemptOf('passed', 1, failMessage, failSnippet)];
  }
  if (outcome === 'unexpected') return [attemptOf('failed', 0, failMessage, failSnippet)];
  if (outcome === 'missing') return [];
  return [attemptOf('interrupted', 0, failMessage, failSnippet)];
}

function buildItems(req: EngineRunRequest, state: FakeEngineState): EngineRunItem[] {
  const snapshot = req.caseSnapshot as CaseSnapshot & { rows?: { rowIndex: number; data: Record<string, unknown> }[] };
  const caseId = snapshot.caseId;
  const rows = snapshot.rows ?? [];
  const keys = state.itemKeys ?? (rows.length > 0 ? rows.map((row) => `${caseId}#row:${row.rowIndex}`) : [caseId]);
  return keys.map((itemKey, index) => {
    const rowIndex = itemKey.includes('#row:') ? Number(itemKey.split('#row:')[1]) : null;
    return {
      itemKey,
      caseId,
      title: `${snapshot.name}${rowIndex === null ? '' : ` [row:${rowIndex}]`}`,
      rowIndex,
      projectName: null,
      outcome: state.outcome,
      durationMs: 10 + index,
      attempts: attemptsFor(state.outcome, state.failMessage, state.failSnippet),
    };
  });
}

function statsOf(items: EngineRunItem[]): EngineRunResult['stats'] {
  const stats = { expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 };
  for (const item of items) {
    if (item.outcome === 'expected') stats.expected += 1;
    else if (item.outcome === 'unexpected') stats.unexpected += 1;
    else if (item.outcome === 'flaky') stats.flaky += 1;
    else stats.skipped += 1;
    stats.durationMs += item.durationMs;
  }
  return stats;
}

export function createFakeEngine(config: FakeEngineConfig = {}): FakeEngine {
  const calls: EngineRunRequest[] = [];
  const compileCalls: { caseSnapshot: CaseSnapshot }[] = [];
  const cancelCalls: string[] = [];
  const state: FakeEngineState = {
    outcome: 'expected',
    failMessage: '期望文本不匹配（fake 引擎）',
    failSnippet: null,
    exitCode: 0,
    itemKeys: null,
    ...config.state,
  };
  const pendingGates: (() => void)[] = [];
  const engineErrors: Record<string, { code: string; message: string }> = { ...(config.engineErrorByCase ?? {}) };
  const caseRejects: Record<string, string> = { ...(config.caseRejectByCase ?? {}) };

  return {
    calls,
    compileCalls,
    cancelCalls,
    state,
    engineErrors,
    caseRejects,
    release(): void {
      for (const resolve of pendingGates.splice(0)) resolve();
    },
    async run(req, ctx): Promise<EngineRunResult> {
      calls.push(req);
      if (config.hang) {
        await sleep(60000, ctx.signal);
      }
      if (config.gate) {
        await new Promise<void>((resolve, reject) => {
          pendingGates.push(resolve);
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      if (config.delayMs && config.delayMs > 0) await sleep(config.delayMs, ctx.signal);
      if (config.rejectWith !== undefined) throw new Error(config.rejectWith);

      const caseId = req.caseSnapshot.caseId;
      const caseReject = caseRejects[caseId];
      if (caseReject !== undefined) throw Object.assign(new Error(caseReject), { code: 'ENGINE_ERROR' });

      const forcedError = engineErrors[caseId];
      if (forcedError !== undefined) {
        return {
          runId: req.runId,
          status: 'error',
          exitCode: null,
          stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
          items: [],
          artifacts: [],
          environment: {
            node: process.versions.node,
            playwright: '1.65.0',
            browser: 'chromium',
            os: `${process.platform}-${process.arch}`,
            timezone: 'Asia/Shanghai',
          },
          reportPath: '',
          error: {
            code: forcedError.code,
            message: forcedError.message,
            detail: { errors: [{ code: forcedError.code, message: forcedError.message }] },
          },
          diagnostics: {
            playwrightCliPath: 'fake/playwright-cli.js',
            command: [],
            specPath: null,
            reportPath: null,
            workspaceDir: req.workspaceDir,
            warnings: [forcedError.message],
            playwrightVersion: '1.65.0',
            browser: 'chromium',
            nodeVersion: process.versions.node,
            durationMs: 1,
          },
        };
      }

      const items = buildItems(req, state);
      const stats = statsOf(items);
      const reportPath = join(req.workspaceDir, 'report.json');
      if (config.writeReport !== false) {
        writeFileSync(reportPath, JSON.stringify({ stats, items: items.map((item) => item.itemKey) }), 'utf8');
      }
      const status: EngineRunResult['status'] =
        state.outcome === 'unexpected' || state.outcome === 'flaky' ? 'failed' : 'passed';
      return {
        runId: req.runId,
        status,
        exitCode: state.exitCode,
        stats,
        items,
        artifacts: config.artifacts ?? [],
        environment: {
          node: process.versions.node,
          playwright: '1.65.0',
          browser: 'chromium',
          os: `${process.platform}-${process.arch}`,
          timezone: 'Asia/Shanghai',
        },
        reportPath,
        diagnostics: {
          playwrightCliPath: 'fake/playwright-cli.js',
          command: ['node', 'playwright', 'test', 'fake.spec.ts'],
          specPath: join(req.workspaceDir, 'specs', `${req.caseSnapshot.caseId}.spec.ts`),
          reportPath,
          workspaceDir: req.workspaceDir,
          warnings: [],
          playwrightVersion: '1.65.0',
          browser: 'chromium',
          nodeVersion: process.versions.node,
          durationMs: 12,
        },
      };
    },
    async cancel(runId: string): Promise<void> {
      cancelCalls.push(runId);
    },
    async compile(input): Promise<CompileResult> {
      compileCalls.push({ caseSnapshot: input.caseSnapshot });
      if (config.compile) return config.compile;
      const steps = Array.isArray(input.caseSnapshot.steps) ? input.caseSnapshot.steps.length : 0;
      const rows = Array.isArray(input.caseSnapshot.rows) ? input.caseSnapshot.rows.length : 0;
      return {
        ok: true,
        stepsCount: steps,
        rowsCount: rows,
        warnings: [],
        errors: [],
        specSource: '// fake spec',
        specFileName: `${input.caseSnapshot.caseId}.spec.ts`,
        itemKeys: [input.caseSnapshot.caseId],
      };
    },
  };
}