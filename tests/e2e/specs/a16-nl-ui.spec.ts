/**
 * A16 UI：NL 数据驱动（列插入/逐行结果/NL 行回标）+ Agent 页三卡片（R6/R7；N1/N3/N0 UI 部分）。
 *
 * 覆盖：
 *  - Agent 页仅 3 张 harness 卡片（Claude Code / Codex CLI / DeepSeek Harness），展示 skillPaths、
 *    requiresMcp:false；无安装按钮/安装状态、无 6 loop/旧入口控件；
 *  - NL 编辑页选择数据集 → 数据集列可见 → 点击列按钮插入 {{列}}；
 *  - 生成 → accept → 带 datasetId 运行 → 逐行 [row:N] 结果 + 「NL 行」列回标。
 */

import { test, expect } from '@playwright/test';
import { createCase, createDataset, listNlGenerationsForCase, unwrap } from '../support/api.ts';
import { saveJson, saveScreenshot } from '../support/evidence.ts';
import { FIXTURE_BASE } from '../support/env.ts';
import { completeQueuedGeneration, generationItems } from '../support/nl-agent.ts';

const SCENARIO = 'a16-nl-ui';

const NL_TEXT = [
  `打开 ${FIXTURE_BASE}/?name={{用户名}}`,
  '页面上应该看到标题「演示站」',
  '页面上应该出现文本「你好，{{用户名}}」',
].join('\n');

const STEPS = [
  { id: 'u1', action: 'goto' as const, url: `${FIXTURE_BASE}/?name={{用户名}}`, label: '打开问候页' },
  { id: 'u2', action: 'expectVisible' as const, target: { by: 'role' as const, role: 'heading', name: '演示站' }, label: '标题可见' },
  { id: 'u3', action: 'expectText' as const, target: { by: 'testId' as const, testId: 'hello' }, value: '你好，{{用户名}}', label: '逐行问候' },
];

const ORIGIN = { u1: { nlLine: 1 }, u2: { nlLine: 2 }, u3: { nlLine: 3 } };

function uniq(prefix: string): string {
  return `${prefix}-${String(Date.now())}-${String(Math.floor(Math.random() * 1000))}`;
}

test.describe('A16 UI：NL 数据驱动与 Agent 三入口', () => {
  test('A16-1 Agent 页：3 卡片 + skillPaths + 无安装按钮/无 6 loop', async ({ page }) => {
    await page.goto('/#/agents');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.harness-card')).toHaveCount(3);
    for (const label of ['Claude Code', 'Codex CLI', 'DeepSeek Harness']) {
      await expect(page.locator('.harness-card').filter({ hasText: label })).toBeVisible();
    }
    await expect(page.getByText('requiresMcp: false').first()).toBeVisible();
    await expect(page.locator('.harness-card').first().getByText(/claude\/skills\/pw-auto-test/).first()).toBeVisible();
    await expect(page.locator('.harness-card').nth(2).getByText(/~~?\/\.dsh\/skills|\.agents\/skills/).first()).toBeVisible();
    await expect(page.getByText('框架没有安装按钮/安装状态', { exact: false }).first()).toBeVisible();

    // 无安装按钮/安装状态、无旧 6 loop 控件
    await expect(page.getByRole('button', { name: /安装/ })).toHaveCount(0);
    const bodyText = (await page.locator('body').innerText()).toLowerCase();
    for (const legacy of ['copilot', 'opencode', 'vscode-legacy', 'installed', 'installtargets']) {
      expect(bodyText).not.toContain(legacy);
    }
    // 页面只有三入口下拉，选项不得包含旧 loop
    const optionValues = await page.locator('#scaffold-entry option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
    expect(optionValues).toEqual(['claude', 'codex', 'deepseek']);

    await saveScreenshot(page, SCENARIO, '01-agents-harnesses.png');
    saveJson(SCENARIO, 'agents-ui.json', { optionValues, cards: await page.locator('.harness-card').count() });
  });

  test('A16-2 NL 数据驱动 UI：选数据集/插入列 → 生成/接受 → 带数据集运行 → 逐行 + NL 行回标', async ({ page }) => {
    const caseData = await createCase({ name: uniq('A16-UIData'), mode: 'steps', nl: { text: NL_TEXT } });
    const dataset = await createDataset(caseData.id, {
      name: 'A16 两行',
      source: 'json',
      rows: [
        { data: { 用户名: '张三' } },
        { data: { 用户名: '李四' } },
      ],
    });

    await page.goto(`/#/cases/${caseData.id}/edit`);
    await expect(page.getByRole('heading', { name: /编辑用例/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: '业务（NL）' })).toBeVisible();

    // 选择数据集：列 chips 可见；点击列按钮插入变量
    await page.locator('#nl-dataset').selectOption(dataset.id);
    await expect(page.getByText('数据集列', { exact: true })).toBeVisible();
    await expect(page.locator('.nl-columns').getByText('{{用户名}}').first()).toBeVisible();
    const textarea = page.locator('#nl-source-text');
    const before = await textarea.inputValue();
    await page.locator('.nl-columns').getByRole('button', { name: '{{用户名}}' }).click();
    const after = await textarea.inputValue();
    expect(after.length).toBeGreaterThan(before.length);
    expect(after).toContain('{{用户名}}');

    // 生成（UI 创建任务）→ 模拟 agent 提交 → UI 轮询 ready → accept
    await page.getByRole('button', { name: '生成步骤（agent）' }).click();
    await expect(page.getByText('生成任务已创建')).toBeVisible();
    await expect
      .poll(async () => generationItems(await listNlGenerationsForCase(caseData.id)).map((item) => item.status), {
        timeout: 30_000,
      })
      .toContain('queued');
    const ready = await completeQueuedGeneration(caseData.id, { steps: STEPS, stepOrigin: ORIGIN });
    expect(ready.status).toBe('ready');

    await expect(page.getByRole('button', { name: '接受（Accept）并写入 steps' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.nl-step-card')).toHaveCount(3);
    await page.getByRole('button', { name: '接受（Accept）并写入 steps' }).click();
    await expect(page.getByText('已接受生成结果')).toBeVisible();
    await expect(page.getByRole('region', { name: '用例步骤（只读）' })).toBeVisible();
    await saveScreenshot(page, SCENARIO, '02-nl-steps-dataset.png');

    // 带数据集运行（RunDialog 继承 editor 选中的 datasetId）
    await page.getByRole('button', { name: '运行', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(`用例：${caseData.name}`)).toBeVisible();
    await expect(dialog.locator('#run-dataset-id')).toHaveValue(dataset.id);
    await dialog.getByRole('button', { name: '创建运行' }).click();
    await expect(page).toHaveURL(/#\/runs\/run_/);
    const runId = decodeURIComponent((/#\/runs\/(run_[0-9a-f]+)/.exec(page.url()) ?? [])[1] ?? '');
    await expect(page.locator('.pill[data-status="passed"]')).toBeVisible({ timeout: 150_000 });

    const stats = page.locator('dl[aria-label="运行统计"]');
    await expect(stats.locator('dd').nth(0)).toHaveText('2');
    await expect(stats.locator('dd').nth(1)).toHaveText('0');

    const itemsRegion = page.getByRole('region', { name: '运行逐项结果' });
    await expect(itemsRegion).toBeVisible();
    const itemRows = itemsRegion.getByRole('row').filter({ hasText: /\[row:/ });
    await expect(itemRows).toHaveCount(2);
    await expect(itemsRegion.getByText('[row:0]', { exact: false }).first()).toBeVisible();
    await expect(itemsRegion.getByText('[row:1]', { exact: false }).first()).toBeVisible();

    // NL 行回标列（同一用例的 stepOrigin 行号以「第 1、2、3 行」形式显示）
    await expect(itemsRegion.getByRole('columnheader', { name: 'NL 行' })).toBeVisible();
    await expect(itemsRegion.getByRole('columnheader', { name: '数据行' })).toBeVisible();
    await expect(itemsRegion.getByText('第 1、2、3 行').first()).toBeVisible();

    await saveScreenshot(page, SCENARIO, '03-run-rows-nl-lines.png');
    saveJson(SCENARIO, 'data-ui.json', {
      caseId: caseData.id,
      datasetId: dataset.id,
      runId,
      stepOrigin: ORIGIN,
      insertion: { beforeLength: before.length, afterLength: after.length },
    });
  });
});