/**
 * NL 生成任务服务（R6）：7 态状态机 + 租约/超时/互斥 + submit 校验 + accept 人审门禁。
 * 契约：api-contract §12.3；设计：docs/NL_AGENT_SKILL_DESIGN.md §2.2/§4.2。
 *
 * 三方边界：本服务**不做生成**（不调模型）；harness 通过 claim → submit 提交结果，
 * 人工/上层通过 accept 才写入用例（唯一写 steps 的路径）。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  splitStepIssues,
  validateStepColumns,
  validateSteps,
  type AcceptNlGenerationRequest,
  type Case,
  type ClaimNlGenerationRequest,
  type CreateNlGenerationRequest,
  type NlGeneration,
  type NlGenerationListQuery,
  type NlGenerationQueueQuery,
  type NlSourceRecord,
  type NlWarning,
  type Page,
  type RejectNlGenerationRequest,
  type Step,
  type StepOrigin,
  type SubmitNlGenerationRequest,
} from '@pw-auto/contracts';
import type { AppConfig } from '../config.ts';
import { withTransaction } from '../db/sql.ts';
import { AppError } from '../errors.ts';
import { newId } from '../ids.ts';
import { nlSourceHash } from '../nl/model.ts';
import * as caseRepo from '../repositories/cases.ts';
import * as datasetRepo from '../repositories/datasets.ts';
import * as nlRepo from '../repositories/nl-generations.ts';
import { writeAudit } from '../repositories/audit.ts';
import { isoNow, sha256Hex } from '../utils.ts';
import type { NlService } from './nl.ts';

export interface NlGenerationServiceDeps {
  db: DatabaseSync;
  config: AppConfig;
  nl: NlService;
}

function nowMs(): number {
  return Date.now();
}

function isoPlusMs(ms: number): string {
  return new Date(nowMs() + ms).toISOString();
}

function isExpired(iso: string | null): boolean {
  return iso !== null && iso !== '' && Date.parse(iso) <= nowMs();
}

function canonicalStepOrigin(stepOrigin: unknown): unknown {
  if (stepOrigin === null || stepOrigin === undefined || typeof stepOrigin !== 'object') return null;
  const entries = Object.entries(stepOrigin as Record<string, { nlLine?: unknown }>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stepId, origin]) => [stepId, { nlLine: origin?.nlLine ?? null }]);
  return Object.fromEntries(entries);
}

function contentHashOf(input: {
  steps?: unknown;
  code?: string | null;
  warnings?: unknown;
  generatorVersion?: string;
  stepOrigin?: unknown;
}): string {
  return sha256Hex(
    JSON.stringify({
      steps: input.steps ?? null,
      code: input.code ?? null,
      warnings: input.warnings ?? [],
      generatorVersion: input.generatorVersion ?? null,
      // 行号映射按 stepId 排序后参与哈希：同内容不同键序也应判定相同（F1）
      stepOrigin: canonicalStepOrigin(input.stepOrigin),
    }),
  );
}

export class NlGenerationService {
  private readonly db: DatabaseSync;
  private readonly config: AppConfig;
  private readonly nl: NlService;

  constructor(deps: NlGenerationServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.nl = deps.nl;
  }

  require(caseId: string, generationId: string): NlGeneration {
    this.recoverExpired();
    const generation = nlRepo.getNlGenerationById(this.db, generationId);
    if (!generation || generation.caseId !== caseId) {
      throw new AppError('NOT_FOUND', `NL 生成任务不存在：${generationId}`);
    }
    return generation;
  }

  get(generationId: string): NlGeneration {
    // 请求级运行期回收（F2）：不依赖进程重启；过期 running 回 queued / 超时 queued 置 failed
    this.recoverExpired();
    const generation = nlRepo.getNlGenerationById(this.db, generationId);
    if (!generation) throw new AppError('NOT_FOUND', `NL 生成任务不存在：${generationId}`);
    return generation;
  }

  listForCase(caseId: string, query: NlGenerationListQuery): Page<NlGeneration> {
    this.recoverExpired();
    this.nl.requireCase(caseId);
    return nlRepo.listNlGenerationsForCase(this.db, caseId, query);
  }

  queue(query: NlGenerationQueueQuery): Page<NlGeneration> {
    this.recoverExpired();
    const statuses =
      query.status === undefined
        ? ['queued', 'running', 'ready']
        : query.status.split(',').map((item) => item.trim()).filter(Boolean);
    const allowed = new Set(['queued', 'running', 'ready', 'accepted', 'rejected', 'failed', 'cancelled']);
    const invalid = statuses.filter((status) => !allowed.has(status));
    if (invalid.length > 0) {
      throw new AppError('VALIDATION_FAILED', `未知生成任务状态：${invalid.join(', ')}`, [
        { path: 'status', message: '非法状态值' },
      ]);
    }
    return nlRepo.listNlQueue(this.db, statuses, query);
  }

  create(caseId: string, input: CreateNlGenerationRequest, actor: string): NlGeneration {
    this.recoverExpired();
    const found = this.nl.requireCase(caseId);
    const stored = caseRepo.getCaseNlRecord(this.db, caseId);
    if (!stored || stored.record === null || stored.record.text.trim() === '') {
      throw new AppError('NL_NOT_GENERATED', '该用例没有 NL 文本，无法创建生成任务');
    }
    if (input.generator === 'rule' && !this.config.nlRuleFallbackEnabled) {
      throw new AppError(
        'NL_RULE_FALLBACK_DISABLED',
        '规则兜底生成默认关闭（PW_ENABLE_NL_RULE_FALLBACK=0）；请使用 generator="agent" 由外部 harness 生成',
      );
    }
    const active = nlRepo.activeNlGenerationForCase(this.db, caseId);
    if (active) {
      if (!input.force) {
        throw new AppError('NL_GENERATION_CONFLICT', `该用例已有活跃生成任务（${active.status}）：${active.id}`, [
          { path: 'force', message: '如需重新生成请传 force:true（会取消旧任务）' },
        ]);
      }
      nlRepo.updateNlGeneration(this.db, active.id, { status: 'cancelled' }, isoNow());
    }

    const record = stored.record;
    const id = newId('nlGeneration');
    const now = isoNow();
    const created = nlRepo.insertNlGeneration(
      this.db,
      id,
      {
        caseId,
        generator: input.generator,
        status: 'queued',
        sourceHash: nlSourceHash(record.text),
        caseName: found.name,
        nlText: record.text,
        datasetColumns: this.nl.defaultDatasetColumns(caseId),
        ...(input.hints === undefined ? {} : { hints: input.hints }),
        origin: input.generator === 'rule' ? 'rule' : null,
      },
      now,
    );
    writeAudit(this.db, {
      actor,
      action: 'nl.generation.create',
      target: id,
      detail: { caseId, generator: input.generator, force: input.force },
    });
    return created;
  }

  claim(generationId: string, input: ClaimNlGenerationRequest, actor: string): NlGeneration {
    this.recoverExpired();
    const generation = this.get(generationId);
    if (generation.status !== 'queued') {
      throw new AppError('NL_GENERATION_CONFLICT', `仅 queued 任务可领取（当前：${generation.status}）`);
    }
    if (generation.leaseAttempts >= 3) {
      nlRepo.updateNlGeneration(
        this.db,
        generation.id,
        { status: 'failed', failedAt: isoNow(), error: { code: 'NL_GENERATION_TIMEOUT', message: '租约重试超过 3 次' } },
        isoNow(),
      );
      throw new AppError('NL_GENERATION_TIMEOUT', '该任务租约重试已超过 3 次，需人工介入');
    }
    const leaseSeconds = input.leaseSeconds ?? Math.floor(this.config.nlLeaseTimeoutMs / 1000);
    const leaseMs = Math.min(Math.max(leaseSeconds * 1000, 5000), 600000);
    const updated = nlRepo.updateNlGeneration(
      this.db,
      generation.id,
      {
        status: 'running',
        leaseId: `lease_${newId('nlGeneration').slice(4)}`,
        leaseExpiresAt: isoPlusMs(leaseMs),
        leaseAttempts: generation.leaseAttempts + 1,
      },
      isoNow(),
    );
    writeAudit(this.db, { actor, action: 'nl.generation.claim', target: generation.id, detail: { leaseMs } });
    return updated;
  }

  submit(generationId: string, input: SubmitNlGenerationRequest, actor: string): NlGeneration {
    const generation = this.get(generationId);

    // ready 状态租约语义（F1）：
    // - 提交成功后租约「到期」但保留 leaseId 作为幂等凭据（leaseExpiresAt=null，不可再 claim）；
    // - 同 leaseId + 同内容（含 stepOrigin/warnings/code/steps）重复 submit → 200 同一 generation；
    // - 内容不同 → 409；leaseId 不匹配（旧租约/伪造）→ 409。
    if (generation.status === 'ready') {
      const storedHash = contentHashOf({
        steps: generation.steps,
        code: generation.code,
        warnings: generation.warnings,
        generatorVersion: generation.generatorVersion ?? undefined,
        stepOrigin: generation.stepOrigin ?? undefined,
      });
      const incomingHash = contentHashOf(input);
      if (incomingHash !== storedHash) {
        throw new AppError('NL_GENERATION_CONFLICT', '任务已提交（ready），不同内容不能覆盖；请接受或拒绝后重新生成');
      }
      if (generation.leaseId !== input.leaseId) {
        throw new AppError('NL_GENERATION_CONFLICT', '租约不匹配：ready 任务只接受原 claim leaseId 的幂等重放', [
          { path: 'leaseId', message: '请使用 claim 返回的 leaseId' },
        ]);
      }
      return generation;
    }
    if (generation.status !== 'running') {
      throw new AppError('NL_GENERATION_CONFLICT', `仅 running 任务可提交（当前：${generation.status}）`);
    }
    if (generation.leaseId !== input.leaseId || isExpired(generation.leaseExpiresAt)) {
      throw new AppError('NL_GENERATION_CONFLICT', '租约已失效（或 leaseId 不匹配），请重新 claim');
    }

    const steps = (input.steps ?? []) as Step[];
    if (steps.length > this.config.nlMaxSteps) {
      throw new AppError('NL_SUBMIT_INVALID', `steps 数量 ${steps.length} 超过上限 ${this.config.nlMaxSteps}（PW_NL_MAX_STEPS）`, [
        { path: 'steps', message: `最多 ${this.config.nlMaxSteps} 个步骤` },
      ]);
    }
    if (steps.length === 0 && (input.code === undefined || input.code === null || input.code.trim() === '')) {
      throw new AppError('NL_SUBMIT_INVALID', 'steps 与 code 至少提供一个（不能提交空结果）', [
        { path: 'steps', message: '不能为空' },
      ]);
    }
    const issues = splitStepIssues(validateSteps(steps));
    if (issues.errors.length > 0) {
      throw new AppError(
        'NL_SUBMIT_INVALID',
        issues.errors[0]?.message ?? '步骤校验失败',
        issues.errors.map((issue) => ({ path: issue.path, message: issue.message })),
      );
    }

    // 数据集列校验（datasetId 优先；否则用任务创建时快照的默认数据集列）
    let columns = generation.datasetColumns;
    if (input.datasetId !== undefined) {
      const dataset = datasetRepo.getDatasetById(this.db, input.datasetId);
      if (!dataset || dataset.caseId !== generation.caseId) {
        throw new AppError('NL_SUBMIT_INVALID', 'datasetId 无效：不存在或不属于该用例', [
          { path: 'datasetId', message: '用例不匹配' },
        ]);
      }
      columns = dataset.columns;
    }
    if (columns.length > 0) {
      const columnIssues = validateStepColumns(steps, columns);
      if (columnIssues.length > 0) {
        throw new AppError(
          'NL_SUBMIT_INVALID',
          `引用了不在数据集列中的变量：${columnIssues[0]?.message ?? ''}`,
          columnIssues.map((issue) => ({ path: issue.path, message: issue.message })),
        );
      }
    }

    // stepOrigin 覆盖 + 行号范围
    if (input.stepOrigin !== undefined) {
      this.nl.assertStepOrigin(input.stepOrigin, steps, generation.nlText);
    }

    const warnings: NlWarning[] = input.warnings ?? [];
    const updated = nlRepo.updateNlGeneration(
      this.db,
      generation.id,
      {
        status: 'ready',
        origin: generation.generator === 'rule' ? 'rule' : 'agent',
        generatorVersion: input.generatorVersion,
        steps,
        stepOrigin: input.stepOrigin ?? null,
        code: input.code ?? null,
        warnings,
        submittedAt: isoNow(),
        leaseExpiresAt: null,
      },
      isoNow(),
    );
    writeAudit(this.db, {
      actor,
      action: 'nl.generation.submit',
      target: generation.id,
      detail: { stepsCount: steps.length, warnings: warnings.length },
    });
    return updated;
  }

  accept(caseId: string, generationId: string, input: AcceptNlGenerationRequest, actor: string): {
    case: Case;
    generation: NlGeneration;
  } {
    const generation = this.require(caseId, generationId);
    const found = this.nl.requireCase(caseId);

    if (generation.status === 'accepted') {
      return { case: found, generation };
    }
    if (generation.status !== 'ready') {
      throw new AppError('NL_GENERATION_CONFLICT', `仅 ready 任务可接受（当前：${generation.status}）`);
    }

    const stored = caseRepo.getCaseNlRecord(this.db, caseId);
    if (!stored || stored.record === null) {
      throw new AppError('NL_NOT_GENERATED', '用例 NL 文本已被删除，无法接受生成结果');
    }
    const currentHash = nlSourceHash(stored.record.text);
    if (generation.sourceHash !== currentHash && !input.force) {
      throw new AppError('NL_STALE', 'NL 文本已修改，生成结果已过期；如确认接受旧结果请传 force:true', [
        { path: 'force', message: '接受过期结果需显式 force' },
      ]);
    }

    const steps = (generation.steps ?? []) as Step[];
    const useCode = input.code && generation.code !== null && generation.code.trim() !== '' && steps.length === 0;
    const nextNl: NlSourceRecord = {
      ...stored.record,
      origin: generation.generator,
      generatorVersion: generation.generatorVersion,
      warnings: generation.warnings,
      generatedAt: isoNow(),
      updatedAt: stored.record.updatedAt,
      sourceHash: currentHash,
    };
    // F4：generation accepted + case steps/stepOrigin/nl + audit 同一事务；
    // 任一失败整体回滚（不会出现「任务已 accepted 但用例未写」的半写状态）。
    const accepted = withTransaction(this.db, () => {
      // 先置 accepted 再写用例：case 读回时派生状态才是 generated（ready 仍属活跃任务会显示 generating）
      const acceptedGeneration = nlRepo.updateNlGeneration(
        this.db,
        generation.id,
        { status: 'accepted', acceptedAt: isoNow() },
        isoNow(),
      );
      const updated = caseRepo.applyNlGeneration(this.db, caseId, {
        mode: useCode ? 'code' : 'steps',
        steps: useCode ? [] : steps,
        code: useCode ? generation.code : null,
        stepOrigin: generation.stepOrigin ?? null,
        nl: nextNl,
      });
      writeAudit(this.db, {
        actor,
        action: 'nl.generation.accept',
        target: generation.id,
        detail: { caseId, stepsCount: steps.length, force: input.force, useCode },
      });
      return { updated, acceptedGeneration };
    });
    return { case: accepted.updated, generation: accepted.acceptedGeneration };
  }

  reject(caseId: string, generationId: string, input: RejectNlGenerationRequest, actor: string): NlGeneration {
    const generation = this.require(caseId, generationId);
    if (generation.status !== 'ready') {
      throw new AppError('NL_GENERATION_CONFLICT', `仅 ready 任务可拒绝（当前：${generation.status}）`);
    }
    const updated = nlRepo.updateNlGeneration(
      this.db,
      generation.id,
      {
        status: 'rejected',
        rejectedAt: isoNow(),
        error: { code: 'NL_GENERATION_REJECTED', message: input.reason },
      },
      isoNow(),
    );
    writeAudit(this.db, { actor, action: 'nl.generation.reject', target: generation.id, detail: { reason: input.reason } });
    return updated;
  }

  cancel(caseId: string, generationId: string, actor: string): NlGeneration {
    const generation = this.require(caseId, generationId);
    if (generation.status !== 'queued' && generation.status !== 'running') {
      throw new AppError('NL_GENERATION_CONFLICT', `仅 queued/running 任务可取消（当前：${generation.status}）`);
    }
    const updated = nlRepo.updateNlGeneration(
      this.db,
      generation.id,
      { status: 'cancelled', leaseId: null, leaseExpiresAt: null },
      isoNow(),
    );
    writeAudit(this.db, { actor, action: 'nl.generation.cancel', target: generation.id });
    return updated;
  }

  /**
   * 运行期/启动共用的过期回收（F2）：
   * - queued 超过总超时 → failed（NL_GENERATION_TIMEOUT）；
   * - running 租约过期 → 回到 queued 且 leaseAttempts+1（释放 active，可再次 claim）；累计 ≥3 → failed。
   * 请求级（queue/get/list/claim/create）与启动 recover 都调用这里，不依赖重启。
   */
  recoverExpired(): { failed: number; requeued: number } {
    const now = isoNow();
    const generations = nlRepo.listNlQueue(this.db, ['queued', 'running'], { limit: 100, order: 'asc' });
    let failed = 0;
    let requeued = 0;
    for (const generation of generations.items) {
      if (generation.status === 'queued') {
        const age = nowMs() - Date.parse(generation.createdAt);
        if (age > this.config.nlGenerationTimeoutMs) {
          nlRepo.updateNlGeneration(
            this.db,
            generation.id,
            {
              status: 'failed',
              failedAt: now,
              error: { code: 'NL_GENERATION_TIMEOUT', message: '生成任务排队超时' },
            },
            now,
          );
          failed += 1;
        }
        continue;
      }
      if (isExpired(generation.leaseExpiresAt)) {
        const nextAttempts = generation.leaseAttempts + 1;
        if (nextAttempts >= 3) {
          nlRepo.updateNlGeneration(
            this.db,
            generation.id,
            {
              status: 'failed',
              failedAt: now,
              leaseId: null,
              leaseExpiresAt: null,
              leaseAttempts: Math.min(nextAttempts, 3),
              error: { code: 'NL_GENERATION_TIMEOUT', message: '租约重试超过 3 次' },
            },
            now,
          );
          failed += 1;
        } else {
          nlRepo.updateNlGeneration(
            this.db,
            generation.id,
            { status: 'queued', leaseId: null, leaseExpiresAt: null, leaseAttempts: nextAttempts },
            now,
          );
          requeued += 1;
        }
      }
    }
    return { failed, requeued };
  }

  /** 启动恢复（container 调用）：与运行期回收同一实现 */
  recover(): { failed: number; requeued: number } {
    return this.recoverExpired();
  }
}