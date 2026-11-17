/**
 * A6 回归（R3）：基线、两次真跑对比、变化检出与恢复、flaky/重试如实呈现。
 *
 * 对应 docs/acceptance-plan.md §3 A6 与反作弊条款 §4.3（禁止伪造基线/直接改 DB）。
 */

import { test, expect } from '@playwright/test';
import {
  createBaseline,
  createCase,
  createComparison,
  createRun,
  errorCodeOf,
  http,
  listBaselines,
  listComparisons,
  listRunItems,
  patchCase,
  unwrap,
  waitRun,
} from '../support/api.ts';
import { saveJson } from '../support/evidence.ts';
import { FIXTURE_BASE } from '../support/env.ts';
import type { Comparison, ComparisonDetail, ComparisonItem } from '../support/types.ts';

const SCENARIO = 'a6-regression';

const BASE_STEPS = [
  { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
  { id: 'st_2', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '你好，自动化' },
];

test.describe('A6 回归', () => {
  test('A6 基线 → 制造可检测变化 → 对比检出 regression → 恢复后 unchanged', async ({ page }) => {
    const created = await createCase({ name: `A6-回归-${String(Date.now())}`, mode: 'steps', steps: BASE_STEPS });

    // 1) 基线运行（passed）
    const runOk = await createRun({ target: { kind: 'case', caseId: created.id } });
    const finalOk = await waitRun(runOk.id);
    expect(finalOk.status).toBe('passed');
    expect(finalOk.stats.expected).toBe(1);

    const baselineResponse = await createBaseline({
      scope: 'case',
      scopeId: created.id,
      runId: finalOk.id,
      name: '验收基线-v1',
    });
    expect(baselineResponse.status).toBe(201);
    const baseline = unwrap<{ id: string; isDefault: boolean; runId: string }>(baselineResponse);
    expect(baseline.runId).toBe(finalOk.id);
    expect(baseline.isDefault).toBe(true);

    // 2) 改坏期望值（PATCH 需要 If-Match 版本号）→ 真跑失败
    const patched = await patchCase(created.id, 1, {
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
        { id: 'st_2', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '错误期望（本行必须失败）' },
      ],
    });
    expect(patched.version).toBe(2);

    const runBad = await createRun({ target: { kind: 'case', caseId: created.id } });
    const finalBad = await waitRun(runBad.id);
    expect(finalBad.status).toBe('failed');
    expect(finalBad.stats.unexpected).toBe(1);

    // 未通过的运行不能设为基线
    const badBaseline = await createBaseline({ scope: 'case', scopeId: created.id, runId: finalBad.id, name: '非法基线' });
    expect(badBaseline.status).toBe(409);
    expect(errorCodeOf(badBaseline)).toBe('BASELINE_SCOPE_MISMATCH');

    // 3) 对比：必须检出 newly_failed + verdict=regression + 归因
    const comparisonResponse = await createComparison({ baselineId: baseline.id, runId: finalBad.id });
    expect(comparisonResponse.status).toBe(201);
    const regression = unwrap<Comparison & { items: ComparisonItem[] }>(comparisonResponse);
    expect(regression.baselineId).toBe(baseline.id);
    expect(regression.baselineRunId).toBe(finalOk.id);
    expect(regression.runId).toBe(finalBad.id);
    expect(regression.summary.newly_failed).toBe(1);
    expect(regression.summary.still_passed).toBe(0);
    expect(regression.summary.verdict).toBe('regression');
    expect(regression.summary.verdictBasis).toBe('computed');
    expect(regression.items.length).toBe(1);
    const regressionItem = regression.items[0] as ComparisonItem;
    expect(regressionItem.itemKey).toBe(created.id);
    expect(regressionItem.change).toBe('newly_failed');
    expect(regressionItem.baseOutcome).toBe('expected');
    expect(regressionItem.targetOutcome).toBe('unexpected');
    expect(regressionItem.errorChanged).toBe(true);
    // 基线项是 passed（没有错误）→ baseErrorHash 为 null；目标项失败 → targetErrorHash 有值
    expect(regressionItem.baseErrorHash).toBeNull();
    expect(regressionItem.targetErrorHash).toMatch(/^[0-9a-f]{16,}$/);
    expect(regressionItem.attribution?.category).toBe('new_failure');
    // 失败原因分类（PRD R3.5）：官方 toHaveText 断言失败 → assertion_mismatch；
    // 注意 change 描述「回归差异」，failureCategory 才是「失败原因」，两者都在响应中保留。
    expect(regressionItem.attribution?.failureCategory).toBe('assertion_mismatch');
    expect(['medium', 'high']).toContain(regressionItem.attribution?.confidence);

    // 4) 恢复正确期望值 → 真跑通过 → 对比 unchanged
    const restored = await patchCase(created.id, 2, { steps: BASE_STEPS });
    expect(restored.version).toBe(3);
    const runFixed = await createRun({ target: { kind: 'case', caseId: created.id } });
    const finalFixed = await waitRun(runFixed.id);
    expect(finalFixed.status).toBe('passed');

    const fixedComparisonResponse = await createComparison({ baselineId: baseline.id, runId: finalFixed.id });
    expect(fixedComparisonResponse.status).toBe(201);
    const fixed = unwrap<Comparison & { items: ComparisonItem[] }>(fixedComparisonResponse);
    expect(fixed.summary.still_passed).toBe(1);
    expect(fixed.summary.newly_failed).toBe(0);
    expect(fixed.summary.verdict).toBe('unchanged');
    expect(fixed.summary.verdictBasis).toBe('computed');

    // 5) 对比可回读（GET 详情 / 列表过滤）
    const detail = unwrap<ComparisonDetail>(await http('GET', `/api/v1/comparisons/${regression.id}`));
    expect(detail.comparison.summary.verdict).toBe('regression');
    expect(detail.items.length).toBe(1);
    expect(detail.items[0]?.attribution?.failureCategory).toBe('assertion_mismatch');
    const list = await listComparisons(`?runId=${encodeURIComponent(finalBad.id)}&limit=10`);
    expect(list.items.some((item) => item.id === regression.id)).toBe(true);

    // 回归页 UI：归因列必须显示「断言不匹配」（failureCategory 中文），
    // 不得把变化类型 new_failure 当作失败原因展示。
    await page.goto(`/#/regression?comparisonId=${encodeURIComponent(regression.id)}`);
    await expect(page.getByRole('heading', { name: /回归对比/ }).first()).toBeVisible();
    await expect(page.getByRole('cell').filter({ hasText: '断言不匹配' }).first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('new_failure');

    const baselines = await listBaselines(`?scope=case&scopeId=${encodeURIComponent(created.id)}&limit=10`);
    expect(baselines.items.some((item) => item.id === baseline.id)).toBe(true);

    saveJson(SCENARIO, 'runs.json', {
      runOk: { id: finalOk.id, status: finalOk.status, stats: finalOk.stats },
      runBad: { id: finalBad.id, status: finalBad.status, stats: finalBad.stats },
      runFixed: { id: finalFixed.id, status: finalFixed.status, stats: finalFixed.stats },
      caseVersions: [1, patched.version, restored.version],
    });
    saveJson(SCENARIO, 'baseline.json', baseline);
    saveJson(SCENARIO, 'comparison-regression.json', regression);
    saveJson(SCENARIO, 'comparison-fixed.json', fixed);
    saveJson(SCENARIO, 'negative-baseline.json', badBaseline.body);
  });

  test('A6-flaky 官方重试语义：首跑失败、重试通过 → flaky；开启 failOnFlaky → failed', async () => {
    const token = `t-${String(Date.now())}`;
    const flakyCase = await createCase({
      name: `A6-flaky-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/flaky-once?token=${token}` },
        { id: 'st_2', action: 'expectText', target: { by: 'testId', testId: 'flaky-banner' }, value: '服务已恢复' },
      ],
    });

    const run = await createRun({ target: { kind: 'case', caseId: flakyCase.id }, options: { retries: 1 } });
    const final = await waitRun(run.id);
    expect(final.status).toBe('passed');
    expect(final.stats.flaky).toBe(1);
    expect(final.stats.unexpected).toBe(0);
    expect(final.stats.expected).toBe(0);
    expect(final.exitCode).toBe(0);

    const items = await listRunItems(run.id);
    expect(items.items.length).toBe(1);
    const item = items.items[0];
    expect(item?.outcome).toBe('flaky');
    expect(item?.attempts.length).toBe(2);
    expect(item?.attempts[0]?.status).toBe('failed');
    expect(item?.attempts[1]?.status).toBe('passed');
    expect(item?.attempts[0]?.error?.message ?? '').toMatch(/toHaveText|expect/i);

    // 官方 failOnFlakyTests：flaky 也判失败（配置项自 1.52 起）
    const token2 = `${token}-fail`;
    const flakyCase2 = await createCase({
      name: `A6-flaky-判失败-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/flaky-once?token=${token2}` },
        { id: 'st_2', action: 'expectText', target: { by: 'testId', testId: 'flaky-banner' }, value: '服务已恢复' },
      ],
    });
    const strictRun = await createRun({
      target: { kind: 'case', caseId: flakyCase2.id },
      options: { retries: 1, failOnFlaky: true },
    });
    const strictFinal = await waitRun(strictRun.id);
    expect(strictFinal.stats.flaky).toBe(1);
    expect(strictFinal.status).toBe('failed');
    expect(strictFinal.exitCode).not.toBe(0);

    saveJson(SCENARIO, 'flaky.json', {
      run: { id: final.id, status: final.status, stats: final.stats, exitCode: final.exitCode, items: items.items },
      failOnFlaky: {
        run: { id: strictFinal.id, status: strictFinal.status, stats: strictFinal.stats, exitCode: strictFinal.exitCode },
      },
    });
  });
});