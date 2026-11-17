/**
 * A4 套件批量运行（R1/R3）：套件 = 有序用例集合；一次运行产出全部用例的逐项结果。
 *
 * 对应 docs/acceptance-plan.md §3 A4。
 */

import { test, expect } from '@playwright/test';
import { createCase, createRun, createSuite, http, listRunItems, waitRun } from '../support/api.ts';
import { saveJson } from '../support/evidence.ts';
import { FIXTURE_BASE } from '../support/env.ts';

const SCENARIO = 'a4-suite';

test.describe('A4 套件批量', () => {
  test('A4 套件运行：两个用例的逐项结果都进入同一运行', async () => {
    const suffix = String(Date.now());
    const case1 = await createCase({
      name: `A4-用例一-${suffix}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
        { id: 'st_2', action: 'expectVisible', target: { by: 'role', role: 'heading', name: '演示站' } },
      ],
    });
    const case2 = await createCase({
      name: `A4-用例二-${suffix}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/login` },
        { id: 'st_2', action: 'expectVisible', target: { by: 'role', role: 'heading', name: '登录' } },
      ],
    });

    const suite = await createSuite({ name: `A4-套件-${suffix}`, caseIds: [case1.id, case2.id] });
    expect(suite.casesCount).toBe(2);
    expect(suite.caseIds).toEqual([case1.id, case2.id]);

    const run = await createRun({ target: { kind: 'suite', suiteId: suite.id } });
    expect(run.kind).toBe('suite');
    expect(run.suiteId).toBe(suite.id);
    expect(run.caseId).toBeNull();

    const final = await waitRun(run.id);
    // 用例二的 expectText 期望空字符串在空元素上通过；两用例均应通过
    expect(final.status).toBe('passed');
    expect(final.kind).toBe('suite');
    expect(final.suiteId).toBe(suite.id);
    expect(final.stats.expected).toBe(2);
    expect(final.stats.unexpected).toBe(0);
    expect(final.itemsCount).toBe(2);

    const items = await listRunItems(run.id);
    expect(items.items.length).toBe(2);
    const keys = items.items.map((item) => item.itemKey).sort();
    expect(keys).toEqual([case1.id, case2.id].sort());
    for (const item of items.items) {
      expect(item.outcome).toBe('expected');
      expect(item.rowIndex).toBeNull();
      expect([case1.id, case2.id]).toContain(item.caseId);
    }

    // 套件运行不支持指定数据集（合同 §4）
    const withDataset = await http('POST', '/api/v1/runs', {
      body: { target: { kind: 'suite', suiteId: suite.id }, datasetId: 'ds_whatever' },
    });
    expect(withDataset.status).toBe(422);
    expect((withDataset.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');

    // 套件引用不存在的用例 → 422 UNKNOWN_CASE
    const badSuite = await http('POST', '/api/v1/suites', {
      body: { name: `A4-坏套件-${suffix}`, caseIds: [case1.id, 'case_not_exists_e2e'] },
    });
    expect(badSuite.status).toBe(422);
    expect((badSuite.body as { error: { code: string } }).error.code).toBe('UNKNOWN_CASE');

    saveJson(SCENARIO, 'suite.json', suite);
    saveJson(SCENARIO, 'run.json', { id: final.id, status: final.status, stats: final.stats, kind: final.kind, suiteId: final.suiteId });
    saveJson(SCENARIO, 'items.json', items.items);
    saveJson(SCENARIO, 'negative.json', { withDataset: withDataset.body, badSuite: badSuite.body });
  });

  /**
   * F-SUITE-1（t18 已修复，2026-11-11）：套件内某成员用例「引擎级失败」时，运行不得判 passed。
   *
   * 复现：成员 B 的步骤 value=""（API 接受，引擎编译期 requireValue 拒绝空串）→ 引擎返回 status=error。
   * 修复前（证据：suite-member-error-before-fix.json）：run=passed、itemsCount=1、error=null（假绿）。
   * 修复后：run=error、error.code=INVALID_STEP（含 caseId 与原因）、itemsCount=2（A expected + B missing）、
   *         stats/exitCode/artifacts 保留、warnings 指明 B、单 B → error+1 missing、单 A → passed。
   */
  test('A4-负路径（F-SUITE-1）套件内成员引擎失败不得判 passed，需可诊断', async () => {
    const suffix = String(Date.now());
    const goodCase = await createCase({
      name: `A4-成员成功-${suffix}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
        { id: 'st_2', action: 'expectVisible', target: { by: 'testId', testId: 'hello' } },
      ],
    });
    // expectText 的 value 为空串：合同 §2.2 只要求「提供 value」，API 接受；引擎编译要求非空 → 编译失败
    const brokenCase = await createCase({
      name: `A4-成员编译失败-${suffix}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
        { id: 'st_2', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '' },
      ],
    });
    expect(brokenCase.id).toMatch(/^case_/);

    // ① 混合套件：不得假绿
    const suite = await createSuite({ name: `A4-假绿套件-${suffix}`, caseIds: [goodCase.id, brokenCase.id] });
    const run = await createRun({ target: { kind: 'suite', suiteId: suite.id } });
    const final = await waitRun(run.id);
    const items = await listRunItems(run.id);

    saveJson(SCENARIO, 'suite-member-error.json', {
      suiteId: suite.id,
      runId: run.id,
      status: final.status,
      exitCode: final.exitCode,
      stats: final.stats,
      itemsCount: final.itemsCount,
      items: items.items.map((item) => ({ itemKey: item.itemKey, outcome: item.outcome, title: item.title })),
      error: final.error,
      diagnostics: { command: final.diagnostics.command, warnings: final.diagnostics.warnings },
      goodCaseId: goodCase.id,
      brokenCaseId: brokenCase.id,
    });

    expect(final.status).toBe('error');
    expect(final.error?.code).toBe('INVALID_STEP');
    expect(final.error?.message).toContain(brokenCase.id);
    expect(final.error?.message).toContain('INVALID_STEP');
    // 已执行成员的结果与统计保留（不是整批丢失）
    expect(final.stats.expected).toBe(1);
    expect(final.exitCode).toBe(0);
    expect(final.diagnostics.command.length).toBeGreaterThanOrEqual(3);
    expect(final.diagnostics.warnings.some((warning) => warning.includes(brokenCase.id))).toBe(true);
    // 两项都在：A expected + B missing（未执行）
    expect(final.itemsCount).toBe(2);
    expect(items.items.length).toBe(2);
    const byKey = new Map(items.items.map((item) => [item.itemKey, item]));
    expect(byKey.get(goodCase.id)?.outcome).toBe('expected');
    expect(byKey.get(brokenCase.id)?.outcome).toBe('missing');
    expect(byKey.get(brokenCase.id)?.title).toContain('未执行');

    // ② 单 B（编译失败）→ error + 1 个 missing
    const brokenRun = await createRun({ target: { kind: 'case', caseId: brokenCase.id } });
    const brokenFinal = await waitRun(brokenRun.id);
    const brokenItems = await listRunItems(brokenRun.id);
    expect(brokenFinal.status).toBe('error');
    expect(brokenFinal.error?.code).toBe('INVALID_STEP');
    expect(brokenFinal.itemsCount).toBe(1);
    expect(brokenItems.items[0]?.outcome).toBe('missing');

    // ③ 单 A（合法）→ passed（修复不得误伤正常运行）
    const goodRun = await createRun({ target: { kind: 'case', caseId: goodCase.id } });
    const goodFinal = await waitRun(goodRun.id);
    expect(goodFinal.status).toBe('passed');
    expect(goodFinal.itemsCount).toBe(1);
    expect(goodFinal.error).toBeNull();

    saveJson(SCENARIO, 'suite-member-error-single.json', {
      brokenRun: { id: brokenFinal.id, status: brokenFinal.status, error: brokenFinal.error, itemsCount: brokenFinal.itemsCount },
      goodRun: { id: goodFinal.id, status: goodFinal.status, itemsCount: goodFinal.itemsCount },
    });
  });
});