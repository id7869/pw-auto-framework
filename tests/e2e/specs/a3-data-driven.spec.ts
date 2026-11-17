/**
 * A3 数据驱动（需求 R4）：数据集、多行执行、逐行结果映射、无假绿。
 *
 * 对应 docs/acceptance-plan.md §3 A3：
 *  - 3 行数据（第 2 行故意写错期望值 → 必须失败；第 3 行 disabled → 不执行）；
 *  - 一行 = 一个官方 test，标题带 [row:N]，itemKey = caseId#row:N；
 *  - 汇总 stats.expected=1 / unexpected=1，运行 failed（禁止把失败行算成通过）；
 *  - 全 disabled → 422 EMPTY_DATASET；
 *  - 特殊字符（中文引号/换行）不破坏编译。
 */

import { test, expect } from '@playwright/test';
import { createCase, createDataset, createRun, http, listRunItems, unwrap, waitRun } from '../support/api.ts';
import { saveJson } from '../support/evidence.ts';
import { FIXTURE_BASE } from '../support/env.ts';

const SCENARIO = 'a3-data-driven';

const CASE_STEPS = [
  { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/?name={{名字}}` },
  { id: 'st_2', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '{{期望}}' },
];

test.describe('A3 数据驱动', () => {
  test('A3 三行数据：逐行结果正确映射，失败行必须判失败', async () => {
    const created = await createCase({ name: `A3-数据驱动-${String(Date.now())}`, mode: 'steps', steps: CASE_STEPS });
    const dataset = await createDataset(created.id, {
      name: '三行启用数据（第 2 行故意错）+ 1 行 disabled',
      source: 'json',
      rows: [
        { data: { 名字: '张三', 期望: '你好，张三' } },
        { data: { 名字: '李四', 期望: '错误文本（本行必须失败）' } },
        { data: { 名字: '王五', 期望: '你好，王五' } },
        { data: { 名字: '赵六', 期望: '你好，赵六' }, enabled: false },
      ],
    });
    expect(dataset.rowsCount).toBe(4);
    expect(dataset.enabledRowsCount).toBe(3);
    expect([...dataset.columns].sort()).toEqual(['名字', '期望'].sort());

    // 不带 datasetId 的编译校验（预期语义：无列可对照 → ok:false + UNKNOWN_COLUMN 警告；
    // 不是缺陷，权威说明见 AGENTS.md §3 / traceability §6.1（t17 更新后））
    const plainValidate = await http('POST', `/api/v1/cases/${created.id}/validate`, { body: {} });
    expect(plainValidate.status).toBe(200);
    const plainBody = unwrap<{ ok: boolean; stepsCount: number; warnings: { code: string }[] }>(plainValidate);
    expect(plainBody.ok).toBe(false);
    expect(plainBody.stepsCount).toBe(2);
    expect(plainBody.warnings.filter((warning) => warning.code === 'UNKNOWN_COLUMN').length).toBeGreaterThanOrEqual(1);

    // 带 datasetId 的编译校验（合同 §2.8：合法列 → ok:true + rowsCount=2；t15 修复后行为）
    const datasetValidate = await http('POST', `/api/v1/cases/${created.id}/validate`, { body: { datasetId: dataset.id } });
    expect(datasetValidate.status).toBe(200);
    const datasetValidateBody = unwrap<{
      ok: boolean;
      stepsCount: number;
      rowsCount: number;
      warnings: { code: string; message: string }[];
    }>(datasetValidate);
    expect(datasetValidateBody.ok).toBe(true);
    expect(datasetValidateBody.stepsCount).toBe(2);
    expect(datasetValidateBody.rowsCount).toBe(3);
    expect(datasetValidateBody.warnings.filter((warning) => warning.code === 'UNKNOWN_COLUMN')).toEqual([]);
    saveJson(SCENARIO, 'validate-with-dataset.json', datasetValidateBody);

    // 真实运行：3 个启用行 = 3 个官方 test（2 通过 1 失败），第 4 行 disabled 不执行
    const run = await createRun({ target: { kind: 'case', caseId: created.id }, datasetId: dataset.id });
    const final = await waitRun(run.id);
    expect(final.status).toBe('failed');
    expect(final.exitCode).toBe(1);
    expect(final.stats.expected).toBe(2);
    expect(final.stats.unexpected).toBe(1);
    expect(final.stats.skipped).toBe(0);
    expect(final.stats.flaky).toBe(0);

    const items = await listRunItems(run.id);
    expect(items.items.length).toBe(3);
    const byRow = [...items.items].sort((a, b) => (a.rowIndex ?? -1) - (b.rowIndex ?? -1));
    expect(byRow.map((item) => item.rowIndex)).toEqual([0, 1, 2]);
    expect(byRow.map((item) => item.outcome)).toEqual(['expected', 'unexpected', 'expected']);
    expect(byRow.map((item) => item.itemKey)).toEqual([
      `${created.id}#row:0`,
      `${created.id}#row:1`,
      `${created.id}#row:2`,
    ]);
    for (const item of byRow) {
      expect(item.title).toContain(`[row:${String(item.rowIndex)}]`);
      expect(item.caseId).toBe(created.id);
      expect(item.attempts.length).toBeGreaterThanOrEqual(1);
    }
    // 失败行必须带官方错误信息（不是空壳）
    const failedRow = byRow[1];
    expect(failedRow?.attempts[0]?.status).toBe('failed');
    expect(failedRow?.attempts[0]?.error?.message ?? '').toMatch(/expect|toHaveText|Timed out/i);
    expect(failedRow?.attempts[0]?.errorHash).toMatch(/^[0-9a-f]{16,}$/);

    // 第 4 行 disabled：不执行（没有 #row:3）
    expect(items.items.some((item) => item.rowIndex === 3)).toBe(false);

    saveJson(SCENARIO, 'dataset.json', dataset);
    saveJson(SCENARIO, 'run-failed.json', { id: final.id, status: final.status, stats: final.stats, exitCode: final.exitCode });
    saveJson(SCENARIO, 'items.json', items.items);
  });

  test('A3-边界 特殊字符（中文引号/换行）不破坏编译，仍可执行', async () => {
    const created = await createCase({ name: `A3-特殊字符-${String(Date.now())}`, mode: 'steps', steps: CASE_STEPS });
    const dataset = await createDataset(created.id, {
      name: '特殊字符',
      rows: [{ data: { 名字: '王"五', 期望: '你好，王"五', 备注: '含"引号"与\n换行' } }],
    });
    const replaced = await http('PUT', `/api/v1/datasets/${dataset.id}/rows`, {
      body: { rows: [{ data: { 名字: '王"五', 期望: '你好，王"五', 备注: '含"引号"与\n换行' } }] },
    });
    expect(replaced.status).toBe(200);

    const run = await createRun({ target: { kind: 'case', caseId: created.id }, datasetId: dataset.id });
    const final = await waitRun(run.id);
    expect(final.status).toBe('passed');
    expect(final.stats.expected).toBe(1);

    const items = await listRunItems(run.id);
    expect(items.items.length).toBe(1);
    expect(items.items[0]?.itemKey).toBe(`${created.id}#row:0`);
    expect(items.items[0]?.outcome).toBe('expected');
    saveJson(SCENARIO, 'special-chars-run.json', { id: final.id, status: final.status, stats: final.stats, items: items.items });
  });

  test('A3-负路径 全行 disabled → 422 EMPTY_DATASET；未知列 → 422 UNKNOWN_COLUMN', async () => {
    const created = await createCase({ name: `A3-负路径-${String(Date.now())}`, mode: 'steps', steps: CASE_STEPS });
    const dataset = await createDataset(created.id, {
      name: '全禁用',
      rows: [
        { data: { 名字: '甲', 期望: 'x' }, enabled: false },
        { data: { 名字: '乙', 期望: 'y' }, enabled: false },
      ],
    });

    const runResponse = await http('POST', '/api/v1/runs', {
      body: { target: { kind: 'case', caseId: created.id }, datasetId: dataset.id },
    });
    expect(runResponse.status).toBe(422);
    expect((runResponse.body as { error: { code: string } }).error.code).toBe('EMPTY_DATASET');

    // 未知列：步骤引用 {{不存在的列}}，带该数据集运行 → 422 UNKNOWN_COLUMN
    const badCase = await createCase({
      name: `A3-未知列-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
        { id: 'st_2', action: 'fill', target: { by: 'testId', testId: 'name' }, value: '{{不存在的列}}' },
      ],
    });
    const badDataset = await createDataset(badCase.id, { name: '只有名字列', rows: [{ data: { 名字: '甲' } }] });
    const badRun = await http('POST', '/api/v1/runs', {
      body: { target: { kind: 'case', caseId: badCase.id }, datasetId: badDataset.id },
    });
    expect(badRun.status).toBe(422);
    expect((badRun.body as { error: { code: string } }).error.code).toBe('UNKNOWN_COLUMN');

    // 编译校验阶段同样拦截（t15 语义：带 datasetId 的 validate 按启用行列校验）
    const badValidate = await http('POST', `/api/v1/cases/${badCase.id}/validate`, { body: { datasetId: badDataset.id } });
    expect(badValidate.status).toBe(422);
    expect((badValidate.body as { error: { code: string } }).error.code).toBe('UNKNOWN_COLUMN');

    saveJson(SCENARIO, 'negative.json', { emptyDataset: runResponse.body, unknownColumn: badRun.body, unknownColumnValidate: badValidate.body });
  });
});