/**
 * 套件服务：成员用例必须存在且不重复（caseIds 不存在 → 422 UNKNOWN_CASE）。
 * 契约：docs/api-contract.md §4。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  type CreateSuiteRequest,
  type Page,
  type PatchSuiteRequest,
  type PutSuiteCasesRequest,
  type Suite,
  type SuiteListQuery,
} from '@pw-auto/contracts';
import { AppError } from '../errors.ts';
import { writeAudit } from '../repositories/audit.ts';
import * as caseRepo from '../repositories/cases.ts';
import * as suiteRepo from '../repositories/suites.ts';

export class SuiteService {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 校验成员用例：重复 → VALIDATION_FAILED；不存在/已删除 → UNKNOWN_CASE（api-contract §4） */
  private validateCaseIds(caseIds: readonly string[]): void {
    const duplicates: string[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const caseId of caseIds) {
      if (seen.has(caseId)) {
        if (!duplicates.includes(caseId)) duplicates.push(caseId);
        continue;
      }
      seen.add(caseId);
      if (!caseRepo.caseExists(this.db, caseId)) missing.push(caseId);
    }
    if (duplicates.length > 0) {
      throw new AppError('VALIDATION_FAILED', `caseIds 不允许重复：${duplicates.join('、')}`, [
        { path: 'caseIds', message: '成员用例必须唯一（套件表以 (suiteId,caseId) 为主键）' },
      ]);
    }
    if (missing.length > 0) {
      throw new AppError('UNKNOWN_CASE', `套件引用了不存在的用例：${missing.join('、')}`, missing.map((id) => ({ path: 'caseIds', message: `用例不存在：${id}` })));
    }
  }

  list(query: SuiteListQuery): Page<Suite> {
    return suiteRepo.listSuites(this.db, query);
  }

  get(id: string): Suite {
    const found = suiteRepo.getSuiteById(this.db, id);
    if (!found) throw new AppError('NOT_FOUND', `套件不存在或已删除：${id}`);
    return found;
  }

  create(input: CreateSuiteRequest, actor: string): Suite {
    this.validateCaseIds(input.caseIds);
    const created = suiteRepo.insertSuite(this.db, input);
    writeAudit(this.db, {
      actor,
      action: 'suite.create',
      target: created.id,
      detail: { casesCount: created.casesCount },
    });
    return created;
  }

  patch(id: string, patch: PatchSuiteRequest, actor: string): Suite {
    this.get(id);
    const updated = suiteRepo.updateSuite(this.db, id, patch);
    writeAudit(this.db, { actor, action: 'suite.update', target: id });
    return updated;
  }

  putCases(id: string, input: PutSuiteCasesRequest, actor: string): Suite {
    this.get(id);
    this.validateCaseIds(input.caseIds);
    const updated = suiteRepo.setSuiteCases(this.db, id, input.caseIds);
    writeAudit(this.db, {
      actor,
      action: 'suite.cases.replace',
      target: id,
      detail: { casesCount: updated.casesCount },
    });
    return updated;
  }

  remove(id: string, actor: string): void {
    suiteRepo.softDeleteSuite(this.db, id);
    writeAudit(this.db, { actor, action: 'suite.delete', target: id });
  }
}