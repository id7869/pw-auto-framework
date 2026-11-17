import { describe, expect, it } from 'vitest';

import { compileCaseSnapshot, globToRegExpSource, normalizeDatasetRows } from '../index.ts';
import type { CaseSnapshot, CaseStep } from '../index.ts';

function snapshot(overrides: Partial<CaseSnapshot> = {}): CaseSnapshot {
  return {
    caseId: 'case_1',
    name: '演示用例',
    mode: 'steps',
    steps: [
      { id: 's1', action: 'goto', url: 'http://127.0.0.1:4174/' },
      { id: 's2', action: 'expectVisible', target: { by: 'role', role: 'heading', name: '演示站' } },
    ] satisfies CaseStep[],
    code: null,
    tags: [],
    ...overrides,
  };
}

describe('compiler/specCompiler · 确定性编译', () => {
  it('相同输入产出完全相同的规格文本，且只用官方 API', async () => {
    const first = await compileCaseSnapshot(snapshot());
    const second = await compileCaseSnapshot(snapshot());
    expect(first.ok).toBe(true);
    expect(first.errors).toEqual([]);
    expect(first.specSource).toBe(second.specSource);
    expect(first.specFileName).toBe('case_1.spec.ts');
    expect(first.itemKeys).toEqual(['case_1']);
    const source = first.specSource ?? '';
    expect(source).toContain("import { test, expect } from '@playwright/test';");
    expect(source).toContain('test.describe("演示用例"');
    expect(source).toContain('await test.step(');
    expect(source).toContain('expect(page.getByRole("heading", { name: "演示站" })).toBeVisible()');
    expect(source).toContain('rows.forEach((row) => {');
    expect(source).not.toContain('test' + '.each');
    expect(source).not.toContain('require(');
    expect(source).toContain('[row:${row.__rowIndex}]');
  });

  it('无数据集时单 test、标题无 [row:N] 且 itemKey=caseId', async () => {
    const result = await compileCaseSnapshot(snapshot());
    expect(result.rowsCount).toBe(0);
    expect(result.itemKeys).toEqual(['case_1']);
    expect(result.specSource).toContain('const rows = [\n  {\n    "__rowIndex": -1\n  }\n];');
  });

  it('数据行：一行一 test、标题 [row:N]、itemKey 稳定、按 rowIndex 排序', async () => {
    const result = await compileCaseSnapshot(
      snapshot({
        rows: [
          { rowIndex: 2, data: { 名字: '王五' } },
          { rowIndex: 0, data: { 名字: '张三' } },
          { rowIndex: 1, data: { 名字: '李四' } },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.rowsCount).toBe(3);
    expect(result.itemKeys).toEqual(['case_1#row:0', 'case_1#row:1', 'case_1#row:2']);
    const literal = result.specSource?.slice(result.specSource.indexOf('const rows ='));
    expect(literal?.indexOf('"__rowIndex": 0')).toBeLessThan(literal?.indexOf('"__rowIndex": 1') ?? 0);
    expect(result.specSource).toContain('row.__rowIndex >= 0 ? ` [row:${row.__rowIndex}]`');
  });

  it('静态字符串与数据值全部 JSON.stringify，引号/反斜杠/换行/emoji/中文不破坏语法', async () => {
    const nasty = 'a"b\\c\nd\te😀中文${x}`y`';
    const result = await compileCaseSnapshot(
      snapshot({
        steps: [
          { id: 's1', action: 'goto', url: 'http://127.0.0.1:4174/' },
          {
            id: 's2',
            action: 'fill',
            target: { by: 'placeholder', text: '姓名' },
            value: nasty,
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    const source = result.specSource ?? '';
    expect(source).toContain(`fill(${JSON.stringify(nasty)})`);
    // JSON.stringify 后源文本中不应出现裸换行破坏字符串字面量。
    const fillLine = source.split('\n').find((line) => line.includes('.fill(')) ?? '';
    expect(fillLine).toContain('\\n');
    expect(fillLine).toContain('\\t');
    expect(fillLine).toContain('😀');
  });

  it('变量 {{列名}} 编译为 String(row["列名"])；未知列 → UNKNOWN_COLUMN', async () => {
    const ok = await compileCaseSnapshot(
      snapshot({
        rows: [{ rowIndex: 0, data: { 名字: '张三' } }],
        steps: [
          { id: 's1', action: 'goto', url: 'http://127.0.0.1:4174/echo?name={{名字}}' },
          { id: 's2', action: 'fill', target: { by: 'placeholder', text: '姓名' }, value: '前缀-{{名字}}' },
        ],
      }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.specSource).toContain('("http://127.0.0.1:4174/echo?name=" + String(row["名字"]))');
    expect(ok.specSource).toContain('("前缀-" + String(row["名字"]))');

    const bad = await compileCaseSnapshot(
      snapshot({
        rows: [{ rowIndex: 0, data: { 名字: '张三' } }],
        steps: [
          { id: 's1', action: 'fill', target: { by: 'placeholder', text: '姓名' }, value: '{{不存在的列}}' },
        ],
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]?.code).toBe('UNKNOWN_COLUMN');
    expect(bad.errors[0]?.message).toContain('不存在的列');
    expect(bad.errors[0]?.path).toBe('steps[0].value');
  });

  it('全部 target 类型映射到官方 locator；css 产生警告；exact=false 走 toContainText', async () => {
    const result = await compileCaseSnapshot(
      snapshot({
        steps: [
          { id: 's1', action: 'click', target: { by: 'role', role: 'button', name: '提交', exact: true } },
          { id: 's2', action: 'click', target: { by: 'testId', testId: 'hello' } },
          { id: 's3', action: 'click', target: { by: 'label', text: '姓名' } },
          { id: 's4', action: 'click', target: { by: 'placeholder', text: '姓名' } },
          { id: 's5', action: 'click', target: { by: 'text', text: '提交', exact: true } },
          { id: 's6', action: 'click', target: { by: 'alt', text: '图片说明' } },
          { id: 's7', action: 'click', target: { by: 'title', text: '提示' } },
          { id: 's8', action: 'click', target: { by: 'css', selector: '#submit' } },
          { id: 's9', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '你好', exact: false },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    const source = result.specSource ?? '';
    expect(source).toContain('page.getByRole("button", { name: "提交", exact: true })');
    expect(source).toContain('page.getByTestId("hello")');
    expect(source).toContain('page.getByLabel("姓名")');
    expect(source).toContain('page.getByPlaceholder("姓名")');
    expect(source).toContain('page.getByText("提交", { exact: true })');
    expect(source).toContain('page.getByAltText("图片说明")');
    expect(source).toContain('page.getByTitle("提示")');
    expect(source).toContain('page.locator("#submit")');
    expect(source).toContain('toContainText("你好")');
    expect(result.warnings.map((warning) => warning.code)).toContain('CSS_SELECTOR');
  });

  it('步骤级必填校验：缺 target / 缺 url / 未知动作 / waitFor hidden 无 target / 视口越界 → INVALID_STEP', async () => {
    const cases: { step: unknown; path: string }[] = [
      { step: { id: 's1', action: 'click' }, path: 'steps[0].target' },
      { step: { id: 's1', action: 'goto' }, path: 'steps[0].url' },
      { step: { id: 's1', action: 'teleport' }, path: 'steps[0].action' },
      { step: { id: 's1', action: 'waitFor', state: 'hidden' }, path: 'steps[0].target' },
      { step: { id: 's1', action: 'setViewport', width: 10, height: 20 }, path: 'steps[0].width' },
      { step: { id: 's1', action: 'press' }, path: 'steps[0].key' },
    ];
    for (const item of cases) {
      const result = await compileCaseSnapshot(snapshot({ steps: [item.step] }));
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.code).toBe('INVALID_STEP');
      expect(result.errors[0]?.path).toBe(item.path);
    }
  });

  it('goto 支持动态 origin（编译期跳过协议校验，warning 提示），静态非 http(s) scheme 仍拒绝', async () => {
    const dynamic = await compileCaseSnapshot(
      snapshot({
        rows: [{ rowIndex: 0, data: { base: 'http://127.0.0.1:4174' } }],
        steps: [{ id: 's1', action: 'goto', url: '{{base}}/echo' }],
      }),
    );
    expect(dynamic.ok).toBe(true);
    expect(dynamic.warnings.map((warning) => warning.code)).toContain('DYNAMIC_ORIGIN');
    expect(dynamic.specSource).toContain('page.goto((String(row["base"]) + "/echo"))');

    const staticOk = await compileCaseSnapshot(
      snapshot({ steps: [{ id: 's1', action: 'goto', url: 'http://127.0.0.1:4174/' }] }),
    );
    expect(staticOk.ok).toBe(true);
    expect(staticOk.warnings.map((warning) => warning.code)).not.toContain('DYNAMIC_ORIGIN');

    for (const url of ['ftp://example.com/x', 'file:///tmp/x.html', 'javascript:alert(1)', '/relative/path']) {
      const rejected = await compileCaseSnapshot(snapshot({ steps: [{ id: 's1', action: 'goto', url }] }));
      expect(rejected.ok, `应拒绝 ${url}`).toBe(false);
      expect(rejected.errors[0]?.code).toBe('INVALID_STEP');
      expect(rejected.errors[0]?.path).toBe('steps[0].url');
    }
  });

  it('waitFor 无 target：按官方 page.waitForLoadState 实现（visible→load / attached→domcontentloaded）', async () => {
    const visible = await compileCaseSnapshot(
      snapshot({ steps: [{ id: 's1', action: 'waitFor' }, { id: 's2', action: 'waitFor', state: 'visible', timeoutMs: 3000 }] }),
    );
    expect(visible.ok).toBe(true);
    expect(visible.specSource).toContain('await page.waitForLoadState("load");');
    expect(visible.specSource).toContain('await page.waitForLoadState("load", { timeout: 3000 });');
    expect(visible.warnings.filter((warning) => warning.code === 'WAIT_FOR_LOAD_STATE')).toHaveLength(2);

    const attached = await compileCaseSnapshot(
      snapshot({ steps: [{ id: 's1', action: 'waitFor', state: 'attached' }] }),
    );
    expect(attached.ok).toBe(true);
    expect(attached.specSource).toContain('await page.waitForLoadState("domcontentloaded");');

    const withTarget = await compileCaseSnapshot(
      snapshot({
        steps: [{ id: 's1', action: 'waitFor', target: { by: 'testId', testId: 'hello' }, state: 'visible' }],
      }),
    );
    expect(withTarget.ok).toBe(true);
    expect(withTarget.specSource).toContain('await page.getByTestId("hello").waitFor({ state: "visible" });');
    expect(withTarget.warnings.map((warning) => warning.code)).not.toContain('WAIT_FOR_LOAD_STATE');
  });

  it('数据集校验：重复 rowIndex / 保留列名 / 超长单元格 / 空数据集', async () => {
    const duplicate = await compileCaseSnapshot(
      snapshot({ rows: [{ rowIndex: 0, data: {} }, { rowIndex: 0, data: {} }] }),
    );
    expect(duplicate.errors[0]?.code).toBe('INVALID_DATASET');

    const reserved = await compileCaseSnapshot(snapshot({ rows: [{ rowIndex: 0, data: { __rowIndex: 1 } }] }));
    expect(reserved.errors[0]?.code).toBe('INVALID_DATASET');

    const huge = await compileCaseSnapshot(
      snapshot({ rows: [{ rowIndex: 0, data: { x: 'a'.repeat(8193) } }] }),
    );
    expect(huge.errors[0]?.code).toBe('ROW_TOO_LARGE');

    const empty = await compileCaseSnapshot(snapshot({ columns: ['名字'], rows: [] }));
    expect(empty.errors[0]?.code).toBe('EMPTY_DATASET');
  });

  it('normalizeDatasetRows 推导列并排序', () => {
    const normalized = normalizeDatasetRows(
      snapshot({
        rows: [
          { rowIndex: 1, data: { b: 2, a: true } },
          { rowIndex: 0, data: { a: false, c: null } },
        ],
      }),
    );
    expect(normalized.issues).toEqual([]);
    expect(normalized.rows.map((row) => row.rowIndex)).toEqual([0, 1]);
    expect(normalized.columns).toEqual(['a', 'b', 'c']);
  });
});

describe('compiler/specCompiler · 原始代码模式', () => {
  it('合法代码原样保留并补 header', async () => {
    const code = "import { test, expect } from '@playwright/test';\n\ntest('原生用例', async ({ page }) => {\n  await page.goto('http://127.0.0.1:4174/');\n  await expect(page).toHaveTitle('演示站');\n});\n";
    const result = await compileCaseSnapshot(snapshot({ mode: 'code', steps: [], code }));
    expect(result.ok).toBe(true);
    expect(result.itemKeys).toEqual(['case_1']);
    expect(result.specSource?.startsWith('// generated by pw-auto-framework')).toBe(true);
    expect(result.specSource).toContain(code.trim());
  });

  it('非官方 import / 非官方数据驱动 API / 逃逸模式 / 语法错误 → 拒绝', async () => {
    const cases = [
      "import { test } from 'node:fs';\ntest('x', async () => {});",
      "import { test } from '@playwright/test';\ntest" + ".each([1])('x', async () => {});",
      "import { test } from '@playwright/test';\ntest('x', async () => { process.exit(1); });",
      "import { test } from '@playwright/test';\ntest('broken', async ({ page }) => {",
    ];
    for (const code of cases) {
      const result = await compileCaseSnapshot(snapshot({ mode: 'code', steps: [], code }));
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('code 模式有数据行时发警告且不注入行', async () => {
    const code = "import { test } from '@playwright/test';\ntest('x', async ({ page }) => { await page.setContent('<h1>x</h1>'); });";
    const result = await compileCaseSnapshot(
      snapshot({ mode: 'code', steps: [], code, rows: [{ rowIndex: 0, data: { a: 1 } }] }),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain('CODE_MODE_IGNORES_DATASET');
    expect(result.itemKeys).toEqual(['case_1']);
  });
});

describe('compiler/expressions · URL glob', () => {
  it('globToRegExpSource 支持 * 与 **', () => {
    const source = globToRegExpSource('http://x/**/ok?*');
    const regex = new RegExp(source);
    expect(regex.test('http://x/a/b/ok?z')).toBe(true);
    expect(regex.test('http://x/a/b/nope')).toBe(false);
  });
});