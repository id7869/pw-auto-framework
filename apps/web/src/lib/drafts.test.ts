import { describe, expect, it } from 'vitest';
import type { StorageLike } from './drafts.ts';
import {
  CASE_DRAFT_PREFIX,
  clearCaseDraft,
  createDraft,
  draftStorageKey,
  getLocalStorage,
  loadCaseDraft,
  saveCaseDraft,
} from './drafts.ts';
import type { CaseFormValues } from './validation.ts';

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function form(overrides: Partial<CaseFormValues> = {}): CaseFormValues {
  return {
    name: '首页用例',
    description: '描述',
    mode: 'steps',
    steps: [{ id: 'st_1', action: 'click', target: { by: 'testId', testId: 'hello' } }],
    code: '',
    tagsText: '@fast',
    status: 'active',
    ...overrides,
  };
}

describe('lib/drafts：本地草稿（非敏感字段白名单）', () => {
  it('保存/读取/清除草稿', () => {
    const storage = memoryStorage();
    expect(saveCaseDraft(storage, 'case_1', form())).toBe(true);
    const draft = loadCaseDraft(storage, 'case_1');
    expect(draft?.v).toBe(1);
    expect(draft?.values.name).toBe('首页用例');
    expect(draft?.values.steps).toHaveLength(1);
    expect(draft?.values.tagsText).toBe('@fast');
    clearCaseDraft(storage, 'case_1');
    expect(loadCaseDraft(storage, 'case_1')).toBeNull();
  });

  it('草稿键：新建与编辑分开', () => {
    expect(draftStorageKey(null)).toBe(`${CASE_DRAFT_PREFIX}new`);
    expect(draftStorageKey('case_1')).toBe(`${CASE_DRAFT_PREFIX}case_1`);
  });

  it('只保存白名单字段（额外敏感字段不落盘）', () => {
    const storage = memoryStorage();
    const extended = { ...form(), password: 'secret', token: 'abc' } as unknown as CaseFormValues;
    saveCaseDraft(storage, null, extended);
    const raw = storage.getItem(draftStorageKey(null)) ?? '';
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('secret');
  });

  it('损坏 JSON / 版本不符返回 null，不抛出', () => {
    const storage = memoryStorage();
    storage.setItem(draftStorageKey('case_1'), '{bad json');
    expect(loadCaseDraft(storage, 'case_1')).toBeNull();
    storage.setItem(draftStorageKey('case_1'), JSON.stringify({ v: 2, values: {} }));
    expect(loadCaseDraft(storage, 'case_1')).toBeNull();
  });

  it('恢复时过滤非法步骤与非字符串字段', () => {
    const storage = memoryStorage();
    storage.setItem(
      draftStorageKey('case_1'),
      JSON.stringify({
        v: 1,
        savedAt: '2026-11-11T00:00:00.000Z',
        values: {
          name: 42,
          description: null,
          mode: 'code',
          steps: [{ id: 'st_1', action: 'click' }, { id: 2, action: 'click' }, { id: 'st_3', action: 'not-an-action' }],
          code: 'test()',
          tagsText: true,
          status: 'weird',
        },
      }),
    );
    const draft = loadCaseDraft(storage, 'case_1');
    expect(draft?.values.name).toBe('');
    expect(draft?.values.mode).toBe('code');
    expect(draft?.values.steps).toHaveLength(1);
    expect(draft?.values.status).toBe('active');
  });

  it('存储不可用/隐私模式时安全降级', () => {
    expect(loadCaseDraft(null, 'case_1')).toBeNull();
    expect(saveCaseDraft(null, 'case_1', form())).toBe(false);
    clearCaseDraft(null, 'case_1');
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadCaseDraft(throwing, 'case_1')).toBeNull();
    expect(saveCaseDraft(throwing, 'case_1', form())).toBe(false);
    clearCaseDraft(throwing, 'case_1');
  });

  it('createDraft 带保存时间戳', () => {
    const draft = createDraft(form(), '2026-11-11T03:00:00.000Z');
    expect(draft.savedAt).toBe('2026-11-11T03:00:00.000Z');
  });

  it('Node 环境没有 localStorage 时 getLocalStorage 返回 null', () => {
    expect(getLocalStorage()).toBeNull();
  });
});