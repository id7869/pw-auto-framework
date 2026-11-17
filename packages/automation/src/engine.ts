/**
 * ExecutionEngine 的默认实现（docs/architecture.md §3.2）。
 *
 * 职责边界：
 * - 只做编排：编译 → 官方 test → 解析官方 JSON 报告 → 产物索引；
 * - 不读写数据库、不实现 HTTP/UI；
 * - 所有子进程登记到 ProcessRegistry，cancel/shutdown 统一强杀进程树。
 */

import type {
  CaseSnapshot,
  CompileResult,
  EngineRunContext,
  EngineRunRequest,
  EngineRunResult,
  ExecutionEngine,
  PlaywrightInfo,
} from './types.ts';
import { AutomationError } from './errors.ts';
import { PlaywrightTestRunner, type PlaywrightTestRunnerOptions } from './runner/testRunner.ts';
import { ProcessRegistry } from './process/process-tree.ts';

export interface EngineOptions {
  playwrightCliPath?: string;
  repoNodeModules?: string | null;
  htmlReport?: boolean;
  registry?: ProcessRegistry;
  /** 测试注入：自定义 runner（默认使用官方 CLI 实现）。 */
  runner?: PlaywrightTestRunner;
}

interface ActiveRun {
  controller: AbortController;
  startedAt: string;
}

export class AutomationExecutionEngine implements ExecutionEngine {
  private readonly registry: ProcessRegistry;
  private readonly runner: PlaywrightTestRunner;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private shuttingDown = false;

  constructor(options: EngineOptions = {}) {
    this.registry = options.registry ?? new ProcessRegistry();
    const runnerOptions: PlaywrightTestRunnerOptions = {
      registry: this.registry,
      ...(options.playwrightCliPath === undefined ? {} : { playwrightCliPath: options.playwrightCliPath }),
      ...(options.repoNodeModules === undefined ? {} : { repoNodeModules: options.repoNodeModules }),
      ...(options.htmlReport === undefined ? {} : { htmlReport: options.htmlReport }),
    };
    this.runner =
      options.runner ??
      new PlaywrightTestRunner(runnerOptions);
  }

  getRunner(): PlaywrightTestRunner {
    return this.runner;
  }

  getRegistry(): ProcessRegistry {
    return this.registry;
  }

  async compile(input: { caseSnapshot: CaseSnapshot }): Promise<CompileResult> {
    return this.runner.compile(input.caseSnapshot);
  }

  async run(request: EngineRunRequest, ctx: EngineRunContext): Promise<EngineRunResult> {
    if (this.shuttingDown) {
      throw new AutomationError('ENGINE_ERROR', '执行引擎正在关闭，拒绝新的运行');
    }
    if (this.activeRuns.has(request.runId)) {
      throw new AutomationError('VALIDATION_FAILED', `runId 已在执行中：${request.runId}`);
    }
    const controller = new AbortController();
    this.activeRuns.set(request.runId, { controller, startedAt: new Date().toISOString() });
    const combined = combineSignals(ctx.signal, controller.signal);
    const effectiveContext: EngineRunContext = {
      onPhase: ctx.onPhase,
      logger: ctx.logger,
      signal: combined,
    };
    try {
      return await this.runner.run(request, effectiveContext);
    } finally {
      this.activeRuns.delete(request.runId);
    }
  }

  /** 取消：abort 信号 → runProcess 监听并 taskkill /F /T 进程树；幂等。 */
  async cancel(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (active === undefined) return;
    active.controller.abort();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const active of this.activeRuns.values()) active.controller.abort();
    await this.registry.killAll();
  }

  async getPlaywrightInfo(): Promise<PlaywrightInfo> {
    return this.runner.getPlaywrightInfo();
  }
}

/** 合并两个 AbortSignal（Node 18+ 支持 AbortSignal.any；此处保留回退实现）。 */
export function combineSignals(external: AbortSignal, internal: AbortSignal): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([external, internal]);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (external.aborted || internal.aborted) {
    controller.abort();
  } else {
    external.addEventListener('abort', onAbort, { once: true });
    internal.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

/** 默认工厂：应用层通过它拿到执行引擎（apps/api 可注入 fake 实现做单测）。 */
export function createEngine(options: EngineOptions = {}): ExecutionEngine {
  return new AutomationExecutionEngine(options);
}