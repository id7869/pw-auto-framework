/**
 * A2 编译与执行契约（R2/R3）：结构化步骤 → 官方 @playwright/test 规格 → 官方 JSON 报告 → 逐项结果。
 *
 * 对应 docs/acceptance-plan.md §3 A2：
 *  1. 5 步用例（goto / expectVisible / expectText / press / setViewport）；
 *  2. validate → ok:true、stepsCount=5；
 *  3. 运行 → passed、stats.expected=1；
 *  4. diagnostics.specPath 存在且内容含 test.describe(/test.step(/expect(，不含 test.each；
 *  5. diagnostics.reportPath 是合法官方 JSON 报告（stats.expected>=1、suites[].specs[].tests[].results[]）；
 *  6. items 每项含 itemKey/outcome/attempts[0].status，itemKey === caseId。
 */

import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { createRun, createCase, listRunItems, validateCase, waitRun } from '../support/api.ts';
import { saveJson, saveText } from '../support/evidence.ts';
import { FIXTURE_BASE } from '../support/env.ts';
import { collectSpecs, collectTests, type JsonReport } from '../support/report.ts';

const SCENARIO = 'a2-contract';

test.describe('A2 编译与执行契约', () => {
  test('A2 结构化步骤编译为官方规格并产出官方 JSON 报告与逐项结果', async () => {
    const caseName = `A2-契约-${String(Date.now())}`;
    const created = await createCase({
      name: caseName,
      description: '验收：编译契约（goto/expectVisible/expectText/press/setViewport）',
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
        { id: 'st_2', action: 'expectVisible', target: { by: 'role', role: 'heading', name: '演示站' } },
        { id: 'st_3', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '你好，自动化' },
        { id: 'st_4', action: 'press', key: 'Enter' },
        { id: 'st_5', action: 'setViewport', width: 1024, height: 768 },
      ],
    });
    expect(created.id).toMatch(/^case_[0-9a-f]{32}$/);
    expect(created.version).toBe(1);

    // 2) 编译校验（不执行）
    const validated = await validateCase(created.id, {});
    expect(validated.status).toBe(200);
    const validateBody = (validated.body as { data: { ok: boolean; stepsCount: number; rowsCount: number; warnings: unknown[] } }).data;
    expect(validateBody.ok).toBe(true);
    expect(validateBody.stepsCount).toBe(5);
    expect(validateBody.rowsCount).toBe(0);

    // 3) 真实执行（官方 runner + 真实 Chromium）
    const run = await createRun({ target: { kind: 'case', caseId: created.id }, options: { timeoutMs: 60_000 } });
    const final = await waitRun(run.id);
    expect(final.status).toBe('passed');
    expect(final.exitCode).toBe(0);
    expect(final.stats.expected).toBe(1);
    expect(final.stats.unexpected).toBe(0);
    expect(final.stats.flaky).toBe(0);
    expect(final.itemsCount).toBe(1);

    // 4) 诊断信息：官方命令回显 + 编译产物 + 报告路径
    const diagnostics = final.diagnostics;
    expect(diagnostics.playwrightCliPath).toMatch(/@playwright[/\\]test[/\\]cli\.js$/);
    expect(diagnostics.command.length).toBeGreaterThanOrEqual(3);
    expect(diagnostics.command).toContain('test');
    expect(diagnostics.command).toContain('--config');
    expect(diagnostics.specPath).toBeTruthy();
    expect(diagnostics.reportPath).toBeTruthy();
    expect(diagnostics.workspaceDir).toBeTruthy();
    const specPath = diagnostics.specPath as string;
    const reportPath = diagnostics.reportPath as string;
    const spec = readFileSync(specPath, 'utf8');
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as JsonReport;

    // 5) 规格内容：只用官方 API；无 test.each（官方无此 API）
    expect(spec).toContain('test.describe(');
    expect(spec).toContain('test.step(');
    expect(spec).toContain('expect(');
    expect(spec).toContain('rows.forEach(');
    expect(spec).not.toContain('test.each');
    expect(spec).toContain("from '@playwright/test'");
    expect(spec).toContain('page.getByRole(');
    expect(spec).toContain('page.getByTestId(');
    expect(spec).toContain('setViewportSize');
    expect(spec).toContain('keyboard.press');

    // 6) 官方 JSON 报告：stats + 递归 suites/specs/tests/results
    expect(report.stats?.expected).toBeGreaterThanOrEqual(1);
    const specs = collectSpecs(report);
    expect(specs.length).toBeGreaterThanOrEqual(1);
    const reportSpec = specs[0];
    expect(reportSpec?.title).toBe(caseName);
    const reportTests = reportSpec?.tests ?? [];
    expect(reportTests.length).toBe(1);
    expect(reportTests[0]?.status).toBe('expected');
    expect(reportTests[0]?.results.length).toBeGreaterThanOrEqual(1);
    expect(reportTests[0]?.results[0]?.status).toBe('passed');
    // test.step 轨迹来自官方报告（5 个结构化步骤 = 5 个 test.step）
    expect(reportTests[0]?.results[0]?.steps?.length).toBe(5);
    expect(collectTests(report).length).toBe(1);

    // 7) 逐项结果（来自官方报告，不是重新计算）
    const items = await listRunItems(run.id);
    expect(items.items.length).toBe(1);
    const item = items.items[0];
    expect(item?.itemKey).toBe(created.id);
    expect(item?.caseId).toBe(created.id);
    expect(item?.rowIndex).toBeNull();
    expect(item?.outcome).toBe('expected');
    expect(item?.title).toBe(caseName);
    expect(item?.attempts.length).toBe(1);
    expect(item?.attempts[0]?.status).toBe('passed');
    // 5 个 test.step 全部被官方 runner 记录
    expect(item?.attempts[0]?.steps.length).toBe(5);
    expect(item?.attempts[0]?.error).toBeNull();

    saveJson(SCENARIO, 'case.json', created);
    saveJson(SCENARIO, 'validate.json', validateBody);
    saveJson(SCENARIO, 'run.json', {
      id: final.id,
      status: final.status,
      stats: final.stats,
      exitCode: final.exitCode,
      diagnostics,
      environment: final.environment,
    });
    saveJson(SCENARIO, 'items.json', items.items);
    saveText(SCENARIO, 'generated-spec.ts', spec);
    saveJson(SCENARIO, 'report-summary.json', {
      stats: report.stats,
      specTitles: specs.map((specItem) => specItem.title),
      tests: reportTests.map((reportTest) => ({
        status: reportTest.status,
        results: reportTest.results.map((result) => ({ status: result.status, duration: result.duration, steps: result.steps?.length ?? 0 })),
      })),
    });
  });

  test('A2-负路径 非法步骤被后端拒绝（422 INVALID_STEP，details 指到具体步骤）', async () => {
    const result = await (async () => {
      const { http, errorCodeOf } = await import('../support/api.ts');
      return http('POST', '/api/v1/cases', {
        body: {
          name: 'A2-非法步骤',
          mode: 'steps',
          steps: [
            { id: 'ok_step', action: 'goto', url: `${FIXTURE_BASE}/` },
            { id: 'bad_step', action: 'click' },
          ],
        },
      }).then((response) => ({ response, code: errorCodeOf(response) }));
    })();

    expect(result.response.status).toBe(422);
    expect(result.code).toBe('INVALID_STEP');
    const details = (result.response.body as { error: { details: { path: string; message: string }[]; message: string } }).error;
    expect(details.message).toContain('第 2 步');
    expect(details.details[0]?.path).toBe('steps[1].target');
    saveJson(SCENARIO, 'negative-invalid-step.json', result.response.body);
  });
});