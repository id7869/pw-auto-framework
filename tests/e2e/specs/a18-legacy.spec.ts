/**
 * A18 旧模式零回归（R1~R5；N7）。
 *
 * 覆盖：
 *  - 不带 nl 的 steps 用例：创建/validate/run passed，GET 返回 nl=null；
 *  - mode=code 用例：创建/run passed；
 *  - 旧版结构化编辑器仍可用（#case-mode、#pw-add-step-action），NL 编辑器不出现；
 *  - 数据集逐行运行 + 基线 + 对比（verdict/verdictBasis）仍工作。
 */

import { test, expect } from '@playwright/test';
import {
  createBaseline,
  createCase,
  createComparison,
  createDataset,
  getCase,
  listRunItems,
  startRun,
  unwrap,
  validateCase,
  waitRun,
} from '../support/api.ts';
import { saveJson, saveScreenshot } from '../support/evidence.ts';
import { FIXTURE_BASE } from '../support/env.ts';
import type { CaseStep } from '../support/types.ts';

const SCENARIO = 'a18-legacy';

const STEPS: CaseStep[] = [
  { id: 's1', action: 'goto', url: `${FIXTURE_BASE}/`, label: '打开演示站' },
  { id: 's2', action: 'expectVisible', target: { by: 'role', role: 'heading', name: '演示站' }, label: '标题可见' },
  { id: 's3', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '你好，自动化', label: '问候语' },
];

const CODE = [
  "test('旧代码模式：打开 fixture 并断言标题', async ({ page }) => {",
  `  await page.goto('${FIXTURE_BASE}/');`,
  "  await expect(page.getByRole('heading', { name: '演示站' })).toBeVisible();",
  "  await expect(page.getByTestId('hello')).toHaveText('你好，自动化');",
  '});',
].join('\n');

function uniq(prefix: string): string {
  return `${prefix}-${String(Date.now())}-${String(Math.floor(Math.random() * 1000))}`;
}

test.describe('A18 旧模式零回归', () => {
  test('A18-1 steps/code 用例 + 旧版编辑器 UI + 数据集/基线/对比', async ({ page }) => {
    // 1) steps 用例（无 nl）
    const stepsCase = await createCase({ name: uniq('A18-Steps'), mode: 'steps', steps: STEPS });
    expect(stepsCase.nl).toBeNull();
    const validate = await validateCase(stepsCase.id);
    expect(validate.status).toBe(200);
    expect(unwrap<{ ok: boolean; stepsCount: number }>(validate)).toMatchObject({ ok: true, stepsCount: 3 });

    const stepsRun = await waitRun(unwrap<{ id: string }>(await startRun({ target: { kind: 'case', caseId: stepsCase.id } })).id);
    expect(stepsRun.status).toBe('passed');
    expect(stepsRun.stats.expected).toBe(1);
    const stepsItems = await listRunItems(stepsRun.id);
    expect(stepsItems.items[0]?.itemKey).toBe(stepsCase.id);
    expect(stepsItems.items[0]?.outcome).toBe('expected');

    // 2) code 用例
    const codeCase = await createCase({ name: uniq('A18-Code'), mode: 'code', code: CODE });
    expect(codeCase.mode).toBe('code');
    const codeRun = await waitRun(unwrap<{ id: string }>(await startRun({ target: { kind: 'case', caseId: codeCase.id } })).id);
    expect(codeRun.status).toBe('passed');
    expect(codeRun.stats.expected).toBe(1);
    expect(JSON.stringify(codeRun.diagnostics.command)).toContain('playwright');

    // 3) 旧版结构化编辑器仍可用（NL 编辑器不出现）
    await page.goto(`/#/cases/${stepsCase.id}/edit`);
    await expect(page.getByRole('heading', { name: /编辑用例/ })).toBeVisible();
    await expect(page.locator('#case-mode')).toBeVisible();
    await expect(page.locator('#pw-add-step-action')).toBeVisible();
    await expect(page.locator('#nl-source-text')).toHaveCount(0);
    await expect(page.getByText('结构化步骤', { exact: false }).first()).toBeVisible();
    await saveScreenshot(page, SCENARIO, '01-legacy-editor.png');

    // 4) 数据集 + 基线 + 对比（两次真实运行）
    const dataset = await createDataset(stepsCase.id, {
      name: 'A18 两行',
      source: 'json',
      rows: [{ data: { 名字: '张三' } }, { data: { 名字: '李四' } }],
    });
    // steps 未引用变量：逐行仍各生成一个 test（同一断言重复执行）
    const baselineRun = await waitRun(
      unwrap<{ id: string }>(await startRun({ target: { kind: 'case', caseId: stepsCase.id }, datasetId: dataset.id })).id,
    );
    expect(baselineRun.status).toBe('passed');
    expect(baselineRun.stats.expected).toBe(2);
    const baselineItems = await listRunItems(baselineRun.id);
    expect(baselineItems.items.map((item) => item.itemKey)).toEqual([
      `${stepsCase.id}#row:0`,
      `${stepsCase.id}#row:1`,
    ]);

    const baseline = unwrap<{ id: string }>(
      await createBaseline({
        scope: 'case',
        scopeId: stepsCase.id,
        runId: baselineRun.id,
        name: 'A18 基线',
      }),
    );
    expect(baseline.id).toMatch(/^base_/);

    const targetRun = await waitRun(
      unwrap<{ id: string }>(await startRun({ target: { kind: 'case', caseId: stepsCase.id }, datasetId: dataset.id })).id,
    );
    expect(targetRun.status).toBe('passed');
    const comparison = unwrap<{
      summary: { verdict: string; verdictBasis: string; still_passed: number; newly_failed: number };
    }>(await createComparison({ baselineId: baseline.id, runId: targetRun.id }));
    expect(comparison.summary.verdict).toBe('unchanged');
    expect(comparison.summary.verdictBasis).toBe('computed');
    expect(comparison.summary.newly_failed).toBe(0);
    expect(comparison.summary.still_passed).toBe(2);

    saveJson(SCENARIO, 'legacy.json', {
      stepsCase: { id: stepsCase.id, validate: unwrap(validate), run: { id: stepsRun.id, status: stepsRun.status, stats: stepsRun.stats } },
      codeCase: { id: codeCase.id, run: { id: codeRun.id, status: codeRun.status, stats: codeRun.stats } },
      dataset: { id: dataset.id, rows: dataset.rowsCount },
      baseline: { id: baseline.id, run: baselineRun.id, expected: baselineRun.stats.expected },
      comparison: comparison.summary,
    });
  });
});