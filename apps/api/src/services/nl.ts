/**
 * NL 用例服务（R6）：文本读写、5 态派生、validate/run 门禁、只读 spec 预览。
 * 契约：api-contract §12.1/§12.2/§12.4/§12.5；设计：docs/NL_AGENT_SKILL_DESIGN.md §2/§4。
 *
 * 纪律：
 * - 本服务**不内置 LLM**；生成由外部 harness 通过 NlGenerationService 提交；
 * - `accept` 是唯一写 steps/stepOrigin 的路径（本服务只读写 nl 文本与门禁）；
 * - 旧用例（无 nl）行为完全不变。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  Case,
  NlLine,
  NlSource,
  NlSourceRecord,
  NlStatus,
  NlWarning,
  Step,
  ValidationWarning,
} from '@pw-auto/contracts';
import type { AppConfig } from '../config.ts';
import type { EngineHandle } from '../engine.ts';
import { AppError } from '../errors.ts';
import { nlSourceHash } from '../nl/model.ts';
import * as caseRepo from '../repositories/cases.ts';
import * as datasetRepo from '../repositories/datasets.ts';
import { deriveNlSourceForCase } from '../repositories/nl-generations.ts';
import * as nlRepo from '../repositories/nl-generations.ts';
import { writeAudit } from '../repositories/audit.ts';
import { isoNow } from '../utils.ts';

export interface NlServiceDeps {
  db: DatabaseSync;
  config: AppConfig;
  engine: EngineHandle;
}

/** 行数上限检查（与 schema 上限解耦；服务端给出中文 422） */
function assertTextLimits(config: AppConfig, text: string): void {
  if (text.trim() === '') {
    throw new AppError('VALIDATION_FAILED', 'NL 文本不能为空（至少写一句业务描述）', [
      { path: 'text', message: '不能为空' },
    ]);
  }
  if (text.length > config.nlMaxChars) {
    throw new AppError('VALIDATION_FAILED', `NL 文本超过上限 ${config.nlMaxChars} 字符（PW_NL_MAX_CHARS）`, [
      { path: 'text', message: `最多 ${config.nlMaxChars} 字符` },
    ]);
  }
  const lines = text.split(/\r?\n/).length;
  if (lines > config.nlMaxLines) {
    throw new AppError('VALIDATION_FAILED', `NL 文本超过上限 ${config.nlMaxLines} 行（PW_NL_MAX_LINES）`, [
      { path: 'text', message: `最多 ${config.nlMaxLines} 行` },
    ]);
  }
}

export class NlService {
  private readonly db: DatabaseSync;
  private readonly config: AppConfig;
  private readonly engine: EngineHandle;

  constructor(deps: NlServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.engine = deps.engine;
  }

  requireCase(caseId: string): Case {
    const found = caseRepo.getCaseById(this.db, caseId);
    if (!found) throw new AppError('NOT_FOUND', `用例不存在或已删除：${caseId}`);
    return found;
  }

  get(caseId: string): NlSource {
    this.requireCase(caseId);
    const stored = caseRepo.getCaseNlRecord(this.db, caseId);
    if (!stored || stored.record === null) throw new AppError('NOT_FOUND', '该用例尚未设置 NL 文本');
    return deriveNlSourceForCase(this.db, caseId, stored.record) as NlSource;
  }

  /** PUT：写文本；状态重置为 draft（若已有 accepted 生成且哈希不同 → 派生为 stale） */
  put(caseId: string, text: string, actor: string): NlSource {
    const found = this.requireCase(caseId);
    assertTextLimits(this.config, text);
    const stored = caseRepo.getCaseNlRecord(this.db, caseId);
    const previous = stored?.record ?? null;
    const record: NlSourceRecord = {
      text,
      sourceHash: nlSourceHash(text),
      origin: null,
      generatorVersion: null,
      warnings: [],
      updatedAt: isoNow(),
      generatedAt: previous?.generatedAt ?? null,
    };
    caseRepo.setCaseNl(this.db, found.id, record);
    // F3：文本已变 → 旧文本的 failed 任务失效（标记 cancelled），避免随后 GET 把新文本误判为 invalid。
    // 与当前文本哈希相同的 failed 保留（同一文本确实生成失败 → invalid）。
    const failed = nlRepo.listNlGenerationsForCase(this.db, caseId, { limit: 100, order: 'desc', status: 'failed' });
    const now = isoNow();
    for (const generation of failed.items) {
      if (generation.sourceHash !== record.sourceHash && generation.status === 'failed') {
        nlRepo.updateNlGeneration(
          this.db,
          generation.id,
          {
            status: 'cancelled',
            error: { code: 'NL_GENERATION_TIMEOUT', message: '文本已修改，旧失败结果失效' },
          },
          now,
        );
      }
    }
    writeAudit(this.db, { actor, action: 'case.nl.put', target: caseId, detail: { sourceHash: record.sourceHash } });
    return this.get(caseId);
  }

  /** DELETE：移除 nl 与 stepOrigin，保留 steps；无 nl → 404 */
  remove(caseId: string, actor: string): void {
    const found = this.requireCase(caseId);
    const stored = caseRepo.getCaseNlRecord(this.db, caseId);
    if (!stored || stored.record === null) throw new AppError('NOT_FOUND', '该用例尚未设置 NL 文本');
    caseRepo.setCaseNl(this.db, found.id, null, null);
    writeAudit(this.db, { actor, action: 'case.nl.delete', target: caseId });
  }

  /** POST /cases 的可选 nl 初值（服务端派生 draft 记录） */
  buildInitialRecord(text: string): NlSourceRecord {
    assertTextLimits(this.config, text);
    return {
      text,
      sourceHash: nlSourceHash(text),
      origin: null,
      generatorVersion: null,
      warnings: [],
      updatedAt: isoNow(),
      generatedAt: null,
    };
  }

  /** 当前用例默认数据集的列（无数据集 → []） */
  defaultDatasetColumns(caseId: string): string[] {
    const dataset = datasetRepo.getFirstDatasetForCase(this.db, caseId);
    return dataset ? dataset.columns : [];
  }

  /**
   * validate / run 门禁（§12.4）：
   * - draft/generating/invalid → 422 NL_NOT_GENERATED（details 带告警码）
   * - stale：validate → 返回 NL_STALE warning；run → 409 NL_STALE（除非 allowStaleNl）
   * - generated / 无 nl → 放行
   */
  gate(caseId: string, mode: 'validate' | 'run', allowStaleNl: boolean): ValidationWarning[] {
    const found = this.requireCase(caseId);
    const nl = found.nl ?? null;
    if (nl === null) return [];
    const status = nl.status as NlStatus;
    if (status === 'draft' || status === 'generating' || status === 'invalid') {
      const details = (nl.warnings ?? []).map((warning) => ({
        path: `nl.warnings[${warning.code}]`,
        message: `第 ${warning.line} 行：${warning.message}`,
      }));
      throw new AppError(
        'NL_NOT_GENERATED',
        status === 'generating'
          ? 'NL 正在生成中，尚未可校验/运行；请等待 harness 提交并 accept'
          : status === 'invalid'
            ? 'NL 上次生成失败（invalid），请重新生成或修改文本'
            : 'NL 文本尚未生成步骤，不能校验/运行；请先创建生成任务并 accept',
        details.length > 0 ? details : undefined,
      );
    }
    if (status === 'stale') {
      if (mode === 'run' && !allowStaleNl) {
        throw new AppError('NL_STALE', 'NL 文本已修改但未重新生成；如确认要用旧步骤运行，请传 options.allowStaleNl=true', [
          { path: 'options.allowStaleNl', message: 'stale 运行需显式放行' },
        ]);
      }
      return [{ code: 'NL_STALE', message: 'NL 文本已修改但未重新生成，本次校验基于旧步骤' }];
    }
    return [];
  }

  /** 代码视图（只读派生；不落盘、不入库） */
  async specPreview(caseId: string): Promise<{ text: string; stepsCount: number; rowsCount: number; warnings: string[] }> {
    const found = this.requireCase(caseId);
    const dataset = datasetRepo.getFirstDatasetForCase(this.db, caseId);
    const enabledRows = dataset ? datasetRepo.listEnabledRows(this.db, dataset.id) : [];
    if (!this.engine.engine) {
      throw new AppError('NOT_IMPLEMENTED', this.engine.reason ?? '执行引擎不可用，无法生成规格预览');
    }
    const result = await this.engine.engine.compile({
      caseSnapshot: {
        caseId: found.id,
        name: found.name,
        description: found.description,
        mode: found.mode,
        steps: found.steps,
        code: found.code,
        tags: found.tags,
        ...(dataset === null
          ? {}
          : {
              rows: enabledRows.map((row) => ({ rowIndex: row.rowIndex, data: row.data })),
              columns: dataset.columns,
              datasetId: dataset.id,
            }),
      },
    });
    const warnings = [
      ...result.errors.map((issue) => `官方编译校验：${issue.message}`),
      ...result.warnings.map((warning) => warning.message),
    ];
    return { text: result.specSource ?? '', stepsCount: result.stepsCount, rowsCount: result.rowsCount, warnings };
  }

  /** 供生成服务使用：当前文本行数（stepOrigin 行号上界） */
  lineCountOf(text: string): number {
    return text.split(/\r?\n/).length;
  }

  /** 校验 stepOrigin 覆盖/范围（submit 用） */
  assertStepOrigin(stepOrigin: Record<string, { nlLine: number }> | undefined, steps: readonly Step[], text: string): void {
    if (stepOrigin === undefined) return;
    const lineCount = this.lineCountOf(text);
    const missing = steps.filter((step) => stepOrigin[step.id] === undefined);
    const outOfRange = Object.entries(stepOrigin).filter(([, value]) => value.nlLine < 1 || value.nlLine > lineCount);
    if (missing.length > 0 || outOfRange.length > 0) {
      throw new AppError(
        'NL_SUBMIT_INVALID',
        missing.length > 0
          ? `stepOrigin 未覆盖全部步骤：缺少 ${missing.map((step) => step.id).join(', ')}`
          : `stepOrigin 行号越界（NL 共 ${lineCount} 行）`,
        [
          ...missing.map((step) => ({ path: `steps[${step.id}]`, message: 'stepOrigin 缺少该步骤' })),
          ...outOfRange.map(([stepId]) => ({ path: `stepOrigin.${stepId}`, message: 'nlLine 越界' })),
        ],
      );
    }
  }
}

export type NlLineView = NlLine;
export type NlWarningView = NlWarning;
