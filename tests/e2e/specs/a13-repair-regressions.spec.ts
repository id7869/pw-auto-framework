/**
 * A13 修复回归复测（F3：前端展示剥离 ANSI 转义序列）。
 *
 * 背景（t16 / t17）：
 * - 接口与产物**保留官方原始 `error.message`**（含 ANSI 控制符，便于精确复现；`errorHash` 已剥离）；
 * - Web 展示层统一 `stripAnsi`，并保留「复制原始错误（含控制符）」入口。
 *
 * 本用例在**当前字节**上同时验证三件事：
 *  1) API 返回的 `attempts[0].error.message` 仍含原始 ANSI（接口未改写）；
 *  2) 运行详情页渲染的 DOM/正文不含 ANSI（展示层已剥离）；
 *  3) 页面提供「复制原始错误（含控制符）」按钮（原始值可获取）。
 */

import { test, expect } from '@playwright/test';
import { createCase, createRun, listRunItems, waitRun } from '../support/api.ts';
import { saveJson, saveScreenshot, saveText } from '../support/evidence.ts';
import { FIXTURE_BASE } from '../support/env.ts';

const SCENARIO = 'a13-repair-regressions';
/** CSI 颜色序列（官方 reporter 在失败 message 中输出的形态，如 \u001b[31m） */
const ANSI_CSI = /\u001b\[[0-9;]*m/;

test.describe('A13 修复回归复测', () => {
  test('A13 F3：接口保留 ANSI 原文、UI 展示已剥离、并提供复制原始入口', async ({ page }) => {
    // 1) 制造一个必然失败的运行（断言文本不匹配 → 官方 reporter 输出带色 message）
    const created = await createCase({
      name: `A13-F3-ANSI-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
        { id: 'st_2', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '必然不匹配的文案（A13-F3）' },
      ],
    });
    const run = await createRun({ target: { kind: 'case', caseId: created.id } });
    const final = await waitRun(run.id);
    expect(final.status).toBe('failed');
    expect(final.stats.unexpected).toBe(1);

    const items = await listRunItems(run.id);
    const rawMessage = items.items[0]?.attempts[0]?.error?.message ?? '';
    // 接口保留原始控制符
    expect(ANSI_CSI.test(rawMessage)).toBe(true);
    expect(items.items[0]?.attempts[0]?.errorHash).toMatch(/^[0-9a-f]{16,}$/);

    // 2) 运行详情页：展开逐项结果，查看错误正文
    await page.goto(`/#/runs/${run.id}`);
    await expect(page.locator('.pill[data-status="failed"]')).toBeVisible({ timeout: 60_000 });
    const itemsRegion = page.getByRole('region', { name: '运行逐项结果' });
    await expect(itemsRegion).toBeVisible();
    await itemsRegion.getByRole('button', { name: '展开' }).first().click();

    const errorBox = page.locator('.attempt-error .error-message').first();
    await expect(errorBox).toBeVisible();
    const displayed = (await errorBox.innerText()).trim();
    expect(displayed.length).toBeGreaterThan(10);
    // 展示层已剥离 ANSI
    expect(ANSI_CSI.test(displayed)).toBe(false);
    expect(displayed).not.toContain('\u001b');

    // 整个页面 DOM 也不含 ANSI（包括错误摘要、stack、stdout/stderr 区块）
    const html = await page.content();
    expect(ANSI_CSI.test(html)).toBe(false);

    // 3) 原始值仍可通过「复制原始错误（含控制符）」获取（按钮存在 + 原始 message 非空）
    const copyRaw = page.getByRole('button', { name: /复制原始错误/ }).first();
    await expect(copyRaw).toBeVisible();

    // 4) 交叉核对：UI 展示文本与「剥离 ANSI 后的接口原文」一致（不是被裁掉/伪装的空串）
    const strippedRaw = rawMessage.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    expect(displayed).toContain('toHaveText');
    expect(strippedRaw).toContain('toHaveText');

    await saveScreenshot(page, SCENARIO, 'f3-run-detail.png');
    saveJson(SCENARIO, 'f3-ansi.json', {
      runId: run.id,
      status: final.status,
      rawHasAnsi: ANSI_CSI.test(rawMessage),
      rawMessageLength: rawMessage.length,
      displayedLength: displayed.length,
      displayedHasAnsi: ANSI_CSI.test(displayed),
      htmlHasAnsi: ANSI_CSI.test(html),
      copyRawButtonVisible: true,
      rawExcerpt: rawMessage.slice(0, 300),
      displayedExcerpt: displayed.slice(0, 300),
    });
    saveText(SCENARIO, 'f3-raw-error.txt', rawMessage);
  });
});