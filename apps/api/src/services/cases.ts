/**
 * 用例服务：两种模式（结构化步骤 / 原始 Playwright Test 代码）的校验与 CRUD。
 * 契约：docs/api-contract.md §2。
 *
 * 纪律：
 * - 步骤只做**语义校验**，编译成 .spec.ts 由 packages/automation 负责；
 * - 模式与字段必须自洽（steps 模式禁止 code，code 模式禁止 steps），否则 422；
 * - PATCH 必须带 If-Match 版本号，版本不符 409 VERSION_CONFLICT。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  splitStepIssues,
  validateStepColumns,
  validateSteps,
  type Case,
  type CaseListQuery,
  type CaseListItem,
  type CaseMode,
  type CreateCaseRequest,
  type Page,
  type PatchCaseRequest,
  type RowData,
  type Step,
  type ValidateCaseResponse,
} from '@pw-auto/contracts';
import type { EngineHandle } from '../engine.ts';
import { AppError } from '../errors.ts';
import * as caseRepo from '../repositories/cases.ts';
import * as datasetRepo from '../repositories/datasets.ts';
import { writeAudit } from '../repositories/audit.ts';
import type { NlService } from './nl.ts';

export interface CaseServiceDeps {
  db: DatabaseSync;
  engine: EngineHandle;
  /** NL 门禁（无 nl 的旧用例完全不受影响） */
  nl: NlService;
}

export interface CaseWriteInput {
  name: string;
  description: string;
  mode: CaseMode;
  steps: Step[];
  code: string | null;
  tags: string[];
}

/** If-Match: "3" / 3 / W/"3" → 3 */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined || header.trim() === '') {
    throw new AppError('VALIDATION_FAILED', 'PATCH 请求必须带 If-Match 头（当前版本号），防止并发覆盖', [
      { path: 'If-Match', message: '必填' },
    ]);
  }
  const normalized = header.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const version = Number(normalized);
  if (!Number.isInteger(version) || version < 1) {
    throw new AppError('VALIDATION_FAILED', `If-Match 版本号非法：${header}（应为正整数，如 "3"）`, [
      { path: 'If-Match', message: '必须是正整数版本号' },
    ]);
  }
  return version;
}

function normalizeShape(input: CaseWriteInput, columns: readonly string[] | null): { steps: Step[]; code: string | null; warnings: string[] } {
  const semantic = validateSteps(input.steps);
  const split = splitStepIssues(semantic);
  if (split.errors.length > 0) {
    throw new AppError(
      'INVALID_STEP',
      split.errors[0]?.message ?? '步骤校验失败',
      split.errors.map((issue) => ({ path: issue.path, message: issue.message })),
    );
  }

  if (input.mode === 'code') {
    if (input.code === null || input.code.trim() === '') {
      throw new AppError('VALIDATION_FAILED', 'mode=code 时 code 必填（1..200000 字符）', [
        { path: 'code', message: '必填' },
      ]);
    }
    if (input.steps.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'mode=code 时 steps 必须为空（两种模式互斥）', [
        { path: 'steps', message: '必须为空数组' },
      ]);
    }
  } else if (input.code !== null && input.code.trim() !== '') {
    throw new AppError('VALIDATION_FAILED', 'mode=steps 时 code 必须为空（两种模式互斥）', [
      { path: 'code', message: '必须为 null' },
    ]);
  }

  if (columns !== null) {
    const columnIssues = validateStepColumns(input.steps, columns);
    if (columnIssues.length > 0) {
      throw new AppError(
        'UNKNOWN_COLUMN',
        columnIssues[0]?.message ?? '引用了不存在的数据列',
        columnIssues.map((issue) => ({ path: issue.path, message: issue.message })),
      );
    }
  }

  return {
    steps: input.steps,
    code: input.mode === 'code' ? input.code : null,
    warnings: split.warnings.map((issue) => `${issue.message}（${issue.path}）`),
  };
}

function dedupeTags(tags: readonly string[]): string[] {
  const seen: string[] = [];
  for (const tag of tags) if (!seen.includes(tag)) seen.push(tag);
  return seen;
}

export class CaseService {
  private readonly db: DatabaseSync;
  private readonly engine: EngineHandle;
  private readonly nl: NlService;

  constructor(deps: CaseServiceDeps) {
    this.db = deps.db;
    this.engine = deps.engine;
    this.nl = deps.nl;
  }

  list(query: CaseListQuery): Page<CaseListItem> {
    return caseRepo.listCases(this.db, query);
  }

  get(id: string): Case {
    const found = caseRepo.getCaseById(this.db, id);
    if (!found) throw new AppError('NOT_FOUND', `用例不存在或已删除：${id}`);
    return found;
  }

  create(input: CreateCaseRequest, actor: string): Case {
    const normalized = normalizeShape(
      {
        name: input.name,
        description: input.description,
        mode: input.mode,
        steps: input.steps,
        code: input.code,
        tags: dedupeTags(input.tags),
      },
      null,
    );
    const created = caseRepo.insertCase(this.db, {
      name: input.name,
      description: input.description,
      mode: input.mode,
      steps: normalized.steps,
      code: normalized.code,
      tags: dedupeTags(input.tags),
      ...(input.nl === undefined ? {} : { nl: this.nl.buildInitialRecord(input.nl.text) }),
    });
    writeAudit(this.db, {
      actor,
      action: 'case.create',
      target: created.id,
      detail: { mode: created.mode, stepsCount: created.steps.length, warnings: normalized.warnings.length },
    });
    return created;
  }

  patch(id: string, expectedVersion: number, patch: PatchCaseRequest, actor: string): Case {
    const current = this.get(id);
    const merged: CaseWriteInput = {
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      mode: patch.mode ?? current.mode,
      steps: patch.steps ?? current.steps,
      code: patch.code !== undefined ? patch.code : current.code,
      tags: patch.tags !== undefined ? dedupeTags(patch.tags) : current.tags,
    };
    const normalized = normalizeShape(merged, null);
    const updated = caseRepo.updateCase(this.db, id, expectedVersion, {
      name: merged.name,
      description: merged.description,
      mode: merged.mode,
      steps: normalized.steps,
      code: normalized.code,
      tags: merged.tags,
      status: patch.status,
    });
    writeAudit(this.db, {
      actor,
      action: 'case.update',
      target: id,
      detail: { version: updated.version, fields: Object.keys(patch) },
    });
    return updated;
  }

  remove(id: string, actor: string): void {
    caseRepo.softDeleteCase(this.db, id);
    writeAudit(this.db, { actor, action: 'case.delete', target: id });
  }

  /**
   * 编译校验（不执行）：api-contract §2.8。
   * 若引擎提供 compile 则委托官方编译校验；否则做本地语义校验并显式标注「未接入官方编译」。
   */
  async validate(id: string, datasetId: string | undefined): Promise<ValidateCaseResponse> {
    const found = this.get(id);
    // NL 门禁（§12.4）：draft/generating/invalid → 422 NL_NOT_GENERATED；stale → 校验继续并带 warning
    const nlWarnings = this.nl.gate(found.id, 'validate', false).map((warning) => ({
      code: warning.code,
      message: warning.message,
    }));
    // 与真实运行（POST /runs）一致的数据集解析：只取启用行，列集合来自数据集；
    // 必须随 caseSnapshot 一起传给官方 compile —— 否则引擎看不到列，会把合法变量误报为 UNKNOWN_COLUMN（F2）。
    let datasetSnapshot: { id: string; columns: string[]; rows: { rowIndex: number; data: RowData }[] } | null = null;
    let rowsCount = 0;
    if (datasetId !== undefined) {
      const dataset = datasetRepo.getDatasetById(this.db, datasetId);
      if (!dataset) throw new AppError('NOT_FOUND', `数据集不存在或已删除：${datasetId}`);
      if (dataset.caseId !== found.id) {
        throw new AppError('VALIDATION_FAILED', '数据集不属于该用例', [{ path: 'datasetId', message: '用例不匹配' }]);
      }
      const enabledRows = datasetRepo.listEnabledRows(this.db, dataset.id);
      if (enabledRows.length === 0) {
        throw new AppError('EMPTY_DATASET', '数据集没有启用行，无法执行数据驱动用例');
      }
      datasetSnapshot = {
        id: dataset.id,
        columns: dataset.columns,
        rows: enabledRows.map((row) => ({ rowIndex: row.rowIndex, data: row.data })),
      };
      rowsCount = enabledRows.length;
    }

    const normalized = normalizeShape(
      {
        name: found.name,
        description: found.description,
        mode: found.mode,
        steps: found.steps,
        code: found.code,
        tags: found.tags,
      },
      datasetSnapshot?.columns ?? null,
    );

    const warnings = normalized.warnings.map((message) => ({ code: 'CSS_SELECTOR', message }));

    if (this.engine.engine) {
      try {
        const result = await this.engine.engine.compile({
          caseSnapshot: {
            caseId: found.id,
            name: found.name,
            description: found.description,
            mode: found.mode,
            steps: found.steps,
            code: found.code,
            tags: found.tags,
            ...(datasetSnapshot === null
              ? {}
              : { rows: datasetSnapshot.rows, columns: datasetSnapshot.columns, datasetId: datasetSnapshot.id }),
          },
        });
        const engineWarnings = result.warnings.map((warning) => ({
          code: warning.code,
          message: warning.message,
          ...(warning.stepId === undefined ? {} : { stepId: warning.stepId }),
        }));
        const engineErrors = result.errors.map((issue) => ({
          code: issue.code,
          message: `官方编译校验：${issue.message}`,
          ...(issue.stepId === undefined ? {} : { stepId: issue.stepId }),
        }));
        return {
          ok: result.ok && engineErrors.length === 0,
          compiledSpecPath: null,
          stepsCount: result.stepsCount,
          rowsCount,
          warnings: [...nlWarnings, ...warnings, ...engineWarnings, ...engineErrors],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          compiledSpecPath: null,
          stepsCount: found.steps.length,
          rowsCount,
          warnings: [...nlWarnings, ...warnings, { code: 'ENGINE_ERROR', message: `官方编译校验失败：${message}` }],
        };
      }
    }

    return {
      ok: true,
      compiledSpecPath: null,
      stepsCount: found.steps.length,
      rowsCount,
      warnings: [
        ...nlWarnings,
        ...warnings,
        {
          code: 'ENGINE_UNAVAILABLE',
          message: this.engine.reason ?? '执行引擎不可用：已跳过官方编译校验（仅做本地语义校验）',
        },
      ],
    };
  }
}