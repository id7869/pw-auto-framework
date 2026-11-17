/**
 * 结构化用例 → 官方 Playwright Test 规格的确定性编译器。
 *
 * 产物形态（docs/architecture.md §5.3）：
 * - `test.describe(<caseName>)` + 每行一个 `test(<title> + " [row:N]")` + 每个步骤一个 `test.step`；
 * - 只使用官方 API：test / expect / test.step / page.getByRole|getByTestId|getByLabel|getByPlaceholder|
 *   getByText|getByAltText|getByTitle / page.locator / page.keyboard / page.screenshot / page.setViewportSize；
 * - 静态字符串一律 JSON.stringify；变量 `{{列名}}` 编译为 `String(row["列名"])`；
 * - itemKey 规则：`${caseId}#row:${rowIndex}`（有数据集）或 `${caseId}`（无数据集）。
 */

import type {
  CaseDataRow,
  CaseStep,
  CaseSnapshot,
  CompileIssue,
  CompileResult,
  CompileWarning,
  DataCell,
  WaitState,
} from '../types.ts';
import { STEP_ACTIONS, WAIT_STATES } from '../types.ts';
import { compileCodeMode } from './codeMode.ts';
import {
  compileMatcher,
  compileTargetExpression,
  compileValueExpression,
  describeTarget,
  isRecord,
  jsonLiteral,
  normalizeDataCell,
  pushIssue,
  type ExpressionCompileContext,
} from './expressions.ts';

const MAX_STEPS = 200;
const MAX_STEP_ID_LENGTH = 64;
const MAX_ROWS = 500;
const MAX_COLUMNS = 50;
const MAX_CELL_STRING = 8192;
const MAX_COLUMN_NAME = 60;
const MAX_VALUE_LENGTH = 8192;
const MAX_URL_LENGTH = 4096;

export const RESERVED_COLUMN_NAMES: readonly string[] = ['__rowIndex'];

export interface NormalizedRows {
  rows: CaseDataRow[];
  columns: string[];
  issues: CompileIssue[];
}

function issue(code: string, message: string, path?: string, stepId?: string, detail?: unknown): CompileIssue {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(stepId === undefined ? {} : { stepId }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** 校验并规范化数据行（排序、列并集、单元格类型/长度）。 */
export function normalizeDatasetRows(snapshot: CaseSnapshot): NormalizedRows {
  const issues: CompileIssue[] = [];
  const rawRows = snapshot.rows;
  const rawColumns = snapshot.columns;
  const rowsIn = rawRows === undefined || rawRows === null ? [] : rawRows;
  if (!Array.isArray(rowsIn)) {
    return { rows: [], columns: [], issues: [issue('INVALID_DATASET', 'rows 必须是数组', 'rows')] };
  }
  if (rowsIn.length > MAX_ROWS) {
    issues.push(issue('ROW_LIMIT_EXCEEDED', `数据行数 ${rowsIn.length} 超过上限 ${MAX_ROWS}`, 'rows'));
  }
  if (rawColumns !== undefined && rawColumns !== null && !Array.isArray(rawColumns)) {
    issues.push(issue('INVALID_DATASET', 'columns 必须是字符串数组', 'columns'));
  } else if (Array.isArray(rawColumns) && rawColumns.length > MAX_COLUMNS) {
    issues.push(issue('INVALID_DATASET', `列数 ${rawColumns.length} 超过上限 ${MAX_COLUMNS}`, 'columns'));
  }

  const columnNames = new Set<string>();
  if (Array.isArray(rawColumns)) {
    for (const [index, column] of rawColumns.entries()) {
      if (typeof column !== 'string' || column.trim() === '') {
        issues.push(issue('INVALID_DATASET', `第 ${index + 1} 个列名必须是非空字符串`, `columns[${index}]`));
        continue;
      }
      validateColumnName(column, `columns[${index}]`, issues);
      columnNames.add(column);
    }
  }

  const rows: CaseDataRow[] = [];
  const seenRowIndexes = new Set<number>();
  for (const [index, rawRow] of rowsIn.entries()) {
    const path = `rows[${index}]`;
    if (!isRecord(rawRow)) {
      issues.push(issue('INVALID_DATASET', '数据行必须是对象', path));
      continue;
    }
    const rowIndex = rawRow['rowIndex'];
    if (typeof rowIndex !== 'number' || !Number.isInteger(rowIndex) || rowIndex < 0) {
      issues.push(issue('INVALID_DATASET', 'rowIndex 必须是 ≥0 的整数', `${path}.rowIndex`));
      continue;
    }
    if (seenRowIndexes.has(rowIndex)) {
      issues.push(issue('INVALID_DATASET', `rowIndex 重复：${rowIndex}`, `${path}.rowIndex`));
      continue;
    }
    seenRowIndexes.add(rowIndex);
    const rawData = rawRow['data'];
    if (!isRecord(rawData)) {
      issues.push(issue('INVALID_DATASET', 'data 必须是对象', `${path}.data`));
      continue;
    }
    const data: Record<string, DataCell> = {};
    for (const [key, cell] of Object.entries(rawData)) {
      validateColumnName(key, `${path}.data["${key}"]`, issues);
      const normalized = normalizeDataCell(cell);
      if (normalized === undefined) {
        issues.push(issue('INVALID_DATASET', `单元格值只允许 string/number/boolean/null（列「${key}」）`, `${path}.data["${key}"]`));
        continue;
      }
      if (typeof normalized === 'string' && normalized.length > MAX_CELL_STRING) {
        issues.push(
          issue('ROW_TOO_LARGE', `单元格「${key}」长度 ${normalized.length} 超过上限 ${MAX_CELL_STRING}`, `${path}.data["${key}"]`),
        );
        continue;
      }
      data[key] = normalized;
      columnNames.add(key);
    }
    rows.push({ rowIndex, data });
  }

  const columns = [...columnNames].sort((a, b) => a.localeCompare(b));
  if (columns.length > MAX_COLUMNS) {
    issues.push(issue('INVALID_DATASET', `列数 ${columns.length} 超过上限 ${MAX_COLUMNS}`, 'columns'));
  }
  rows.sort((a, b) => a.rowIndex - b.rowIndex);
  return { rows, columns, issues };
}

function validateColumnName(name: string, path: string, issues: CompileIssue[]): void {
  if (name.length > MAX_COLUMN_NAME) {
    issues.push(issue('INVALID_DATASET', `列名长度不能超过 ${MAX_COLUMN_NAME}：${name}`, path));
  }
  if (name.includes('{{') || name.includes('}}')) {
    issues.push(issue('INVALID_DATASET', `列名不能包含 {{ 或 }}：${name}`, path));
  }
  if (RESERVED_COLUMN_NAMES.includes(name)) {
    issues.push(issue('INVALID_DATASET', `列名「${name}」为编译保留名，请改名`, path));
  }
}

/** 安全的 spec 文件名片段（caseId 来自后端，仍做防穿越处理）。 */
export function sanitizeCaseId(caseId: string): string {
  const cleaned = caseId.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_').slice(0, 80);
  return cleaned === '' ? 'case' : cleaned;
}

export function buildSpecFileName(caseId: string): string {
  return `${sanitizeCaseId(caseId)}.spec.ts`;
}

function formatTimeoutOption(timeoutMs: number | undefined): string {
  return timeoutMs !== undefined && timeoutMs > 0 ? `{ timeout: ${timeoutMs} }` : '';
}

function actionLabel(action: string): string {
  switch (action) {
    case 'goto':
      return '打开页面';
    case 'click':
      return '点击';
    case 'dblclick':
      return '双击';
    case 'fill':
      return '填写';
    case 'press':
      return '按键';
    case 'select':
      return '选择';
    case 'check':
      return '勾选';
    case 'uncheck':
      return '取消勾选';
    case 'hover':
      return '悬停';
    case 'waitFor':
      return '等待';
    case 'expectVisible':
      return '断言可见';
    case 'expectText':
      return '断言文本';
    case 'expectValue':
      return '断言输入值';
    case 'expectURL':
      return '断言地址';
    case 'expectTitle':
      return '断言标题';
    case 'screenshot':
      return '截图';
    case 'setViewport':
      return '设置视口';
    default:
      return action;
  }
}

interface StepCompileResult {
  lines: string[];
  ok: boolean;
  issues: CompileIssue[];
  warnings: CompileWarning[];
}

function compileStep(
  raw: unknown,
  index: number,
  total: number,
  baseColumns: ReadonlySet<string>,
): StepCompileResult {
  const issues: CompileIssue[] = [];
  const warnings: CompileWarning[] = [];
  const step = raw as Partial<CaseStep>;
  const stepId = typeof step.id === 'string' ? step.id : undefined;
  const ctx: ExpressionCompileContext = {
    columns: baseColumns,
    warnings,
    issues,
    stepId,
    pathPrefix: `steps[${index}]`,
  };

  if (!isRecord(step)) {
    return { ok: false, lines: [], issues: [issue('INVALID_STEP', '步骤必须是对象', `steps[${index}]`)], warnings: [] };
  }
  if (typeof step.id !== 'string' || step.id === '' || step.id.length > MAX_STEP_ID_LENGTH) {
    pushIssue(ctx, 'INVALID_STEP', `步骤 id 必须是 1..${MAX_STEP_ID_LENGTH} 字符`, 'id');
  }
  const action = step.action;
  if (typeof action !== 'string' || !(STEP_ACTIONS as readonly string[]).includes(action)) {
    pushIssue(ctx, 'INVALID_STEP', `未知的步骤动作：${String(action)}`, 'action');
    return { ok: false, lines: [], issues, warnings };
  }

  const labelExpr =
    typeof step.label === 'string' && step.label.trim() !== ''
      ? compileValueExpression(step.label, ctx, 'label').expr
      : jsonLiteral(`步骤 ${index + 1}/${total}：${actionLabel(action)}`);

  const timeoutMs = step.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000)
  ) {
    pushIssue(ctx, 'INVALID_STEP', 'timeoutMs 必须是 0..120000 的整数', 'timeoutMs');
  }
  const validTimeout = typeof timeoutMs === 'number' ? timeoutMs : undefined;
  const timeoutOption = formatTimeoutOption(validTimeout);

  const target = (): string | null => compileTargetExpression(step.target, ctx);

  const requireValue = (field: 'value' | 'url' | 'key', maxLength: number): string | null => {
    const value = step[field];
    if (typeof value !== 'string' || value === '') {
      pushIssue(ctx, 'INVALID_STEP', `${action} 缺少必填的 ${field}`, field);
      return null;
    }
    if (value.length > maxLength) {
      pushIssue(ctx, 'INVALID_STEP', `${field} 长度超过 ${maxLength}`, field);
      return null;
    }
    return value;
  };

  const lines: string[] = [];
  switch (action) {
    case 'goto': {
      const url = requireValue('url', MAX_URL_LENGTH);
      if (url !== null) {
        const trimmed = url.trimStart();
        if (trimmed.startsWith('{{')) {
          // 动态 origin：编译期无法静态校验协议，交由官方 page.goto 在运行时拒绝非 http/https。
          ctx.warnings.push({
            code: 'DYNAMIC_ORIGIN',
            message: 'goto.url 以变量开头：编译期跳过协议静态校验，运行时由官方 page.goto 拒绝非 http/https',
            ...(stepId === undefined ? {} : { stepId }),
          });
        } else {
          // 去掉占位符后判断静态 scheme；http(s) 之外的 scheme（file:/ftp:/javascript: 等）一律拒绝。
          const staticPrefix = trimmed.replace(/\{\{.*?\}\}/g, '');
          const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(staticPrefix)?.[1] ?? null;
          if (scheme === null) {
            pushIssue(
              ctx,
              'INVALID_STEP',
              'goto.url 必须是 http:// 或 https:// 绝对地址，或以 {{变量}} 开头的动态 origin',
              'url',
            );
          } else if (!/^(http|https)$/i.test(scheme)) {
            pushIssue(ctx, 'INVALID_STEP', `goto.url 只允许 http/https 协议（检测到 ${scheme}:）`, 'url');
          }
        }
        const expr = compileValueExpression(url, ctx, 'url');
        lines.push(`await page.goto(${expr.expr}${timeoutOption === '' ? '' : `, ${timeoutOption}`});`);
      }
      break;
    }
    case 'click':
    case 'dblclick':
    case 'hover':
    case 'check':
    case 'uncheck': {
      const locator = target();
      if (locator !== null) {
        const method = action;
        lines.push(`await ${locator}.${method}(${timeoutOption});`);
      }
      break;
    }
    case 'fill': {
      const locator = target();
      const value = requireValue('value', MAX_VALUE_LENGTH);
      if (locator !== null && value !== null) {
        const expr = compileValueExpression(value, ctx, 'value');
        lines.push(
          `await ${locator}.fill(${expr.expr}${timeoutOption === '' ? '' : `, ${timeoutOption}`});`,
        );
      }
      break;
    }
    case 'select': {
      const locator = target();
      const value = requireValue('value', MAX_VALUE_LENGTH);
      if (locator !== null && value !== null) {
        const expr = compileValueExpression(value, ctx, 'value');
        lines.push(
          `await ${locator}.selectOption(${expr.expr}${timeoutOption === '' ? '' : `, ${timeoutOption}`});`,
        );
      }
      break;
    }
    case 'press': {
      const key = requireValue('key', 64);
      if (key !== null) {
        const keyExpr = compileValueExpression(key, ctx, 'key');
        if (step.target === undefined || step.target === null) {
          lines.push(`await page.keyboard.press(${keyExpr.expr});`);
        } else {
          const locator = target();
          if (locator !== null) {
            lines.push(
              `await ${locator}.press(${keyExpr.expr}${timeoutOption === '' ? '' : `, ${timeoutOption}`});`,
            );
          }
        }
      }
      break;
    }
    case 'waitFor': {
      const state: WaitState =
        step.state === undefined || step.state === null
          ? 'visible'
          : (WAIT_STATES as readonly string[]).includes(step.state)
            ? (step.state as WaitState)
            : 'visible';
      if (step.state !== undefined && !(WAIT_STATES as readonly string[]).includes(String(step.state))) {
        pushIssue(ctx, 'INVALID_STEP', `state 必须是 ${WAIT_STATES.join('|')} 之一`, 'state');
      }
      if (step.target === undefined || step.target === null) {
        // 合同允许 target 可选；无 target 时按官方页面级等待 API page.waitForLoadState 实现。
        // hidden/detached 是元素状态，没有等价页面级语义，必须提供 target。
        if (state === 'hidden' || state === 'detached') {
          pushIssue(
            ctx,
            'INVALID_STEP',
            'waitFor 无 target 仅支持页面加载等待（state=visible|attached）；hidden/detached 需要 target',
            'target',
          );
          break;
        }
        const loadState = state === 'attached' ? 'domcontentloaded' : 'load';
        ctx.warnings.push({
          code: 'WAIT_FOR_LOAD_STATE',
          message: `waitFor 无 target：按官方 page.waitForLoadState('${loadState}') 实现（state=${state} 用于选择加载状态）`,
          ...(stepId === undefined ? {} : { stepId }),
        });
        const waitOptions = validTimeout !== undefined ? `, { timeout: ${validTimeout} }` : '';
        lines.push(`await page.waitForLoadState(${jsonLiteral(loadState)}${waitOptions});`);
        break;
      }
      const locator = target();
      if (locator !== null) {
        const options: string[] = [`state: ${jsonLiteral(state)}`];
        if (validTimeout !== undefined) options.push(`timeout: ${validTimeout}`);
        lines.push(`await ${locator}.waitFor({ ${options.join(', ')} });`);
      }
      break;
    }
    case 'expectVisible': {
      const locator = target();
      if (locator !== null) {
        lines.push(`await expect(${locator}).toBeVisible(${timeoutOption});`);
      }
      break;
    }
    case 'expectText':
    case 'expectValue': {
      const locator = target();
      const value = requireValue('value', MAX_VALUE_LENGTH);
      if (locator !== null && value !== null) {
        const matcher = compileMatcher(value, action === 'expectText' ? 'text' : 'value', step.exact, ctx, 'value');
        if (matcher !== null) {
          lines.push(`await expect(${locator}).${matcher.method}(${matcher.expr}${timeoutOption === '' ? '' : `, ${timeoutOption}`});`);
        }
      }
      break;
    }
    case 'expectURL': {
      const rawUrl = typeof step.url === 'string' && step.url !== '' ? step.url : step.value;
      if (typeof rawUrl !== 'string' || rawUrl === '') {
        pushIssue(ctx, 'INVALID_STEP', 'expectURL 需要 url 或 value（glob）', 'url');
        break;
      }
      if (rawUrl.length > MAX_URL_LENGTH) {
        pushIssue(ctx, 'INVALID_STEP', `url 长度超过 ${MAX_URL_LENGTH}`, 'url');
        break;
      }
      const matcher = compileMatcher(rawUrl, 'url', step.exact, ctx, typeof step.url === 'string' && step.url !== '' ? 'url' : 'value');
      if (matcher !== null) {
        lines.push(`await expect(page).${matcher.method}(${matcher.expr}${timeoutOption === '' ? '' : `, ${timeoutOption}`});`);
      }
      break;
    }
    case 'expectTitle': {
      const value = requireValue('value', MAX_VALUE_LENGTH);
      if (value !== null) {
        const matcher = compileMatcher(value, 'title', step.exact, ctx, 'value');
        if (matcher !== null) {
          lines.push(`await expect(page).${matcher.method}(${matcher.expr}${timeoutOption === '' ? '' : `, ${timeoutOption}`});`);
        }
      }
      break;
    }
    case 'screenshot': {
      const safeStep = (stepId ?? `step-${index + 1}`).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40) || `step-${index + 1}`;
      const options: string[] = [`path: test.info().outputPath(${jsonLiteral(`screenshot-${index + 1}-${safeStep}.png`)})`];
      if (step.fullPage === true) options.push('fullPage: true');
      if (validTimeout !== undefined) options.push(`timeout: ${validTimeout}`);
      lines.push(`await page.screenshot({ ${options.join(', ')} });`);
      break;
    }
    case 'setViewport': {
      const width = step.width;
      const height = step.height;
      const validDimension = (value: unknown): value is number =>
        typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 4096;
      if (!validDimension(width) || !validDimension(height)) {
        pushIssue(ctx, 'INVALID_STEP', 'setViewport 需要 width/height（100..4096 的整数）', 'width');
        break;
      }
      lines.push(`await page.setViewportSize({ width: ${width}, height: ${height} });`);
      break;
    }
    default:
      pushIssue(ctx, 'INVALID_STEP', `未知的步骤动作：${String(action)}`, 'action');
  }

  const ok = issues.length === 0 && lines.length > 0;
  const stepLines = [
    `await test.step(${labelExpr}, async () => {`,
    ...lines.map((line) => `  ${line}`),
    '});',
  ];
  return { ok, lines: stepLines, issues, warnings };
}

/** 把结构化步骤编译为可执行的规格文本；返回完整 CompileResult。 */
export async function compileCaseSnapshot(snapshot: CaseSnapshot): Promise<CompileResult> {
  const issues: CompileIssue[] = [];
  const warnings: CompileWarning[] = [];

  if (!isRecord(snapshot)) {
    return failResult(0, 0, [], [issue('VALIDATION_FAILED', 'caseSnapshot 必须是对象')]);
  }
  const caseId = typeof snapshot.caseId === 'string' && snapshot.caseId.trim() !== '' ? snapshot.caseId : null;
  if (caseId === null) issues.push(issue('VALIDATION_FAILED', 'caseSnapshot.caseId 不能为空', 'caseId'));
  const caseName = typeof snapshot.name === 'string' && snapshot.name.trim() !== '' ? snapshot.name : null;
  if (caseName === null) issues.push(issue('VALIDATION_FAILED', 'caseSnapshot.name 不能为空', 'name'));
  const mode = snapshot.mode === 'steps' || snapshot.mode === 'code' ? snapshot.mode : null;
  if (mode === null) issues.push(issue('VALIDATION_FAILED', 'caseSnapshot.mode 必须是 steps 或 code', 'mode'));
  if (caseName !== null && caseName.length > 200) {
    issues.push(issue('VALIDATION_FAILED', 'caseSnapshot.name 长度不能超过 200', 'name'));
  }

  const dataset = normalizeDatasetRows(snapshot);
  issues.push(...dataset.issues);
  const rows = dataset.rows;
  const columns = new Set(dataset.columns);
  const datasetRequested =
    (Array.isArray(snapshot.columns) && snapshot.columns.length > 0) ||
    (typeof snapshot.datasetId === 'string' && snapshot.datasetId !== '');
  if (datasetRequested && rows.length === 0) {
    issues.push(issue('EMPTY_DATASET', '数据集已绑定但没有启用行（EMPTY_DATASET）', 'rows'));
  }

  if (issues.length > 0 || caseId === null || caseName === null || mode === null) {
    return failResult(0, rows.length, warnings, issues);
  }

  if (mode === 'code') {
    const codeResult = await compileCodeMode({
      caseId,
      name: caseName,
      code: typeof snapshot.code === 'string' ? snapshot.code : null,
      rowsCount: rows.length,
    });
    warnings.push(...codeResult.warnings);
    if (!codeResult.ok) {
      return {
        ok: false,
        stepsCount: 0,
        rowsCount: rows.length,
        warnings,
        errors: codeResult.issues,
        specSource: null,
        specFileName: null,
        itemKeys: [],
      };
    }
    return {
      ok: true,
      stepsCount: 0,
      rowsCount: rows.length,
      warnings,
      errors: [],
      specSource: codeResult.specSource,
      specFileName: buildSpecFileName(caseId),
      itemKeys: [caseId],
    };
  }

  const rawSteps = Array.isArray(snapshot.steps) ? snapshot.steps : null;
  if (rawSteps === null) {
    return failResult(0, rows.length, warnings, [issue('INVALID_STEP', 'mode=steps 时 steps 必须是数组', 'steps')]);
  }
  if (rawSteps.length > MAX_STEPS) {
    issues.push(issue('INVALID_STEP', `步骤数 ${rawSteps.length} 超过上限 ${MAX_STEPS}`, 'steps'));
  }

  const compiledSteps: string[] = [];
  for (const [index, rawStep] of rawSteps.entries()) {
    const result = compileStep(rawStep, index, rawSteps.length, columns);
    issues.push(...result.issues);
    warnings.push(...result.warnings);
    compiledSteps.push(...result.lines);
  }
  if (issues.length > 0) {
    return failResult(rawSteps.length, rows.length, warnings, issues);
  }

  const rowsLiteral = rows.length === 0
    ? [{ __rowIndex: -1 }]
    : rows.map((row) => {
        const data: Record<string, DataCell> = {};
        for (const key of Object.keys(row.data).sort((a, b) => a.localeCompare(b))) {
          data[key] = row.data[key] as DataCell;
        }
        return { __rowIndex: row.rowIndex, ...data };
      });

  const itemKeys = rows.length === 0 ? [caseId] : rows.map((row) => `${caseId}#row:${row.rowIndex}`);
  const titleExpr = `${jsonLiteral(caseName)} + (row.__rowIndex >= 0 ? \` [row:\${row.__rowIndex}]\` : '')`;

  const lines: string[] = [];
  lines.push(`// generated by pw-auto-framework; case=${jsonLiteral(caseId)}; do not edit`);
  lines.push("import { test, expect } from '@playwright/test';");
  lines.push('');
  lines.push(`const rows = ${JSON.stringify(rowsLiteral, null, 2)};`);
  lines.push('');
  lines.push(`test.describe(${jsonLiteral(caseName)}, () => {`);
  lines.push('  rows.forEach((row) => {');
  lines.push(`    test(${titleExpr}, async ({ page }) => {`);
  for (const line of compiledSteps) lines.push(`      ${line}`);
  lines.push('    });');
  lines.push('  });');
  lines.push('});');
  lines.push('');

  return {
    ok: true,
    stepsCount: rawSteps.length,
    rowsCount: rows.length,
    warnings,
    errors: [],
    specSource: lines.join('\n'),
    specFileName: buildSpecFileName(caseId),
    itemKeys,
  };
}

export function failResult(
  stepsCount: number,
  rowsCount: number,
  warnings: CompileWarning[],
  errors: CompileIssue[],
): CompileResult {
  return {
    ok: false,
    stepsCount,
    rowsCount,
    warnings,
    errors,
    specSource: null,
    specFileName: null,
    itemKeys: [],
  };
}

/** 供 runner 计算标题/行号映射（含无数据集场景）。 */
export function itemKeyFor(caseId: string, rowIndex: number | null): string {
  return rowIndex === null ? caseId : `${caseId}#row:${rowIndex}`;
}