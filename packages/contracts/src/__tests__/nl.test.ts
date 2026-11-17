import { describe, expect, it } from 'vitest';
import {
  AGENT_ENTRIES,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  NL_GENERATION_STATUSES,
  NL_STATUSES,
  NL_WARNING_CODES,
  agentEntryInfoSchema,
  createCaseRequestSchema,
  createScaffoldRequestSchema,
  harnessInfoSchema,
  nlGenerationSchema,
  nlSourceSchema,
  patchCaseRequestSchema,
  runOptionsSchema,
  stepOriginSchema,
} from '../index.ts';

const NL_TEXT = ['打开 http://127.0.0.1:4174/login', '在「用户名」输入 {{用户名}}', '点击「登录」'].join('\n');

describe('R6 NL 合同 schema', () => {
  it('Case 可选 nl/stepOrigin；POST 接受 nl.text；PATCH 严格拒绝 nl', () => {
    const created = createCaseRequestSchema.safeParse({ name: 'NL', nl: { text: NL_TEXT } });
    expect(created.success).toBe(true);

    const withOrigin = createCaseRequestSchema.safeParse({
      name: 'NL',
      nl: { text: NL_TEXT },
      stepOrigin: { s1: { nlLine: 1 } },
    });
    // stepOrigin 由 accept 写入，不允许从 POST 直接提交
    expect(withOrigin.success).toBe(false);

    expect(patchCaseRequestSchema.safeParse({ nl: { text: 'x' } }).success).toBe(false);
    expect(stepOriginSchema.safeParse({ s1: { nlLine: 1 } }).success).toBe(true);
    expect(stepOriginSchema.safeParse({ s1: { nlLine: 0 } }).success).toBe(false);
  });

  it('NlSource 5 态 / 行类型 / 告警码 / 16 位 hash 固定枚举', () => {
    expect(NL_STATUSES).toEqual(['draft', 'generating', 'generated', 'stale', 'invalid']);
    expect(NL_WARNING_CODES).toEqual([
      'NL_LINE_UNMAPPED',
      'NL_TARGET_AMBIGUOUS',
      'NL_UNSUPPORTED_ACTION',
      'NL_NO_ASSERTION',
    ]);
    const source = {
      text: NL_TEXT,
      status: 'generated',
      sourceHash: 'ab12cd34ef56cd78',
      origin: 'agent',
      generatorVersion: 'skill/1.0.0',
      warnings: [{ code: 'NL_NO_ASSERTION', line: 0, message: '整条用例没有断言' }],
      lines: [
        { line: 1, text: '打开 ...', kind: 'instruction', stepId: null },
        { line: 2, text: '在「用户名」输入 {{用户名}}', kind: 'step', stepId: 's2' },
      ],
      updatedAt: '2026-11-12T02:10:00.000Z',
      generatedAt: '2026-11-12T02:12:30.000Z',
    };
    expect(nlSourceSchema.safeParse(source).success).toBe(true);
    expect(nlSourceSchema.safeParse({ ...source, sourceHash: 'short' }).success).toBe(false);
    expect(nlSourceSchema.safeParse({ ...source, status: 'unknown' }).success).toBe(false);
  });

  it('NlGeneration 7 态；生成任务 schema 允许 hints/stepOrigin 增量；非法状态拒绝', () => {
    expect(NL_GENERATION_STATUSES).toEqual(['queued', 'running', 'ready', 'accepted', 'rejected', 'failed', 'cancelled']);
    const generation = {
      id: 'nlg_ab12cd34ef56cd78',
      caseId: 'case_x',
      generator: 'agent',
      status: 'ready',
      sourceHash: 'ab12cd34ef56cd78',
      origin: 'agent',
      generatorVersion: 'skill/1.0.0',
      leaseId: null,
      leaseExpiresAt: null,
      leaseAttempts: 1,
      fallback: false,
      caseName: '登录冒烟',
      nlText: NL_TEXT,
      datasetColumns: ['用户名'],
      hints: { baseUrl: 'https://demo.example.com' },
      stepOrigin: { s1: { nlLine: 1 } },
      steps: [{ id: 's1', action: 'goto', url: 'https://demo.example.com/login' }],
      code: null,
      warnings: [],
      error: null,
      submittedAt: '2026-11-12T02:12:30.000Z',
      acceptedAt: null,
      rejectedAt: null,
      failedAt: null,
      createdAt: '2026-11-12T02:10:00.000Z',
      updatedAt: '2026-11-12T02:12:30.000Z',
    };
    expect(nlGenerationSchema.safeParse(generation).success).toBe(true);
    expect(nlGenerationSchema.safeParse({ ...generation, status: 'pending' }).success).toBe(false);
    expect(nlGenerationSchema.safeParse({ ...generation, leaseAttempts: 4 }).success).toBe(false);
  });

  it('runOptions 新增 allowStaleNl（默认 false）', () => {
    const parsed = runOptionsSchema.parse({});
    expect(parsed.allowStaleNl).toBe(false);
    expect(runOptionsSchema.safeParse({ allowStaleNl: true }).success).toBe(true);
    expect(runOptionsSchema.safeParse({ allowStaleNl: 'yes' }).success).toBe(false);
  });
});

describe('R7 三 harness 合同（无安装态）', () => {
  it('HarnessInfo 仅 entry/label/officialLoop/requiresMcp/skillPaths/notes；deepseek officialLoop=null', () => {
    expect(AGENT_ENTRIES).toEqual(['claude', 'codex', 'deepseek']);
    const deepseek = {
      entry: 'deepseek',
      label: 'DeepSeek Harness',
      officialLoop: null,
      requiresMcp: false,
      skillPaths: [
        { scope: 'user', path: '~/.dsh/skills/pw-auto-test/' },
        { scope: 'shared', path: '<repo>/.agents/skills/pw-auto-test/' },
      ],
      notes: 'officialLoop:null',
    };
    expect(harnessInfoSchema.safeParse(deepseek).success).toBe(true);
    expect(harnessInfoSchema.safeParse({ ...deepseek, requiresMcp: true }).success).toBe(false);
    expect(harnessInfoSchema.safeParse({ ...deepseek, officialLoop: 'deepseek' }).success).toBe(false);
    expect(harnessInfoSchema.safeParse({ ...deepseek, installed: true }).success).toBe(false);
    expect(harnessInfoSchema.safeParse({ ...deepseek, installTargets: [] }).success).toBe(false);

    const entries = agentEntryInfoSchema.safeParse({ entry: 'claude', loop: 'claude', description: 'x' });
    expect(entries.success).toBe(true);
    const noLoop = agentEntryInfoSchema.safeParse({ entry: 'deepseek', loop: null, description: 'x' });
    expect(noLoop.success).toBe(true);
    expect(agentEntryInfoSchema.safeParse({ entry: 'copilot', loop: null, description: 'x' }).success).toBe(false);
  });

  it('scaffold 请求 schema 接受 entry/loop 字符串（三入口与旧 loop 拒绝由业务层 422 HARNESS_NOT_SUPPORTED）', () => {
    expect(createScaffoldRequestSchema.safeParse({ entry: 'codex', confirm: true }).success).toBe(true);
    expect(createScaffoldRequestSchema.safeParse({ loop: 'copilot', confirm: true }).success).toBe(true);
    // schema 不把非三入口判为 VALIDATION_FAILED；业务层统一映射 HARNESS_NOT_SUPPORTED
    expect(createScaffoldRequestSchema.safeParse({ entry: 'copilot', confirm: true }).success).toBe(true);
    expect(createScaffoldRequestSchema.safeParse({ confirm: true }).success).toBe(true);
    expect(createScaffoldRequestSchema.safeParse({ entry: '', confirm: true }).success).toBe(false);
  });

  it('新增 7 个错误码均登记 HTTP 状态（NL/harness）', () => {
    for (const [code, status] of [
      ['NL_NOT_GENERATED', 422],
      ['NL_STALE', 409],
      ['NL_GENERATION_CONFLICT', 409],
      ['NL_GENERATION_TIMEOUT', 504],
      ['NL_SUBMIT_INVALID', 422],
      ['NL_RULE_FALLBACK_DISABLED', 403],
      ['HARNESS_NOT_SUPPORTED', 422],
    ] as const) {
      expect(ERROR_CODES).toContain(code);
      expect(ERROR_HTTP_STATUS[code]).toBe(status);
    }
  });
});