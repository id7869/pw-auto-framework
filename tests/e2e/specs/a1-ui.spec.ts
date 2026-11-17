/**
 * A1 UI 主流程（R1/R6：普通用户只写业务句子，不选动作）。
 *
 * 覆盖 docs/acceptance-plan.md §3 A1 与 §3.1 N1：
 *  1. 打开 /#/cases → 「新建用例」；
 *  2. 新建默认 NL 编辑器：无动作下拉（select 里不得出现 goto/click/fill 等动作），只有业务句子文本域；
 *  3. 保存 → 草稿（draft）；生成任务 → 由独立"模拟 agent"（非模型）claim/submit；
 *  4. 页面轮询到 ready → 步骤卡片（来源 NL 行/动作/定位器/值/依据）→ 接受（Accept）；
 *  5. 步骤（只读）/代码（只读）三档视图；代码含 test.describe( 与 expect(；
 *  6. 运行 → passed、stats.expected=1、逐项 expected、产物可取；刷新后仍 passed；
 *  7. 负路径：空名称保存 → 中文校验错误。
 */

import { test, expect } from '@playwright/test';
import { listNlGenerationsForCase, listRunArtifacts, listRunItems, unwrap } from '../support/api.ts';
import { saveJson, saveScreenshot } from '../support/evidence.ts';
import { FIXTURE_BASE } from '../support/env.ts';
import { completeQueuedGeneration, generationItems, readCase } from '../support/nl-agent.ts';
import type { NlGeneration } from '../support/types.ts';

const SCENARIO = 'a1-ui';

const NL_TEXT = [
  `打开 ${FIXTURE_BASE}/`,
  '页面上应该看到标题「演示站」',
  '页面上应该出现文本「你好，自动化」',
].join('\n');

const STEPS = [
  { id: 's1', action: 'goto' as const, url: `${FIXTURE_BASE}/`, label: '打开演示站' },
  { id: 's2', action: 'expectVisible' as const, target: { by: 'role' as const, role: 'heading', name: '演示站' }, label: '标题可见' },
  { id: 's3', action: 'expectText' as const, target: { by: 'testId' as const, testId: 'hello' }, value: '你好，自动化', label: '问候语' },
];

const ORIGIN = { s1: { nlLine: 1 }, s2: { nlLine: 2 }, s3: { nlLine: 3 } };

test.describe('A1 UI 主流程（NL-first）', () => {
  test('A1 NL：新建无动作下拉 → 保存 → 生成/接受 → 三视图 → 运行 passed', async ({ page }) => {
    const caseName = `E2E-NL-${String(Date.now())}`;

    // 1) 用例列表
    await page.goto('/#/cases');
    await expect(page.getByRole('heading', { name: '测试用例', level: 1 })).toBeVisible();
    const createLink = page.getByRole('link', { name: '新建用例' }).first();
    await expect(createLink).toBeVisible();
    await saveScreenshot(page, SCENARIO, '01-cases-list.png');

    // 2) 新建默认 NL 编辑器：无动作下拉
    await createLink.click();
    await expect(page).toHaveURL(/#\/cases\/new$/);
    await expect(page.getByRole('heading', { name: '新建自然语言用例', level: 1 })).toBeVisible();
    await expect(page.locator('#nl-source-text')).toBeVisible();
    await expect(page.locator('#pw-add-step-action')).toHaveCount(0);
    const optionValues = await page
      .locator('select option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    for (const action of ['goto', 'click', 'fill', 'press', 'selectOption', 'expectVisible', 'expectText']) {
      expect(optionValues).not.toContain(action);
    }
    await expect(page.getByText('不需要选择 goto/click/fill 等动作', { exact: false })).toBeVisible();

    await page.locator('#nl-case-name').fill(caseName);
    await page.locator('#nl-case-description').fill('验收用例：业务句子 → 生成 → 接受 → 运行 fixture');
    await page.locator('#nl-source-text').fill(NL_TEXT);
    await saveScreenshot(page, SCENARIO, '02-case-editor-nl.png');

    // 3) 保存（新建 → 跳编辑页）
    await page.getByRole('button', { name: '保存', exact: true }).first().click();
    await expect(page).toHaveURL(/#\/cases\/case_[^/]+\/edit/);
    const caseId = decodeURIComponent((/\/cases\/(case_[^/]+)\/edit/.exec(page.url()) ?? [])[1] ?? '');
    expect(caseId).toMatch(/^case_/);
    await expect(page.getByText('草稿（尚未生成）').first()).toBeVisible();

    // 4) 创建生成任务（UI）→ 独立模拟 agent 领取并提交
    await page.getByRole('button', { name: '生成步骤（agent）' }).click();
    await expect(page.getByText('生成任务已创建')).toBeVisible();
    await expect
      .poll(async () => generationItems(await listNlGenerationsForCase(caseId)).map((item) => item.status), {
        timeout: 30_000,
      })
      .toContain('queued');

    const ready = await completeQueuedGeneration(caseId, { steps: STEPS, stepOrigin: ORIGIN });
    expect(ready.status).toBe('ready');
    expect(ready.stepOrigin).toEqual(ORIGIN);

    // 5) 页面轮询到 ready：步骤卡片（来源 NL 行/动作/定位器/值/依据）
    await expect(page.getByRole('button', { name: '接受（Accept）并写入 steps' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.nl-step-card')).toHaveCount(3);
    await expect(page.getByText('来源 NL 行').first()).toBeVisible();
    await expect(page.locator('.nl-step-card').first().getByText('第 1 行').first()).toBeVisible();
    await saveScreenshot(page, SCENARIO, '03-generation-ready.png');

    await page.getByRole('button', { name: '接受（Accept）并写入 steps' }).click();
    await expect(page.getByText('已接受生成结果')).toBeVisible();

    // 6) 三档视图：步骤（只读）
    await expect(page.getByRole('region', { name: '用例步骤（只读）' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'NL 行' })).toBeVisible();
    const stepRows = page.getByRole('region', { name: '用例步骤（只读）' }).getByRole('row');
    await expect(stepRows).toHaveCount(4); // header + 3
    await expect(page.getByText('共 3 步', { exact: false })).toBeVisible();

    // 7) 代码（只读）视图
    await page.getByRole('tab', { name: '代码（只读）' }).click();
    await page.getByRole('button', { name: '刷新预览' }).click();
    await expect(page.getByText('test.describe(', { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('expect(', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('代码只读；不会从代码反向生成 NL', { exact: false })).toBeVisible();
    await saveScreenshot(page, SCENARIO, '04-code-preview.png');

    // 8) 运行 → passed
    await page.getByRole('button', { name: '运行', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '新建运行' })).toBeVisible();
    await expect(dialog.getByText(`用例：${caseName}`)).toBeVisible();
    await dialog.getByRole('button', { name: '创建运行' }).click();
    await expect(page).toHaveURL(/#\/runs\/run_/);
    const runId = decodeURIComponent((/#\/runs\/(run_[0-9a-f]+)/.exec(page.url()) ?? [])[1] ?? '');
    expect(runId).toMatch(/^run_/);

    await expect(page.locator('.pill[data-status="passed"]')).toBeVisible({ timeout: 150_000 });
    const stats = page.locator('dl[aria-label="运行统计"]');
    await expect(stats.locator('dd').nth(0)).toHaveText('1');
    await expect(stats.locator('dd').nth(1)).toHaveText('0');
    await expect(stats.locator('dd').nth(2)).toHaveText('0');
    await expect(stats.locator('dd').nth(5)).toHaveText('0');

    const itemsRegion = page.getByRole('region', { name: '运行逐项结果' });
    await expect(itemsRegion).toBeVisible();
    const itemRow = itemsRegion.getByRole('row').filter({ hasText: caseName });
    await expect(itemRow).toBeVisible();
    await expect(itemRow.locator('.pill[data-outcome="expected"]')).toBeVisible();
    await expect(itemRow.locator('td').first()).toHaveText(caseId);

    // 产物链接可取
    const artifactLinks = page.getByRole('link', { name: '打开 / 下载' });
    expect(await artifactLinks.count()).toBeGreaterThanOrEqual(3);
    const firstHref = await artifactLinks.first().getAttribute('href');
    expect(firstHref).toMatch(new RegExp(`/api/v1/runs/${runId}/artifacts/art_.+/content`));
    const contentResponse = await page.request.get(firstHref as string);
    expect(contentResponse.status()).toBe(200);
    expect((await contentResponse.body()).byteLength).toBeGreaterThan(0);
    await saveScreenshot(page, SCENARIO, '05-run-detail.png');

    // 与后端交叉核对：itemKey=caseId、stepOrigin 覆盖全部步骤、mode=steps
    const items = await listRunItems(runId);
    const artifacts = await listRunArtifacts(runId);
    expect(items.items.length).toBe(1);
    expect(items.items[0]?.itemKey).toBe(caseId);
    expect(items.items[0]?.outcome).toBe('expected');
    expect(artifacts.items.length).toBeGreaterThanOrEqual(3);

    const caseData = await readCase(caseId);
    expect(caseData.mode).toBe('steps');
    expect(caseData.steps.length).toBe(3);
    expect(Object.keys(caseData.stepOrigin ?? {}).sort()).toEqual(['s1', 's2', 's3']);

    saveJson(SCENARIO, 'run.json', {
      caseId,
      caseName,
      runId,
      steps: caseData.steps.length,
      stepOrigin: caseData.stepOrigin,
      generation: { id: ready.id, status: ready.status, sourceHash: ready.sourceHash },
      items: items.items,
      artifacts: artifacts.items,
    });

    // 刷新后仍 passed
    await page.reload();
    await expect(page.locator('.pill[data-status="passed"]')).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByRole('region', { name: '运行逐项结果' }).getByRole('row').filter({ hasText: caseName }),
    ).toBeVisible();
  });

  test('A1-负路径 空名称保存 → 中文校验错误可见；NL 编辑器仍可见', async ({ page }) => {
    await page.goto('/#/cases/new');
    await expect(page.getByRole('heading', { name: '新建自然语言用例', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: '保存', exact: true }).first().click();
    const alert = page.getByRole('alert').filter({ hasText: '请填写用例名称' }).first();
    await expect(alert).toBeVisible();
    await expect(page.getByText('请修正以下问题')).toBeVisible();
    await expect(page).toHaveURL(/#\/cases\/new$/);
    await expect(page.locator('#nl-source-text')).toBeVisible();
    await saveScreenshot(page, SCENARIO, '06-validation-error.png');
  });
});
