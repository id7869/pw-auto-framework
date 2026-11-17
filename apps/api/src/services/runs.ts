/**
 * 运行编排服务：状态机、并发队列、取消、超时、逐项结果与产物入库。
 * 契约：docs/api-contract.md §5、§0.5。
 *
 * 关键纪律
 * - 状态唯一口径：`passed ⇔ unexpected===0 && (failOnFlaky ? flaky===0 : true) && exitCode===0`（deriveRunStatus）；
 * - `cancelled`/`error` 由内部事件决定，不看退出码；
 * - 引擎（packages/automation）是唯一执行方，本服务只编排、入库、发事件；
 * - 不伪造任何结果：引擎缺失/异常 → 运行置 error，并写清机器可读错误码。
 */

import type { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import {
  ARTIFACT_CONTENT_TYPES,
  EMPTY_RUN_STATS,
  STREAM_TRUNCATE_BYTES,
  buildItemKey,
  caseIdFromItemKey,
  deriveRunStatus,
  isTerminalRunStatus,
  rowIndexFromItemKey,
  runOptionsSchema,
  validateStepColumns,
  type Artifact,
  type ArtifactKind,
  type ArtifactListQuery,
  type CreateRunRequest,
  type EnvironmentFingerprint,
  type ItemOutcome,
  type Page,
  type Run,
  type RunDiagnostics,
  type RunError,
  type RunItem,
  type RunItemAttempt,
  type RunItemListQuery,
  type RunListQuery,
  type RunOptions,
  type RunStats,
  type RunStatus,
  type StepTrace,
} from '@pw-auto/contracts';
import type {
  CaseSnapshot,
  EngineRunArtifact,
  EngineRunItem,
  EngineRunItemAttempt,
  EngineRunOptions,
  EngineRunRequest,
  EngineRunResult,
  ExecutionEngine,
} from '@pw-auto/automation';
import { withTransaction } from '../db/sql.ts';
import { AppError } from '../errors.ts';
import type { EngineHandle } from '../engine.ts';
import type { NlService } from './nl.ts';
import { newId } from '../ids.ts';
import { baseEnvironment, resolvePlaywrightCliPath } from '../official.ts';
import { assertWithinRoot, ensureDir, isWithinRoot, runWorkspaceDir, toRelativePosix } from '../paths.ts';
import { writeAudit } from '../repositories/audit.ts';
import * as caseRepo from '../repositories/cases.ts';
import * as datasetRepo from '../repositories/datasets.ts';
import { getIdempotency, saveIdempotency } from '../repositories/idempotency.ts';
import * as runRepo from '../repositories/runs.ts';
import type { ArtifactInsert } from '../repositories/runs.ts';
import * as suiteRepo from '../repositories/suites.ts';
import type { RunCaseSnapshot, RunSnapshot } from '../snapshot.ts';
import { hashError, isoNow, jsonText, sha256Hex, truncateUtf8 } from '../utils.ts';
import { RunEventBus, type RunEventListener } from './events.ts';

export interface RunServiceConfig {
  dataDir: string;
  runTimeoutMs: number;
  caseTimeoutMs: number;
  maxConcurrentRuns: number;
  keepRuns: number;
  queueLimit: number;
  browser: string;
  headed: boolean;
}

export interface RunServiceDeps {
  db: DatabaseSync;
  engine: EngineHandle;
  config: RunServiceConfig;
  log: (message: string) => void;
  /** NL 门禁（无 nl 的旧用例完全不受影响） */
  nl: NlService;
}

interface ActiveState {
  controller: AbortController;
  timedOut: boolean;
  cancelRequested: boolean;
  finalized: boolean;
  graceTimer: NodeJS.Timeout | null;
}

interface ExecuteOutcome {
  items: RunItem[];
  artifacts: ArtifactInsert[];
  stats: RunStats;
  exitCode: number | null;
  environment: EnvironmentFingerprint | null;
  reportPath: string | null;
  specPath: string | null;
  command: string[];
  warnings: string[];
  cancelled: boolean;
  error: RunError | null;
}

const CANCEL_GRACE_MS = 3000;
const DEFAULT_RUN_OPTIONS: RunOptions = {
  retries: 0,
  workers: 1,
  timeoutMs: 60000,
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',
  video: 'off',
  headed: false,
  browser: 'chromium',
  failOnFlaky: false,
  allowStaleNl: false,
};

export class RunService {
  private readonly db: DatabaseSync;
  private readonly engine: EngineHandle;
  private readonly config: RunServiceConfig;
  private readonly log: (message: string) => void;
  private readonly nl: NlService;
  private readonly bus = new RunEventBus();
  private readonly active = new Map<string, ActiveState>();
  private readonly playwrightCliPath = resolvePlaywrightCliPath();
  private pumping = false;
  /** 进程关闭后禁止再写库（避免 shutdown 后异步收尾造成「已关闭数据库」异常） */
  private closed = false;

  constructor(deps: RunServiceDeps) {
    this.db = deps.db;
    this.engine = deps.engine;
    this.config = deps.config;
    this.log = deps.log;
    this.nl = deps.nl;
    ensureDir(join(this.config.dataDir, 'runs'));
  }

  get eventBus(): RunEventBus {
    return this.bus;
  }

  subscribe(runId: string, listener: RunEventListener): () => void {
    return this.bus.subscribe(runId, listener);
  }

  /** 启动恢复：非终态置 error(RUN_INTERRUPTED)；按保留策略清理最旧运行（跳过基线引用） */
  recover(): void {
    const interrupted = runRepo.markInterruptedRuns(this.db, isoNow());
    if (interrupted.length > 0) {
      this.log(`[runs] 启动恢复：${interrupted.length} 个未完成运行已置为 error(RUN_INTERRUPTED)`);
    }
    const stale = runRepo.listRunIdsForRetention(this.db, this.config.keepRuns);
    for (const runId of stale) {
      runRepo.deleteRunCascade(this.db, runId);
      this.removeWorkspace(runId);
    }
    if (stale.length > 0) this.log(`[runs] 保留策略：清理 ${stale.length} 个最旧运行`);
  }

  private removeWorkspace(runId: string): void {
    const dir = runWorkspaceDir(this.config.dataDir, runId);
    try {
      if (isWithinRoot(join(this.config.dataDir, 'runs'), dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // 工作区清理失败不影响主流程
    }
  }

  // ── 创建运行 ────────────────────────────────────────────────────────────

  create(input: CreateRunRequest, idempotencyKey: string | null, actor: string): { run: Run; replayed: boolean } {
    // 幂等哈希覆盖**完整请求体**（target/datasetId/options/reason），options 先按 schema 归一化
    // （补齐默认值 + 丢弃未知键），保证「同体不同字段顺序」稳定命中重放。
    const normalizedOptions = runOptionsSchema.parse(input.options ?? {});
    const requestHash = sha256Hex(
      jsonText({
        target: input.target,
        datasetId: input.datasetId ?? null,
        options: normalizedOptions,
        reason: input.reason ?? null,
      }),
    );

    if (idempotencyKey !== null) {
      const existing = getIdempotency(this.db, idempotencyKey);
      if (existing) {
        if (existing.scope !== 'run' || existing.requestHash !== requestHash) {
          throw new AppError('IDEMPOTENCY_CONFLICT', '同一 Idempotency-Key 已被不同请求体使用，拒绝复用');
        }
        const found = runRepo.getRunById(this.db, existing.resourceId);
        if (found) return { run: found, replayed: true };
      }
    }

    const queuedCount = runRepo.countRunsInStatuses(this.db, ['queued']);
    if (queuedCount >= this.config.queueLimit) {
      throw new AppError('TOO_MANY_RUNS', `排队运行已达上限 ${this.config.queueLimit}，请等待当前运行结束`);
    }

    const snapshot = this.buildSnapshot(input);
    // NL 门禁（§12.4）：必须在建工作区/入队前拒绝；stale 运行需 options.allowStaleNl=true
    this.assertNlGate(input.target, normalizedOptions.allowStaleNl);
    const options: RunOptions = input.options ?? { ...DEFAULT_RUN_OPTIONS, timeoutMs: this.config.caseTimeoutMs };
    const runId = newId('run');
    const workspaceDir = ensureDir(runWorkspaceDir(this.config.dataDir, runId));
    assertWithinRoot(join(this.config.dataDir, 'runs'), workspaceDir, '运行工作区越界');
    const now = isoNow();
    const run: Run = {
      id: runId,
      kind: input.target.kind,
      caseId: input.target.kind === 'case' ? input.target.caseId : null,
      suiteId: input.target.kind === 'suite' ? input.target.suiteId : null,
      datasetId: input.datasetId ?? null,
      options,
      status: 'queued',
      queuePosition: null,
      requestedAt: now,
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      exitCode: null,
      stats: { ...EMPTY_RUN_STATS },
      itemsCount: 0,
      artifactsCount: 0,
      environment: baseEnvironment(options.browser),
      error: null,
      diagnostics: {
        playwrightCliPath: this.playwrightCliPath,
        command: [],
        specPath: null,
        reportPath: null,
        workspaceDir,
        warnings: this.engine.engine === null ? [this.engine.reason ?? '执行引擎不可用'] : [],
      },
      idempotencyKey,
      };

    withTransaction(this.db, () => {
      runRepo.insertRun(this.db, { run, snapshot, workspaceDir, idempotencyKey });
      if (idempotencyKey !== null) {
        saveIdempotency(this.db, {
          key: idempotencyKey,
          scope: 'run',
          requestHash,
          resourceId: runId,
          responseStatus: 202,
          createdAt: now,
        });
      }
    });

    writeAudit(this.db, {
      actor,
      action: 'run.create',
      target: runId,
      detail: {
        kind: run.kind,
        caseId: run.caseId,
        suiteId: run.suiteId,
        datasetId: run.datasetId,
        reason: input.reason ?? null,
      },
    });

    this.pump();
    return { run: this.requireRun(runId), replayed: false };
  }

  /** 固化运行快照：用例 + 数据集 enabled 行（套件运行逐 case 取默认数据集） */
  private assertNlGate(target: CreateRunRequest['target'], allowStaleNl: boolean): void {
    if (target.kind === 'case') {
      this.nl.gate(target.caseId, 'run', allowStaleNl);
      return;
    }
    const suite = suiteRepo.getSuiteById(this.db, target.suiteId);
    if (!suite) throw new AppError('NOT_FOUND', `套件不存在或已删除：${target.suiteId}`);
    for (const caseId of suite.caseIds) {
      this.nl.gate(caseId, 'run', allowStaleNl);
    }
  }

  private buildSnapshot(input: CreateRunRequest): RunSnapshot {
    if (input.target.kind === 'case') {
      const found = caseRepo.getCaseById(this.db, input.target.caseId);
      if (!found) throw new AppError('NOT_FOUND', `用例不存在或已删除：${input.target.caseId}`);
      return {
        kind: 'case',
        case: {
          caseId: found.id,
          name: found.name,
          mode: found.mode,
          steps: found.steps,
          code: found.code,
          tags: found.tags,
          dataset: this.buildDatasetSnapshot(found.id, found, input.datasetId),
        },
        suite: null,
      };
    }

    const suite = suiteRepo.getSuiteById(this.db, input.target.suiteId);
    if (!suite) throw new AppError('NOT_FOUND', `套件不存在或已删除：${input.target.suiteId}`);
    if (input.datasetId !== undefined) {
      throw new AppError('VALIDATION_FAILED', '套件运行不支持指定数据集（数据集是用例级绑定，套件内每个用例使用其默认数据集）', [
        { path: 'datasetId', message: '套件运行时必须省略' },
      ]);
    }
    const cases: RunCaseSnapshot[] = [];
    const missing: string[] = [];
    for (const caseId of suite.caseIds) {
      const found = caseRepo.getCaseById(this.db, caseId);
      if (!found) {
        missing.push(caseId);
        continue;
      }
      cases.push({
        caseId: found.id,
        name: found.name,
        mode: found.mode,
        steps: found.steps,
        code: found.code,
        tags: found.tags,
        dataset: this.buildDefaultDatasetSnapshot(found),
      });
    }
    if (missing.length > 0) {
      throw new AppError(
        'UNKNOWN_CASE',
        `套件内用例已被删除：${missing.join('、')}`,
        missing.map((id) => ({ path: 'suiteId', message: `用例不存在：${id}` })),
      );
    }
    return { kind: 'suite', case: null, suite: { suiteId: suite.id, name: suite.name, cases } };
  }

  private buildDatasetSnapshot(
    caseId: string,
    caseRecord: { steps: RunCaseSnapshot['steps']; mode: RunCaseSnapshot['mode'] },
    datasetId: string | undefined,
  ): RunCaseSnapshot['dataset'] {
    if (datasetId === undefined) return null;

    const dataset = datasetRepo.getDatasetById(this.db, datasetId);
    if (!dataset) throw new AppError('NOT_FOUND', `数据集不存在或已删除：${datasetId}`);
    if (dataset.caseId !== caseId) {
      throw new AppError('VALIDATION_FAILED', '数据集不属于该用例', [{ path: 'datasetId', message: '用例与数据集不匹配' }]);
    }
    const rows = datasetRepo.listEnabledRows(this.db, dataset.id);
    if (rows.length === 0) throw new AppError('EMPTY_DATASET', '数据集没有启用行（全部 disabled），无法执行数据驱动运行');

    if (caseRecord.mode === 'steps') {
      const issues = validateStepColumns(caseRecord.steps, dataset.columns);
      if (issues.length > 0) {
        throw new AppError(
          'UNKNOWN_COLUMN',
          issues[0]?.message ?? '步骤引用了数据集不存在的列',
          issues.map((issue) => ({ path: issue.path, message: issue.message })),
        );
      }
    }

    return {
      id: dataset.id,
      name: dataset.name,
      columns: dataset.columns,
      rows: rows.map((row) => ({ rowIndex: row.rowIndex, data: row.data })),
    };
  }

  /** 套件内单 case：有默认数据集且存在 enabled 行 → 数据驱动；否则单次执行 */
  private buildDefaultDatasetSnapshot(caseRecord: {
    id: string;
    steps: RunCaseSnapshot['steps'];
    mode: RunCaseSnapshot['mode'];
  }): RunCaseSnapshot['dataset'] {
    const dataset = datasetRepo.getFirstDatasetForCase(this.db, caseRecord.id);
    if (!dataset) return null;
    const rows = datasetRepo.listEnabledRows(this.db, dataset.id);
    if (rows.length === 0) return null;
    if (caseRecord.mode === 'steps') {
      const issues = validateStepColumns(caseRecord.steps, dataset.columns);
      if (issues.length > 0) {
        throw new AppError(
          'UNKNOWN_COLUMN',
          `用例 ${caseRecord.id} 的步骤引用了其数据集不存在的列`,
          issues.map((issue) => ({ path: issue.path, message: issue.message })),
        );
      }
    }
    return {
      id: dataset.id,
      name: dataset.name,
      columns: dataset.columns,
      rows: rows.map((row) => ({ rowIndex: row.rowIndex, data: row.data })),
    };
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  list(query: RunListQuery): Page<Run> {
    return runRepo.listRuns(this.db, query);
  }

  requireRun(runId: string): Run {
    const found = runRepo.getRunById(this.db, runId);
    if (!found) throw new AppError('NOT_FOUND', `运行不存在：${runId}`);
    return found;
  }

  items(runId: string, query: RunItemListQuery): Page<RunItem> {
    this.requireRun(runId);
    return runRepo.listRunItems(this.db, runId, query);
  }

  item(runId: string, itemKey: string): RunItem {
    this.requireRun(runId);
    const found = runRepo.getRunItemByKey(this.db, runId, itemKey);
    if (!found) throw new AppError('NOT_FOUND', `运行项不存在：${itemKey}`);
    return found;
  }

  artifacts(runId: string, query: ArtifactListQuery): Page<Artifact> {
    this.requireRun(runId);
    return runRepo.listArtifacts(this.db, runId, query);
  }

  /** 产物内容定位：DB 登记 + 工作区前缀双重校验（api-contract §5.5） */
  artifactFile(runId: string, artifactId: string): { artifact: Artifact; absolutePath: string } {
    const found = runRepo.getStoredArtifact(this.db, runId, artifactId);
    if (!found) throw new AppError('NOT_FOUND', `产物不存在：${artifactId}`);
    const stored = runRepo.getStoredRun(this.db, runId);
    if (!stored) throw new AppError('NOT_FOUND', `运行不存在：${runId}`);
    const absolute = assertWithinRoot(
      stored.workspaceDir,
      isAbsolute(found.relPath) ? found.relPath : join(stored.workspaceDir, found.relPath),
      '产物路径越出运行工作区，已拒绝',
    );
    return { artifact: found.artifact, absolutePath: absolute };
  }

  // ── 取消 ────────────────────────────────────────────────────────────────

  async cancel(runId: string, actor: string): Promise<{ run: Run; replayed: boolean }> {
    const current = this.requireRun(runId);
    if (isTerminalRunStatus(current.status)) return { run: current, replayed: true };

    writeAudit(this.db, { actor, action: 'run.cancel', target: runId });

    if (current.status === 'queued') {
      this.finalizeTerminal(runId, {
        status: 'cancelled',
        error: null,
        stats: { ...EMPTY_RUN_STATS },
        exitCode: null,
        warnings: ['运行在排队阶段被取消（未开始执行）'],
      });
      return { run: this.requireRun(runId), replayed: false };
    }

    runRepo.setCancelRequested(this.db, runId, isoNow());
    this.bus.publish(runId, 'run.updated', this.requireRun(runId));

    const state = this.active.get(runId);
    if (!state) {
      this.finalizeTerminal(runId, {
        status: 'cancelled',
        error: null,
        stats: current.stats,
        exitCode: current.exitCode,
        warnings: ['取消时未找到运行内存态，已按已产出结果收尾'],
      });
      return { run: this.requireRun(runId), replayed: false };
    }

    state.cancelRequested = true;
    state.controller.abort();
    if (this.engine.engine) {
      try {
        await this.engine.engine.cancel(runId);
      } catch (error) {
        this.log(`[runs] 引擎取消回调失败（已继续强停）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.scheduleForcedFinalize(runId, 'cancel');
    return { run: this.requireRun(runId), replayed: false };
  }

  // ── 队列与执行 ──────────────────────────────────────────────────────────

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let guard = 0;
      while (this.active.size < this.config.maxConcurrentRuns && guard < 64) {
        guard += 1;
        const next = runRepo.listQueuedRuns(this.db)[0];
        if (!next) break;
        this.startRun(next.id);
      }
      this.refreshQueuePositions();
    } finally {
      this.pumping = false;
    }
  }

  private refreshQueuePositions(): void {
    runRepo.listQueuedRuns(this.db).forEach((queued, index) => {
      runRepo.setQueuePosition(this.db, queued.id, index + 1);
    });
  }

  private startRun(runId: string): void {
    const stored = runRepo.getStoredRun(this.db, runId);
    if (!stored) return;
    if (stored.run.status !== 'queued') return;

    const controller = new AbortController();
    const state: ActiveState = { controller, timedOut: false, cancelRequested: false, finalized: false, graceTimer: null };
    this.active.set(runId, state);
    runRepo.markRunRunning(this.db, runId, isoNow());
    this.bus.publish(runId, 'run.updated', this.requireRun(runId));
    this.log(`[runs] 开始运行 ${runId}（kind=${stored.run.kind}）`);

    const timeoutTimer = setTimeout(() => {
      if (state.finalized) return;
      state.timedOut = true;
      this.log(`[runs] 运行 ${runId} 超时（>${this.config.runTimeoutMs}ms），开始中止`);
      state.controller.abort();
      if (this.engine.engine) {
        void Promise.resolve(this.engine.engine.cancel(runId)).catch(() => undefined);
      }
      this.scheduleForcedFinalize(runId, 'timeout');
    }, this.config.runTimeoutMs);
    timeoutTimer.unref();

    void this.execute(runId, stored, state).finally(() => clearTimeout(timeoutTimer));
  }

  private scheduleForcedFinalize(runId: string, reason: 'cancel' | 'timeout'): void {
    const state = this.active.get(runId);
    if (!state || state.finalized) return;
    if (state.graceTimer) clearTimeout(state.graceTimer);
    state.graceTimer = setTimeout(() => {
      if (state.finalized) return;
      const current = runRepo.getRunById(this.db, runId);
      if (!current || isTerminalRunStatus(current.status)) return;
      this.finalizeTerminal(runId, {
        status: reason === 'timeout' ? 'error' : 'cancelled',
        error:
          reason === 'timeout'
            ? {
                code: 'RUN_TIMEOUT',
                message: `运行超过 ${this.config.runTimeoutMs}ms 未结束，已被强制中止（引擎未在 3s 内响应取消）`,
              }
            : null,
        stats: current.stats,
        exitCode: current.exitCode,
        warnings: [reason === 'timeout' ? '运行超时强停' : '取消强停（引擎未在 3s 内响应）'],
      });
    }, CANCEL_GRACE_MS);
    state.graceTimer.unref();
  }

  private async execute(runId: string, stored: runRepo.StoredRun, state: ActiveState): Promise<void> {
    let outcome: ExecuteOutcome;
    try {
      outcome = await this.executeSnapshot(stored, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = {
        items: [],
        artifacts: [],
        stats: { ...EMPTY_RUN_STATS },
        exitCode: null,
        environment: null,
        reportPath: null,
        specPath: null,
        command: [],
        warnings: [],
        cancelled: false,
        error: { code: 'ENGINE_ERROR', message: `执行引擎异常：${message}` },
      };
    }
    this.finalizeRun(runId, stored, state, outcome);
  }

  private async executeSnapshot(stored: runRepo.StoredRun, state: ActiveState): Promise<ExecuteOutcome> {
    const engine: ExecutionEngine | null = this.engine.engine;
    const base: ExecuteOutcome = {
      items: [],
      artifacts: [],
      stats: { ...EMPTY_RUN_STATS },
      exitCode: null,
      environment: null,
      reportPath: null,
      specPath: null,
      command: [],
      warnings: [],
      cancelled: false,
      error: null,
    };
    if (engine === null) {
      return {
        ...base,
        error: {
          code: 'ENGINE_ERROR',
          message: this.engine.reason ?? '执行引擎不可用（官方执行适配由 packages/automation 提供）',
        },
      };
    }

    const cases = this.casesOf(stored.snapshot);
    if (cases.length === 0) {
      return { ...base, error: { code: 'ENGINE_ERROR', message: '运行快照为空（用例或套件成员已全部缺失）' } };
    }

    const engineOptions = this.buildEngineOptions(stored.run.options);
    let exitCode: number | null = null;
    let allExitZero = true;
    // F-SUITE-1：任一成员用例「引擎级失败」必须反映到 run 终态，且未执行的成员要在 items 中可见。
    const caseErrors: { caseId: string; code: string; message: string; detail?: unknown }[] = [];

    for (let seq = 0; seq < cases.length; seq += 1) {
      const caseSnapshot = cases[seq];
      if (!caseSnapshot) continue;
      if (state.controller.signal.aborted) return { ...base, cancelled: true };

      const caseWorkspace = ensureDir(join(stored.workspaceDir, `case-${seq}`));
      assertWithinRoot(stored.workspaceDir, caseWorkspace, '用例工作区越界');

      let result: EngineRunResult;
      try {
        const request = this.buildEngineRequest(stored.run.id, caseWorkspace, caseSnapshot, engineOptions);
        result = await engine.run(request, {
          onPhase: (phase) => this.bus.publish(stored.run.id, 'run.log', { message: `phase=${phase} case=${caseSnapshot.caseId}` }),
          signal: state.controller.signal,
          logger: (message) => this.bus.publish(stored.run.id, 'run.log', { message }),
        });
      } catch (error) {
        if (state.controller.signal.aborted) return { ...base, cancelled: true };
        const mapped = adapterErrorOf(error);
        caseErrors.push({ caseId: caseSnapshot.caseId, code: mapped.code, message: mapped.message });
        base.warnings.push(`用例 ${caseSnapshot.caseId} 执行失败（${mapped.code}）：${mapped.message}`);
        base.items = [
          ...base.items,
          ...this.syntheticMissingItems(caseSnapshot, mapped.code, `官方执行失败：${mapped.message}`, new Set<string>()),
        ];
        continue;
      }

      base.items = [...base.items, ...this.toRunItems(result.items, caseSnapshot.caseId)];
      base.stats = mergeStats(base.stats, result.stats);
      if (exitCode === null) exitCode = result.exitCode;
      if (result.exitCode !== 0) allExitZero = false;

      const collected = this.collectArtifacts(stored.workspaceDir, caseWorkspace, `case-${seq}`, result.artifacts);
      base.artifacts = [...base.artifacts, ...collected.artifacts];
      base.warnings = [...base.warnings, ...collected.warnings];

      // 引擎自带诊断（官方命令回显 / 编译产物路径 / 报告路径）：优先采用，不自行编造。
      // 注意：失败成员的 command 通常为 []，不得覆盖此前成功成员已回显的命令。
      const engineDiagnostics = result.diagnostics;
      if (engineDiagnostics) {
        if (arrayOfStrings(engineDiagnostics.command) && engineDiagnostics.command.length > 0 && base.command.length === 0) {
          base.command = [...engineDiagnostics.command];
        }
        if (typeof engineDiagnostics.specPath === 'string' && engineDiagnostics.specPath !== '') {
          base.specPath = base.specPath ?? engineDiagnostics.specPath;
        }
        if (Array.isArray(engineDiagnostics.warnings)) {
          base.warnings = [...base.warnings, ...engineDiagnostics.warnings.filter((item): item is string => typeof item === 'string')];
        }
      }

      if (typeof result.reportPath === 'string' && result.reportPath !== '') {
        const reportAbs = isAbsolute(result.reportPath)
          ? assertIfWithin(stored.workspaceDir, result.reportPath)
          : assertIfWithin(stored.workspaceDir, join(stored.workspaceDir, `case-${seq}`, result.reportPath));
        if (reportAbs) {
          base.reportPath = base.reportPath ?? reportAbs;
          const reportArtifact = fileArtifact('json-report', reportAbs, stored.workspaceDir, null);
          if (reportArtifact && !base.artifacts.some((item) => item.relPath === reportArtifact.relPath)) {
            base.artifacts.push(reportArtifact);
          }
        } else {
          base.warnings.push('官方 JSON 报告位于运行工作区之外，已跳过索引（不允许越界读取）');
        }
      }

      if (result.environment) base.environment = result.environment;

      // 逐成员进度落库：running 期间轮询 GET /runs/{id} 即可看到合并 stats 单调增长；
      // 终态仍由 finishRun 一次性收口（items/artifacts 在终态统一入库）。
      runRepo.saveRunProgress(this.db, stored.run.id, {
        stats: base.stats,
        ...(base.environment === null ? {} : { environment: base.environment }),
      });
      const progressRun = runRepo.getRunById(this.db, stored.run.id);
      if (progressRun) this.bus.publish(stored.run.id, 'run.updated', progressRun);

      if (result.status === 'cancelled') return { ...base, cancelled: true };
      if (result.status === 'error') {
        const engineError: RunError = result.error ?? {
          code: 'ENGINE_ERROR',
          message: '官方执行返回 error 但未提供原因',
        };
        caseErrors.push({
          caseId: caseSnapshot.caseId,
          code: engineError.code,
          message: engineError.message,
          ...(engineError.detail === undefined ? {} : { detail: engineError.detail }),
        });
        base.warnings.push(`用例 ${caseSnapshot.caseId} 引擎级失败（${engineError.code}）：${engineError.message}`);
        const producedItemKeys = new Set(
          this.toRunItems(result.items, caseSnapshot.caseId).map((item) => item.itemKey),
        );
        base.items = [
          ...base.items,
          ...this.syntheticMissingItems(
            caseSnapshot,
            engineError.code,
            `引擎级失败：${engineError.message}`,
            producedItemKeys,
          ),
        ];
        continue;
      }
    }

    const outcome: ExecuteOutcome = { ...base, exitCode: allExitZero ? 0 : exitCode };
    if (caseErrors.length === 0) return outcome;

    const first = caseErrors[0] as (typeof caseErrors)[number];
    const detailOf = (item: (typeof caseErrors)[number]): string =>
      `${item.caseId}（${item.code}：${clipMessage(item.message)}）`;
    const message =
      stored.snapshot.kind === 'case'
        ? `用例执行失败：${detailOf(first)}`
        : `套件中 ${caseErrors.length} 个成员用例执行失败：${caseErrors.map(detailOf).join('、')}；已完成的成员结果已保留`;
    return { ...outcome, error: { code: first.code, message, detail: { cases: caseErrors } } };
  }

  /**
   * 为「未产生官方结果」的成员补一条 missing 项：让缺失在 /items 与回归对比中可见，
   * 而不是静默消失（F-SUITE-1）。已产出 itemKey 不重复插入（避免覆盖真实结果）。
   */
  private syntheticMissingItems(
    caseSnapshot: RunCaseSnapshot,
    code: string,
    message: string,
    existingItemKeys: ReadonlySet<string>,
  ): RunItem[] {
    const rowIndexes: (number | null)[] =
      caseSnapshot.dataset !== null && caseSnapshot.dataset.rows.length > 0
        ? caseSnapshot.dataset.rows.map((row) => row.rowIndex)
        : [null];
    const startTime = isoNow();
    const items: RunItem[] = [];
    for (const rowIndex of rowIndexes) {
      const itemKey = buildItemKey(caseSnapshot.caseId, rowIndex);
      if (existingItemKeys.has(itemKey)) continue;
      items.push({
        itemKey,
        caseId: caseSnapshot.caseId,
        rowIndex,
        title: `${caseSnapshot.name}${rowIndex === null ? '' : ` [row:${rowIndex}]`}（未执行：${code}）`,
        projectName: null,
        // 官方报告里没有该项 → missing；attempt 记录失败原因，便于定位是哪个成员未成功执行
        outcome: 'missing',
        durationMs: 0,
        attempts: [
          {
            attempt: 0,
            status: 'failed',
            durationMs: 0,
            startTime,
            error: { message: `${code}: ${message}` },
            errorHash: hashError(message),
            steps: [],
            attachments: [],
            stdout: '',
            stderr: '',
            truncated: false,
          },
        ],
      });
    }
    return items;
  }

  private casesOf(snapshot: RunSnapshot): RunCaseSnapshot[] {
    if (snapshot.kind === 'case') return snapshot.case ? [snapshot.case] : [];
    return snapshot.suite?.cases ?? [];
  }

  private buildEngineOptions(options: RunOptions): EngineRunOptions {
    return {
      timeoutMs: this.config.runTimeoutMs,
      caseTimeoutMs: options.timeoutMs,
      retries: options.retries,
      workers: options.workers,
      trace: options.trace,
      screenshot: options.screenshot,
      video: options.video,
      headed: options.headed || this.config.headed,
      browser: options.browser,
      failOnFlaky: options.failOnFlaky,
    };
  }

  private buildEngineRequest(
    runId: string,
    caseWorkspace: string,
    caseSnapshot: RunCaseSnapshot,
    options: EngineRunOptions,
  ): EngineRunRequest {
    // 官方 CaseSnapshot 已原生支持数据集行（rows/columns/datasetId），直接透传（引擎负责编译与列校验）
    const snapshotPayload: CaseSnapshot = {
      caseId: caseSnapshot.caseId,
      name: caseSnapshot.name,
      mode: caseSnapshot.mode,
      steps: caseSnapshot.steps,
      code: caseSnapshot.code,
      tags: caseSnapshot.tags,
      rows: caseSnapshot.dataset?.rows ?? [],
      columns: caseSnapshot.dataset?.columns ?? [],
      datasetId: caseSnapshot.dataset?.id ?? null,
    };

    return {
      runId,
      workspaceDir: caseWorkspace,
      dataRoot: this.config.dataDir,
      caseSnapshot: snapshotPayload,
      options,
    };
  }

  private environmentOf(result: EngineRunResult): EnvironmentFingerprint | null {
    const env = result.environment as unknown;
    if (env === null || typeof env !== 'object') return null;
    const record = env as Partial<Record<keyof EnvironmentFingerprint, unknown>>;
    return {
      node: typeof record.node === 'string' ? record.node : process.versions.node,
      playwright: typeof record.playwright === 'string' ? record.playwright : '1.65.0',
      browser: typeof record.browser === 'string' ? record.browser : this.config.browser,
      os: typeof record.os === 'string' ? record.os : `${process.platform}-${process.arch}`,
      timezone: typeof record.timezone === 'string' ? record.timezone : (Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown'),
    };
  }

  private toRunItems(items: readonly EngineRunItem[] | undefined, fallbackCaseId: string): RunItem[] {
    if (!items) return [];
    return items.map((item) => {
      const caseId = item.caseId || caseIdFromItemKey(item.itemKey) || fallbackCaseId;
      const rowIndex = item.rowIndex ?? rowIndexFromItemKey(item.itemKey);
      return {
        itemKey: item.itemKey || buildItemKey(caseId, rowIndex),
        caseId,
        rowIndex,
        title: item.title,
        projectName: item.projectName ?? null,
        outcome: item.outcome as ItemOutcome,
        durationMs: item.durationMs,
        attempts: (item.attempts ?? []).map((attempt) => this.toAttempt(attempt)),
      };
    });
  }

  private toAttempt(attempt: EngineRunItemAttempt): RunItemAttempt {
    const raw = attempt as unknown as Record<string, unknown>;
    const error = attempt.error
      ? {
          message: attempt.error.message,
          // 官方 error.snippet（JSON 报告 results[].error.snippet）原样保留，便于定位
          ...(attempt.error.snippet === undefined ? {} : { snippet: attempt.error.snippet }),
          ...(attempt.error.stack === undefined ? {} : { stack: attempt.error.stack }),
          ...(attempt.error.location === undefined ? {} : { location: attempt.error.location }),
        }
      : null;
    const engineSteps = Array.isArray(attempt.steps) ? attempt.steps : Array.isArray(raw['steps']) ? (raw['steps'] as StepTrace[]) : [];
    const engineAttachments = Array.isArray(attempt.attachments)
      ? attempt.attachments
      : Array.isArray(raw['attachments'])
        ? (raw['attachments'] as { name: string; contentType: string; artifactId: string | null }[])
        : [];
    const stdoutRaw = typeof attempt.stdout === 'string' ? attempt.stdout : typeof raw['stdout'] === 'string' ? raw['stdout'] : '';
    const stderrRaw = typeof attempt.stderr === 'string' ? attempt.stderr : typeof raw['stderr'] === 'string' ? raw['stderr'] : '';
    const stdout = truncateUtf8(stdoutRaw, STREAM_TRUNCATE_BYTES);
    const stderr = truncateUtf8(stderrRaw, STREAM_TRUNCATE_BYTES);
    const engineErrors = Array.isArray(attempt.errors)
      ? attempt.errors.map((item) => ({
          message: item.message,
          ...(item.stack === undefined ? {} : { stack: item.stack }),
          ...(item.snippet === undefined ? {} : { snippet: item.snippet }),
          ...(item.location === undefined ? {} : { location: item.location }),
        }))
      : undefined;
    return {
      attempt: attempt.attempt,
      status: attempt.status,
      durationMs: attempt.durationMs,
      startTime: attempt.startTime,
      error,
      ...(engineErrors === undefined ? {} : { errors: engineErrors }),
      errorHash: typeof attempt.errorHash === 'string' ? attempt.errorHash : hashError(attempt.error?.message),
      steps: engineSteps as StepTrace[],
      attachments: engineAttachments.map((attachment) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        artifactId: attachment.artifactId ?? null,
      })),
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: Boolean(attempt.truncated) || stdout.truncated || stderr.truncated,
    };
  }

  private collectArtifacts(
    runWorkspace: string,
    _caseWorkspace: string,
    casePrefix: string,
    artifacts: readonly EngineRunArtifact[] | undefined,
  ): { artifacts: ArtifactInsert[]; warnings: string[] } {
    const inserted: ArtifactInsert[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();

    for (const artifact of artifacts ?? []) {
      const relPathRaw = artifact.relPath ?? '';
      if (relPathRaw === '') {
        warnings.push(`产物缺少相对路径（${casePrefix}），已跳过索引`);
        continue;
      }
      let runRelative: string;
      if (isAbsolute(relPathRaw)) {
        if (!isWithinRoot(runWorkspace, relPathRaw)) {
          warnings.push(`产物路径越出运行工作区，已跳过索引：${basename(relPathRaw)}`);
          continue;
        }
        runRelative = toRelativePosix(runWorkspace, relPathRaw);
      } else {
        runRelative = `${casePrefix}/${relPathRaw.split('\\').join('/')}`;
      }
      if (seen.has(runRelative)) continue;
      seen.add(runRelative);

      const kind = artifact.kind as ArtifactKind;
      const sha256 = /^[a-f0-9]{64}$/.test(artifact.sha256)
        ? artifact.sha256
        : sha256Hex(`${runRelative}:${artifact.sizeBytes}`);
      const rawItemKey = (artifact as unknown as Record<string, unknown>)['itemKey'];
      inserted.push({
        id: newId('artifact'),
        itemKey: typeof artifact.itemKey === 'string' ? artifact.itemKey : typeof rawItemKey === 'string' ? rawItemKey : null,
        kind,
        relPath: runRelative,
        fileName:
          typeof artifact.fileName === 'string' && artifact.fileName !== '' ? artifact.fileName : basename(runRelative),
        sizeBytes: artifact.sizeBytes,
        sha256,
        contentType: artifact.contentType || ARTIFACT_CONTENT_TYPES[kind] || 'application/octet-stream',
        createdAt: typeof artifact.createdAt === 'string' && artifact.createdAt !== '' ? artifact.createdAt : isoNow(),
      });
    }

    return { artifacts: inserted, warnings };
  }

  private finalizeRun(runId: string, stored: runRepo.StoredRun, state: ActiveState, outcome: ExecuteOutcome): void {
    if (state.finalized || this.closed) return;
    state.finalized = true;
    if (state.graceTimer) clearTimeout(state.graceTimer);

    const failOnFlaky = stored.run.options.failOnFlaky;
    let status: RunStatus;
    let error = outcome.error;
    if (state.timedOut) {
      status = 'error';
      error = { code: 'RUN_TIMEOUT', message: `运行超过 ${this.config.runTimeoutMs}ms 未结束，已中止` };
    } else if (state.cancelRequested || outcome.cancelled) {
      status = 'cancelled';
      error = null;
    } else if (outcome.error) {
      status = 'error';
    } else {
      status = deriveRunStatus({ stats: outcome.stats, exitCode: outcome.exitCode, failOnFlaky });
    }

    const diagnostics: RunDiagnostics = {
      playwrightCliPath: stored.run.diagnostics.playwrightCliPath || this.playwrightCliPath,
      command: outcome.command,
      specPath: outcome.specPath,
      reportPath: outcome.reportPath,
      workspaceDir: stored.workspaceDir,
      warnings: [...stored.run.diagnostics.warnings, ...outcome.warnings],
    };

    withTransaction(this.db, () => {
      runRepo.insertRunItems(this.db, runId, outcome.items);
      runRepo.insertArtifacts(this.db, runId, outcome.artifacts);
      runRepo.finishRun(this.db, runId, {
        status,
        finishedAt: isoNow(),
        exitCode: outcome.exitCode,
        stats: outcome.stats,
        error,
        environment: outcome.environment ?? undefined,
        diagnostics,
      });
    });

    this.active.delete(runId);
    const run = runRepo.getRunById(this.db, runId);
    if (run) this.bus.publish(runId, 'run.updated', run);
    this.log(`[runs] 运行结束 ${runId} status=${status}`);
    this.pump();
  }

  /** 不经引擎直接落终态（排队取消 / 强停收尾） */
  private finalizeTerminal(
    runId: string,
    patch: { status: RunStatus; error: RunError | null; stats: RunStats; exitCode: number | null; warnings: string[] },
  ): void {
    if (this.closed) return;
    const stored = runRepo.getStoredRun(this.db, runId);
    if (!stored) return;
    const state = this.active.get(runId);
    if (state) {
      state.finalized = true;
      if (state.graceTimer) clearTimeout(state.graceTimer);
    }
    this.active.delete(runId);
    withTransaction(this.db, () => {
      runRepo.finishRun(this.db, runId, {
        status: patch.status,
        finishedAt: isoNow(),
        exitCode: patch.exitCode,
        stats: patch.stats,
        error: patch.error,
        diagnostics: { ...stored.run.diagnostics, warnings: [...stored.run.diagnostics.warnings, ...patch.warnings] },
      });
    });
    const run = runRepo.getRunById(this.db, runId);
    if (run) this.bus.publish(runId, 'run.updated', run);
    this.log(`[runs] 运行结束 ${runId} status=${patch.status}（无引擎收尾）`);
    this.pump();
  }

  /** 进程退出：中止活动运行并解绑引擎（状态由下次启动的 recover 收尾） */
  shutdown(): void {
    this.closed = true;
    for (const [runId, state] of this.active) {
      state.controller.abort();
      if (this.engine.engine) void Promise.resolve(this.engine.engine.cancel(runId)).catch(() => undefined);
      if (state.graceTimer) clearTimeout(state.graceTimer);
    }
    this.active.clear();
    this.bus.clear();
  }
}

function mergeStats(a: RunStats, b: RunStats): RunStats {  return {
    expected: a.expected + b.expected,
    unexpected: a.unexpected + b.unexpected,
    flaky: a.flaky + b.flaky,
    skipped: a.skipped + b.skipped,
    durationMs: a.durationMs + b.durationMs,
  };
}

function assertIfWithin(root: string, candidate: string): string | null {
  return isWithinRoot(root, candidate) ? candidate : null;
}

function arrayOfStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 从 automation 抛出的错误里取出机器可读 code（AutomationError 与 api-contract 同名） */
function adapterErrorOf(error: unknown): { code: string; message: string } {
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
  const rawCode = record?.['code'];
  const message =
    (typeof record?.['message'] === 'string' && record['message'] !== '' && record['message']) ||
    (error instanceof Error ? error.message : String(error));
  return {
    code: typeof rawCode === 'string' && rawCode !== '' ? rawCode : 'ENGINE_ERROR',
    message,
  };
}

/** 运行级错误文案里限制单个成员消息长度，避免把整段堆栈塞进 message（详情在 error.detail.cases） */
function clipMessage(message: string, maxLength = 300): string {
  const singleLine = message.replace(/\s+/g, ' ').trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength)}…`;
}

/** 把工作区内的文件登记为产物（只读一次、大小/哈希写实，不伪造） */
export function fileArtifact(
  kind: ArtifactKind,
  absolutePath: string,
  runWorkspace: string,
  itemKey: string | null,
): ArtifactInsert | null {
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) return null;
    const relPath = toRelativePosix(runWorkspace, absolutePath);
    return {
      id: newId('artifact'),
      itemKey,
      kind,
      relPath,
      fileName: basename(relPath),
      sizeBytes: stat.size,
      sha256: sha256Hex(readFileSync(absolutePath)),
      contentType: ARTIFACT_CONTENT_TYPES[kind],
      createdAt: isoNow(),
    };
  } catch {
    return null;
  }
}