/**
 * 回归服务：基线（Baseline）与对比（Comparison）。
 * 契约：docs/api-contract.md §6。归一化规则由 @pw-auto/contracts 的纯函数实现（唯一来源）。
 *
 * 声明纪律：`change`/`verdict` 是胶水层计算，响应必须带 `summary.verdictBasis: "computed"`；
 * `attribution` 只是**确定性规则推导**（基于错误哈希/结果集合），不冒充 AI 归因。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  computeComparisonChange,
  summarizeComparison,
  type Baseline,
  type BaselineListQuery,
  type BaselineScope,
  type AttributionConfidence,
  type ComparisonChange,
  type ComparisonDetail,
  type ComparisonItem,
  type ComparisonListQuery,
  type CreateBaselineRequest,
  type CreateComparisonRequest,
  type FailureCategory,
  type ItemOutcome,
  type Page,
  type RunItem,
} from '@pw-auto/contracts';
import { AppError } from '../errors.ts';
import { newId } from '../ids.ts';
import { writeAudit } from '../repositories/audit.ts';
import * as baselineRepo from '../repositories/baselines.ts';
import * as comparisonRepo from '../repositories/comparisons.ts';
import * as runRepo from '../repositories/runs.ts';
import { isoNow } from '../utils.ts';

export interface ComparisonItemPage {
  comparison: import('@pw-auto/contracts').Comparison;
  items: ComparisonItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

function scopeOfRun(run: import('@pw-auto/contracts').Run): { scope: BaselineScope; scopeId: string } | null {
  if (run.kind === 'case' && run.caseId) return { scope: 'case', scopeId: run.caseId };
  if (run.kind === 'suite' && run.suiteId) return { scope: 'suite', scopeId: run.suiteId };
  return null;
}

function lastErrorHash(item: RunItem | undefined): string | null {
  if (!item) return null;
  const attempts = item.attempts;
  const last = attempts[attempts.length - 1];
  if (!last) return null;
  return last.errorHash === '' ? null : last.errorHash;
}

 /**
 * 失败原因分类（PRD R3.5）：只使用官方证据链（errorLocation/errors[] → steps[] → attachments[] → stdout/stderr）
 * 做**规则推断**，输出 failureCategory + confidence + evidence[]；不改写官方原文，不做 AI 猜测。
 *
 * 规则优先级：环境/网络/导航（基础设施类） > 定位器 > 断言 > 超时 > 数据 > unknown。
 * 说明：官方 locator 超时错误同时含 "Timeout" 与 "Waiting for locator"，因此 locator 必须先于 timeout 判定。
 */
interface FailureClassification {
  category: FailureCategory;
  confidence: AttributionConfidence;
  evidence: string[];
}

function firstFailingAttempt(item: RunItem | undefined): RunItem['attempts'][number] | undefined {
  if (!item) return undefined;
  const failed = item.attempts.find((attempt) => attempt.error !== null || attempt.status === 'failed' || attempt.status === 'timedOut');
  if (failed) return failed;
  return item.attempts[item.attempts.length - 1];
}

function firstFailedStepTitle(steps: readonly { title: string; error: string | null; steps?: unknown }[]): string | null {
  for (const step of steps) {
    if (step.error !== null && step.error !== '') return step.title;
    const nested = Array.isArray(step.steps) ? (step.steps as { title: string; error: string | null }[]) : [];
    const found = firstFailedStepTitle(nested);
    if (found !== null) return found;
  }
  return null;
}

function clipEvidence(text: string, maxLength = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength)}…`;
}

function classifyFailure(item: RunItem | undefined): FailureClassification {
  const attempt = firstFailingAttempt(item);
  if (!attempt) {
    return { category: 'unknown', confidence: 'low', evidence: ['该项无可用 attempt 记录（官方报告缺失失败明细）'] };
  }

  const message = attempt.error?.message ?? '';
  const lower = message.toLowerCase();
  const evidence: string[] = [];
  if (message !== '') evidence.push(`官方 error.message：${clipEvidence(message)}`);
  if (attempt.error?.location) {
    const location = attempt.error.location;
    evidence.push(`官方 errorLocation：${location.file}:${location.line}:${location.column}`);
  }
  if (attempt.errors && attempt.errors.length > 1) {
    evidence.push(`官方 errors[] 共 ${attempt.errors.length} 条（首个失败见 error.message）`);
  }
  const failedStep = firstFailedStepTitle(attempt.steps);
  if (failedStep !== null) evidence.push(`官方 steps[] 首个失败步骤：${failedStep}`);
  if (attempt.attachments.length > 0) {
    evidence.push(
      `官方 attachments：${attempt.attachments.map((attachment) => `${attachment.name} (${attachment.contentType})`).join('、')}`,
    );
  }
  evidence.push(`attempt #${attempt.attempt} 状态=${attempt.status}，outcome=${item?.outcome ?? 'unknown'}`);

  const matched = (label: string, pattern: RegExp): FailureClassification => ({
    category: label as FailureCategory,
    confidence: attempt.error?.location !== undefined || failedStep !== null ? 'high' : 'medium',
    evidence: [`归因依据：官方 error.message 命中 /${pattern.source}/`, ...evidence],
  });

  if (/executable doesn't exist|browserType\.launch|host system is missing dependencies|target (page, context or browser )?closed|browser has been closed|failed to launch|enoent|eacces|spawn /.test(lower)) {
    return matched('environment_error', /executable doesn't exist|browserType\.launch|spawn /);
  }
  if (/net::err_|err_connection|err_name_not_resolved|err_internet_disconnected|socket hang up/.test(lower)) {
    return matched('network_error', /net::err_|err_connection/);
  }
  if (/page\.goto|navigation|navigating to|ns_binding_aborted|frame was detached/.test(lower)) {
    return matched('navigation_error', /page\.goto|navigation/);
  }
  if (/waiting for locator|locator resolved to 0 elements|strict mode violation|element is not (visible|enabled|editable|stable)|no element found|intercepts pointer events/.test(lower)) {
    return matched('locator_not_found', /waiting for locator|locator resolved to 0 elements|strict mode violation/);
  }
  if (/expected:|received:|tohavetext|tobevisible|tohavevalue|tohaveurl|tohavetitle|expect\(/.test(lower)) {
    return matched('assertion_mismatch', /expected:|tohavetext|tobevisible|expect\(/);
  }
  if (/timeout|timed out|exceeded/.test(lower)) {
    return { category: 'timeout', confidence: 'medium', evidence: ['归因依据：官方 error.message 命中 /timeout|timed out|exceeded/', ...evidence] };
  }
  if (/unknown column|invalid_dataset|empty_dataset|数据列|\{\{/.test(lower)) {
    return matched('data_error', /unknown column|invalid_dataset|empty_dataset|数据列/);
  }
  return {
    category: 'unknown',
    confidence: 'low',
    evidence: ['归因依据：官方错误文本未命中任何已文档化失败模式（PRD R3-EX6 无法归因）', ...evidence],
  };
}

function attributionFor(input: {
  change: ComparisonChange;
  baseOutcome: ItemOutcome;
  targetOutcome: ItemOutcome;
  errorChanged: boolean;
  baseErrorHash: string | null;
  targetErrorHash: string | null;
  targetItem: RunItem | undefined;
}): ComparisonItem['attribution'] {
  const hashEvidence: string[] = [];
  if (input.errorChanged) {
    hashEvidence.push(`错误哈希变化：${input.baseErrorHash ?? '无'} → ${input.targetErrorHash ?? '无'}`);
  } else if (input.targetErrorHash !== null) {
    hashEvidence.push(`错误哈希未变：${input.targetErrorHash}`);
  }

  // 失败类变化：附加 PRD R3.5 失败原因分类（官方证据规则推断，非 AI / 非官方结论）
  const failureLike: ComparisonChange[] = ['newly_failed', 'still_failed', 'became_flaky', 'flaky'];
  const classification: FailureClassification | null = failureLike.includes(input.change)
    ? classifyFailure(input.targetItem)
    : null;

  const withFailure = (category: string, confidence: AttributionConfidence, extra: string[]): ComparisonItem['attribution'] => ({
    category,
    failureCategory: classification?.category ?? null,
    confidence: classification?.category === 'unknown' ? 'low' : classification?.confidence ?? confidence,
    evidence: [...extra, ...hashEvidence, ...(classification ? classification.evidence : [])],
  });

  switch (input.change) {
    case 'newly_failed':
      return withFailure('new_failure', 'high', ['基线为通过、本次为失败（回归变化）']);
    case 'still_failed':
      return withFailure(
        input.errorChanged ? 'failure_error_changed' : 'failure_recurred_same_error',
        input.errorChanged ? 'medium' : 'high',
        [input.errorChanged ? '两次运行均失败且错误信息不同（可能为不同缺陷）' : '两次运行均失败且错误信息一致（同一缺陷复发）'],
      );
    case 'became_flaky':
      return withFailure('flaky_introduced', 'medium', ['基线稳定通过、本次出现 flaky（官方 flaky 语义）']);
    case 'flaky':
      return withFailure('flaky', 'medium', ['本次运行内存在重试后通过（官方 flaky 语义）']);
    case 'newly_passed':
      return {
        category: 'fixed',
        failureCategory: null,
        confidence: 'high',
        evidence: ['基线为失败、本次为通过（回归变化）', ...hashEvidence],
      };
    case 'missing_item':
      return {
        category: 'item_missing',
        failureCategory: null,
        confidence: 'high',
        evidence: ['本次运行缺少该 itemKey（用例/数据集行可能被删除或过滤）'],
      };
    case 'new_item':
      return {
        category: 'item_added',
        failureCategory: null,
        confidence: 'high',
        evidence: ['基线中没有该 itemKey（新增用例或新增数据行）'],
      };
    case 'skipped':
      return {
        category: 'skipped',
        failureCategory: null,
        confidence: 'medium',
        evidence: ['本次该项被跳过（官方 skipped 语义）'],
      };
    default:
      return null;
  }
}

export class BaselineService {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(query: BaselineListQuery): Page<Baseline> {
    return baselineRepo.listBaselines(this.db, query);
  }

  get(id: string): Baseline {
    const found = baselineRepo.getBaselineById(this.db, id);
    if (!found) throw new AppError('NOT_FOUND', `基线不存在：${id}`);
    return found;
  }

  create(input: CreateBaselineRequest, actor: string): Baseline {
    const run = runRepo.getRunById(this.db, input.runId);
    if (!run) throw new AppError('NOT_FOUND', `运行不存在：${input.runId}`);

    const runScope = scopeOfRun(run);
    if (!runScope || runScope.scope !== input.scope || runScope.scopeId !== input.scopeId) {
      throw new AppError(
        'BASELINE_SCOPE_MISMATCH',
        `运行与被设基线的 scope 不一致：运行是 ${runScope ? `${runScope.scope}:${runScope.scopeId}` : run.kind}，请求是 ${input.scope}:${input.scopeId}`,
      );
    }
    if (run.status !== 'passed') {
      throw new AppError(
        'BASELINE_SCOPE_MISMATCH',
        `只有 passed 的运行可设为基线（当前状态：${run.status}）；请先修复失败项并重新运行`,
      );
    }

    const created = baselineRepo.insertBaseline(this.db, {
      scope: input.scope,
      scopeId: input.scopeId,
      runId: input.runId,
      name: input.name,
      note: input.note ?? null,
      createdBy: input.createdBy,
    });
    writeAudit(this.db, {
      actor,
      action: 'baseline.create',
      target: created.id,
      detail: { scope: created.scope, scopeId: created.scopeId, runId: created.runId },
    });
    return created;
  }

  setDefault(id: string, actor: string): Baseline {
    const current = this.get(id);
    if (current.archivedAt !== null) {
      throw new AppError('VALIDATION_FAILED', '已归档的基线不能再设为默认；请选择未归档的基线', [
        { path: 'baselineId', message: `基线已归档：${id}` },
      ]);
    }
    const updated = baselineRepo.setDefaultBaseline(this.db, id);
    writeAudit(this.db, { actor, action: 'baseline.default', target: id });
    return updated;
  }

  archive(id: string, confirm: boolean | undefined, actor: string): Baseline {
    if (confirm !== true) {
      throw new AppError('CONFIRM_REQUIRED', '归档基线需要显式确认：请在请求体传 {"confirm": true}');
    }
    this.get(id);
    const updated = baselineRepo.archiveBaseline(this.db, id);
    writeAudit(this.db, { actor, action: 'baseline.archive', target: id });
    return updated;
  }
}

export class ComparisonService {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(input: CreateComparisonRequest, actor: string): ComparisonDetail {
    const baseline = baselineRepo.getBaselineById(this.db, input.baselineId);
    if (!baseline) throw new AppError('NOT_FOUND', `基线不存在：${input.baselineId}`);
    const baselineRun = runRepo.getRunById(this.db, baseline.runId);
    if (!baselineRun) throw new AppError('NOT_FOUND', `基线引用的运行不存在（可能已被保留策略清理）：${baseline.runId}`);
    const targetRun = runRepo.getRunById(this.db, input.runId);
    if (!targetRun) throw new AppError('NOT_FOUND', `运行不存在：${input.runId}`);

    if (!['passed', 'failed', 'cancelled', 'error'].includes(targetRun.status)) {
      throw new AppError('RUN_NOT_TERMINAL', `运行尚未结束（当前状态：${targetRun.status}），无法对比`);
    }
    const targetScope = scopeOfRun(targetRun);
    if (!targetScope || targetScope.scope !== baseline.scope || targetScope.scopeId !== baseline.scopeId) {
      throw new AppError(
        'COMPARISON_SCOPE_MISMATCH',
        `基线与目标运行 scope 不同：基线 ${baseline.scope}:${baseline.scopeId}，目标 ${targetScope ? `${targetScope.scope}:${targetScope.scopeId}` : targetRun.kind}`,
      );
    }

    const baseItems = new Map(runRepo.listAllRunItems(this.db, baseline.runId).map((item) => [item.itemKey, item]));
    const targetItems = new Map(runRepo.listAllRunItems(this.db, targetRun.id).map((item) => [item.itemKey, item]));
    const baseKinds = runRepo.artifactKindsByItem(this.db, baseline.runId);
    const targetKinds = runRepo.artifactKindsByItem(this.db, targetRun.id);

    const keys = [...new Set([...baseItems.keys(), ...targetItems.keys()])].sort((a, b) => a.localeCompare(b));
    const items: ComparisonItem[] = keys.map((itemKey) => {
      const baseItem = baseItems.get(itemKey);
      const targetItem = targetItems.get(itemKey);
      const baseOutcome: ItemOutcome = baseItem?.outcome ?? 'missing';
      const targetOutcome: ItemOutcome = targetItem?.outcome ?? 'missing';
      const change = computeComparisonChange(baseOutcome, targetOutcome);
      const baseErrorHash = lastErrorHash(baseItem);
      const targetErrorHash = lastErrorHash(targetItem);
      const errorChanged = baseErrorHash !== targetErrorHash;

      const before = baseKinds.get(itemKey) ?? new Set<string>();
      const after = targetKinds.get(itemKey) ?? new Set<string>();
      const addedKinds = [...after].filter((kind) => !before.has(kind)).sort((a, b) => a.localeCompare(b));
      const removedKinds = [...before].filter((kind) => !after.has(kind)).sort((a, b) => a.localeCompare(b));

      const durationDeltaMs =
        baseItem !== undefined && targetItem !== undefined ? targetItem.durationMs - baseItem.durationMs : null;

      return {
        itemKey,
        rowIndex: targetItem?.rowIndex ?? baseItem?.rowIndex ?? null,
        change,
        baseOutcome,
        targetOutcome,
        errorChanged,
        baseErrorHash,
        targetErrorHash,
        durationDeltaMs,
        artifactDelta: { added: addedKinds, removed: removedKinds },
        attribution: attributionFor({
          change,
          baseOutcome,
          targetOutcome,
          errorChanged,
          baseErrorHash,
          targetErrorHash,
          targetItem,
        }),
      };
    });

    const summary = summarizeComparison(items.map((item) => item.change));
    const created = comparisonRepo.insertComparison(this.db, {
      comparison: {
        id: newId('comparison'),
        baselineId: baseline.id,
        baselineRunId: baseline.runId,
        runId: targetRun.id,
        scope: baseline.scope,
        scopeId: baseline.scopeId,
        summary,
        createdAt: isoNow(),
      },
      items,
    });

    writeAudit(this.db, {
      actor,
      action: 'comparison.create',
      target: created.id,
      detail: { verdict: summary.verdict, totals: { total: summary.total, newlyFailed: summary.newly_failed } },
    });

    const page = comparisonRepo.listComparisonItems(this.db, created.id, { limit: 20, order: 'asc' });
    return { comparison: created, items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  get(id: string, query: { itemsLimit: number; itemsCursor?: string | undefined }): ComparisonDetail {
    const comparison = comparisonRepo.getComparisonById(this.db, id);
    if (!comparison) throw new AppError('NOT_FOUND', `对比不存在：${id}`);
    const page = comparisonRepo.listComparisonItems(this.db, id, {
      limit: query.itemsLimit,
      cursor: query.itemsCursor,
      order: 'asc',
    });
    return { comparison, items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  list(query: ComparisonListQuery): Page<import('@pw-auto/contracts').Comparison> {
    return comparisonRepo.listComparisons(this.db, query);
  }
}