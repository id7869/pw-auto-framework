/**
 * A15 NL 数据驱动逐行（R4/R6；N3）。
 *
 * 覆盖：
 *  - NL 文本含 `{{列}}` → 生成步骤仍保留变量（不替换字面量）→ accept；
 *  - 数据集 3 行（2 启用 / 1 禁用）→ 带 datasetId validate rowsCount=2、运行逐行 rowIndex/itemKey=caseId#row:N、title [row:N]；
 *  - 逐行失败证据（unexpected + error/trace/screenshot 产物）；
 *  - NL 行回标：case.stepOrigin 覆盖每个 stepId 且行号在 NL 文本范围内；
 *  - 边界：未知列 422 UNKNOWN_COLUMN、全禁用 422 EMPTY_DATASET、submit 引用未知列 422 NL_SUBMIT_INVALID。
 */

import { test, expect } from '@playwright/test';
import {
  cancelNlGeneration,
  claimNlGeneration,
  createCase,
  createDataset,
  errorCodeOf,
  getCase,
  listRunArtifacts,
  listRunItems,
  startRun,
  submitNlGeneration,
  unwrap,
  validateCase,
  waitRun,
} from '../support/api.ts';
import { saveJson } from '../support/evidence.ts';
import { FIXTURE_BASE } from '../support/env.ts';
import { accept, createGeneration } from '../support/nl-agent.ts';
import type { CaseStep, NlGeneration } from '../support/types.ts';

const SCENARIO = 'a15-nl-data';

const NL_TEXT = [
  `打开 ${FIXTURE_BASE}/?name={{用户名}}`,
  '页面上应该看到标题「演示站」',
  '页面上应该出现文本「你好，{{用户名}}」',
  '页面上应该出现文本「{{期望}}」',
].join('\n');

const STEPS: CaseStep[] = [
  { id: 'd1', action: 'goto', url: `${FIXTURE_BASE}/?name={{用户名}}`, label: '打开问候页（变量 URL）' },
  { id: 'd2', action: 'expectVisible', target: { by: 'role', role: 'heading', name: '演示站' }, label: '标题可见' },
  { id: 'd3', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '你好，{{用户名}}', label: '按用户名问候' },
  { id: 'd4', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '{{期望}}', label: '按期望列断言' },
];

const ORIGIN = { d1: { nlLine: 1 }, d2: { nlLine: 2 }, d3: { nlLine: 3 }, d4: { nlLine: 4 } };

function uniq(prefix: string): string {
  return `${prefix}-${String(Date.now())}-${String(Math.floor(Math.random() * 1000))}`;
}

test.describe('A15 NL 数据驱动逐行', () => {
  test('A15-1 {{列}} 保留 → 数据集 2 启用/1 禁用 → 逐行结果与失败证据', async () => {
    const createdCase = await createCase({ name: uniq('A15-NLData'), mode: 'steps', nl: { text: NL_TEXT } });

    // 数据集：row0/row1 启用（row1 期望值为故意错误），row2 禁用
    const dataset = await createDataset(createdCase.id, {
      name: 'A15 两行账号（含 1 禁用）',
      source: 'json',
      rows: [
        { data: { 用户名: '张三', 期望: '你好，张三' } },
        { data: { 用户名: '李四', 期望: '错误期望' } },
        { data: { 用户名: '王五', 期望: '你好，王五' }, enabled: false },
      ],
    });
    expect(dataset.rowsCount).toBe(3);
    expect(dataset.enabledRowsCount).toBe(2);
    expect(dataset.columns.sort()).toEqual(['用户名', '期望'].sort());

    // 生成任务快照数据集列；提交步骤仍保留变量
    const generation = await createGeneration(createdCase.id);
    expect(generation.datasetColumns.sort()).toEqual(['用户名', '期望'].sort());
    const claimed = unwrap<NlGeneration>(await claimNlGeneration(generation.id));
    const submitted = unwrap<NlGeneration>(
      await submitNlGeneration(generation.id, {
        leaseId: claimed.leaseId ?? '',
        steps: STEPS,
        stepOrigin: ORIGIN,
        datasetId: dataset.id,
        generatorVersion: 'pw-e2e-agent/1.0.0',
      }),
    );
    const submittedJson = JSON.stringify(submitted.steps);
    expect(submittedJson).toContain('{{用户名}}');
    expect(submittedJson).toContain('{{期望}}');
    expect(submittedJson).not.toContain('张三');

    // accept 后变量仍是形参（未被替换）
    const acceptedCase = await accept(createdCase.id, submitted.id);
    expect(JSON.stringify(acceptedCase.steps)).toContain('{{用户名}}');
    expect(JSON.stringify(acceptedCase.steps)).toContain('{{期望}}');

    // NL 行回标：stepOrigin 覆盖全部步骤，行号在 1..4
    expect(acceptedCase.stepOrigin).toEqual(ORIGIN);
    const lines = acceptedCase.nl?.lines ?? [];
    expect(lines.length).toBe(4);
    const lineCount = NL_TEXT.split('\n').length;
    for (const origin of Object.values(acceptedCase.stepOrigin ?? {})) {
      expect(origin.nlLine).toBeGreaterThanOrEqual(1);
      expect(origin.nlLine).toBeLessThanOrEqual(lineCount);
    }

    // 带 datasetId validate：rowsCount=2
    const validate = await validateCase(createdCase.id, { datasetId: dataset.id });
    expect(validate.status).toBe(200);
    expect(unwrap<{ ok: boolean; rowsCount: number; stepsCount: number }>(validate)).toMatchObject({
      ok: true,
      rowsCount: 2,
      stepsCount: 4,
    });

    // 带 datasetId 运行：逐行 rowIndex / itemKey / title
    const started = await startRun({
      target: { kind: 'case', caseId: createdCase.id },
      datasetId: dataset.id,
    });
    expect(started.status).toBe(202);
    const runId = unwrap<{ id: string }>(started).id;
    const run = await waitRun(runId);
    expect(run.status).toBe('failed');
    expect(run.stats.expected).toBe(1);
    expect(run.stats.unexpected).toBe(1);
    expect(run.stats.skipped).toBe(0);

    const items = await listRunItems(runId);
    expect(items.items.length).toBe(2);
    const byRow = new Map(items.items.map((item) => [item.rowIndex, item]));
    expect([...byRow.keys()].sort()).toEqual([0, 1]);
    expect(items.items.map((item) => item.itemKey)).toEqual([`${createdCase.id}#row:0`, `${createdCase.id}#row:1`]);
    for (const item of items.items) {
      expect(item.title).toContain(`[row:${String(item.rowIndex ?? -1)}]`);
    }
    expect(byRow.get(0)?.outcome).toBe('expected');
    expect(byRow.get(1)?.outcome).toBe('unexpected');
    expect(byRow.get(1)?.attempts[0]?.status).toBe('failed');
    expect(byRow.get(1)?.attempts[0]?.error?.message ?? '').not.toBe('');

    // 失败证据：trace/screenshot 相关产物存在
    const artifacts = await listRunArtifacts(runId);
    const kinds = artifacts.items.map((artifact) => artifact.kind);
    expect(kinds).toContain('trace');
    expect(kinds).toContain('screenshot');
    expect(artifacts.items.length).toBeGreaterThanOrEqual(4);

    // 重读用例：variables 未被字面量替换
    const reread = await getCase(createdCase.id);
    expect(JSON.stringify(reread.steps)).toContain('{{用户名}}');
    expect(reread.nl?.status).toBe('generated');

    saveJson(SCENARIO, 'data-driven.json', {
      caseId: createdCase.id,
      dataset: { id: dataset.id, columns: dataset.columns, rowsCount: dataset.rowsCount, enabledRowsCount: dataset.enabledRowsCount },
      generation: { id: submitted.id, datasetColumns: generation.datasetColumns, steps: submitted.steps },
      accepted: { stepOrigin: acceptedCase.stepOrigin, steps: acceptedCase.steps },
      validate: unwrap(validate),
      run: { id: runId, status: run.status, stats: run.stats },
      items: items.items,
      artifacts: artifacts.items.map((artifact) => ({ kind: artifact.kind, sizeBytes: artifact.sizeBytes })),
    });

    // 边界 1：未知列（只含 用户名 的数据集）→ validate/run 422 UNKNOWN_COLUMN
    const partialDataset = await createDataset(createdCase.id, {
      name: 'A15 只含用户名',
      source: 'json',
      rows: [{ data: { 用户名: '张三' } }],
    });
    const badValidate = await validateCase(createdCase.id, { datasetId: partialDataset.id });
    expect(badValidate.status).toBe(422);
    expect(errorCodeOf(badValidate)).toBe('UNKNOWN_COLUMN');
    const badRun = await startRun({ target: { kind: 'case', caseId: createdCase.id }, datasetId: partialDataset.id });
    expect(badRun.status).toBe(422);
    expect(errorCodeOf(badRun)).toBe('UNKNOWN_COLUMN');

    // 边界 2：全禁用 → 422 EMPTY_DATASET
    const disabledDataset = await createDataset(createdCase.id, {
      name: 'A15 全禁用',
      source: 'json',
      rows: [{ data: { 用户名: '赵六', 期望: '你好，赵六' }, enabled: false }],
    });
    expect(disabledDataset.enabledRowsCount).toBe(0);
    const emptyValidate = await validateCase(createdCase.id, { datasetId: disabledDataset.id });
    expect(emptyValidate.status).toBe(422);
    expect(errorCodeOf(emptyValidate)).toBe('EMPTY_DATASET');
    const emptyRun = await startRun({ target: { kind: 'case', caseId: createdCase.id }, datasetId: disabledDataset.id });
    expect(emptyRun.status).toBe(422);
    expect(errorCodeOf(emptyRun)).toBe('EMPTY_DATASET');

    // 边界 3：submit 引用未知列（用 partialDataset 的列）→ 422 NL_SUBMIT_INVALID
    const secondGen = await createGeneration(createdCase.id);
    const secondClaim = unwrap<NlGeneration>(await claimNlGeneration(secondGen.id));
    const badSubmit = await submitNlGeneration(secondGen.id, {
      leaseId: secondClaim.leaseId ?? '',
      steps: STEPS,
      stepOrigin: ORIGIN,
      datasetId: partialDataset.id,
      generatorVersion: 'pw-e2e-agent/1.0.0',
    });
    expect(badSubmit.status).toBe(422);
    expect(errorCodeOf(badSubmit)).toBe('NL_SUBMIT_INVALID');
    const cancelled = await cancelNlGeneration(createdCase.id, secondGen.id);
    expect(cancelled.status).toBe(200);

    saveJson(SCENARIO, 'boundaries.json', {
      unknownColumn: { validate: badValidate.body, run: badRun.body },
      emptyDataset: { validate: emptyValidate.body, run: emptyRun.body },
      submitUnknownColumn: badSubmit.body,
    });
  });
});