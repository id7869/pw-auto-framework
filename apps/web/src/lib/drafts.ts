/**
 * 本地草稿（PRD R1-EX3：保存失败保留草稿）。
 * 只保存用例编辑所需的非敏感字段白名单；不写任何密钥/token/cookie。
 */
import { STEP_ACTIONS } from '../api/types.ts';
import type { CaseMode, CaseStatus, Step, StepAction } from '../api/types.ts';
import type { CaseFormValues } from './validation.ts';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CaseDraftValues {
  name: string;
  description: string;
  mode: CaseMode;
  steps: Step[];
  code: string;
  tagsText: string;
  status: CaseStatus;
}

export interface CaseDraft {
  v: 1;
  savedAt: string;
  values: CaseDraftValues;
}

export const CASE_DRAFT_PREFIX = 'pw-auto-framework:draft:case:';

export function draftStorageKey(caseId: string | null): string {
  return `${CASE_DRAFT_PREFIX}${caseId ?? 'new'}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStepAction(value: unknown): value is StepAction {
  return typeof value === 'string' && (STEP_ACTIONS as readonly string[]).includes(value);
}

/** 只保留白名单字段；步骤做最小形状校验，避免脏数据污染编辑器 */
export function normalizeDraftValues(values: CaseFormValues): CaseDraftValues {
  const steps: Step[] = [];
  for (const step of values.steps) {
    if (!isRecord(step)) continue;
    if (typeof step['id'] !== 'string' || !isStepAction(step['action'])) continue;
    steps.push(step as unknown as Step);
  }
  return {
    name: values.name,
    description: values.description,
    mode: values.mode === 'code' ? 'code' : 'steps',
    steps,
    code: values.code,
    tagsText: values.tagsText,
    status: values.status === 'archived' ? 'archived' : 'active',
  };
}

export function createDraft(values: CaseFormValues, savedAt = new Date().toISOString()): CaseDraft {
  return { v: 1, savedAt, values: normalizeDraftValues(values) };
}

export function saveCaseDraft(storage: StorageLike | null, caseId: string | null, values: CaseFormValues): boolean {
  if (!storage) return false;
  try {
    storage.setItem(draftStorageKey(caseId), JSON.stringify(createDraft(values)));
    return true;
  } catch {
    return false;
  }
}

function parseDraft(raw: string): CaseDraft | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed['v'] !== 1 || !isRecord(parsed['values'])) return null;
  const values = parsed['values'];
  const savedAt = typeof parsed['savedAt'] === 'string' ? parsed['savedAt'] : new Date(0).toISOString();
  const mode = values['mode'] === 'code' ? 'code' : 'steps';
  const steps = Array.isArray(values['steps'])
    ? (values['steps'] as unknown[]).filter((step): step is Step => {
        if (!isRecord(step)) return false;
        return typeof step['id'] === 'string' && isStepAction(step['action']);
      })
    : [];
  return {
    v: 1,
    savedAt,
    values: {
      name: typeof values['name'] === 'string' ? values['name'] : '',
      description: typeof values['description'] === 'string' ? values['description'] : '',
      mode,
      steps,
      code: typeof values['code'] === 'string' ? values['code'] : '',
      tagsText: typeof values['tagsText'] === 'string' ? values['tagsText'] : '',
      status: values['status'] === 'archived' ? 'archived' : 'active',
    },
  };
}

export function loadCaseDraft(storage: StorageLike | null, caseId: string | null): CaseDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(draftStorageKey(caseId));
    if (!raw) return null;
    return parseDraft(raw);
  } catch {
    return null;
  }
}

export function clearCaseDraft(storage: StorageLike | null, caseId: string | null): void {
  if (!storage) return;
  try {
    storage.removeItem(draftStorageKey(caseId));
  } catch {
    // 忽略浏览器隐私模式下的失败（草稿功能非关键路径）
  }
}

/** 浏览器 localStorage 的安全获取（隐私模式/配额异常时返回 null） */
export function getLocalStorage(): StorageLike | null {
  const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;
  if (!candidate) return null;
  try {
    const probeKey = `${CASE_DRAFT_PREFIX}probe`;
    candidate.setItem(probeKey, '1');
    candidate.removeItem(probeKey);
    return candidate;
  } catch {
    return null;
  }
}