/**
 * 编译期表达式生成：把结构化步骤字段安全地变成官方 Playwright API 表达式。
 *
 * 安全规则（docs/architecture.md §5.3）：
 * - 静态字符串一律 `JSON.stringify` 注入，禁止手工拼接转义；
 * - 变量 `{{列名}}` 编译为 `String(row["列名"])` 引用；列不存在 → UNKNOWN_COLUMN；
 * - 只生成官方 API：test / expect / test.step / page.getByRole / getByTestId / getByLabel /
 *   getByPlaceholder / getByText / getByAltText / getByTitle / page.locator。
 */

import type { CompileIssue, CompileWarning, DataCell, TargetType } from '../types.ts';
import { TARGET_TYPES } from '../types.ts';

export interface ExpressionCompileContext {
  columns: ReadonlySet<string>;
  warnings: CompileWarning[];
  issues: CompileIssue[];
  stepId?: string;
  pathPrefix: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonLiteral(value: unknown): string {
  return JSON.stringify(value);
}

export function pushIssue(
  ctx: ExpressionCompileContext,
  code: string,
  message: string,
  pathSuffix?: string,
  detail?: unknown,
): void {
  ctx.issues.push({
    code,
    message,
    path: pathSuffix === undefined ? ctx.pathPrefix : `${ctx.pathPrefix}.${pathSuffix}`,
    ...(ctx.stepId === undefined ? {} : { stepId: ctx.stepId }),
    ...(detail === undefined ? {} : { detail }),
  });
}

const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;

export interface InterpolatedValue {
  /** 生成 JavaScript 字符串表达式。 */
  expr: string;
  /** 是否含变量引用。 */
  dynamic: boolean;
}

/**
 * 把含 `{{列名}}` 的字符串编译为 JS 字符串表达式。
 * 无变量时返回 JSON.stringify 字面量；有变量时返回 `(静态 + String(row["列"]) + …)`。
 */
export function compileValueExpression(
  value: string,
  ctx: ExpressionCompileContext,
  pathSuffix: string,
): InterpolatedValue {
  if (/\{\{/.test(value) === false && /\}\}/.test(value) === false) {
    return { expr: jsonLiteral(value), dynamic: false };
  }
  // 括号不配对（例如只有 "{{x" 或 "x}}"）是明确的用户错误。
  const placeholderCount = (value.match(PLACEHOLDER_PATTERN) ?? []).length;
  const openCount = (value.match(/\{\{/g) ?? []).length;
  const closeCount = (value.match(/\}\}/g) ?? []).length;
  if (placeholderCount === 0 || openCount !== closeCount) {
    pushIssue(ctx, 'VALIDATION_FAILED', `变量占位符不完整（应为 {{列名}}）：${value}`, pathSuffix);
    return { expr: jsonLiteral(value), dynamic: false };
  }

  const parts: string[] = [];
  let lastIndex = 0;
  PLACEHOLDER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  let dynamic = false;
  while ((match = PLACEHOLDER_PATTERN.exec(value)) !== null) {
    const text = value.slice(lastIndex, match.index);
    if (text !== '') parts.push(jsonLiteral(text));
    const rawName = match[1] ?? '';
    const column = rawName.trim();
    if (column === '') {
      pushIssue(ctx, 'UNKNOWN_COLUMN', '变量占位符中的列名不能为空', pathSuffix);
    } else if (column.length > 60 || /[{}]/.test(column)) {
      pushIssue(ctx, 'UNKNOWN_COLUMN', `变量列名不合法：${column}`, pathSuffix);
    } else if (!ctx.columns.has(column)) {
      pushIssue(
        ctx,
        'UNKNOWN_COLUMN',
        `步骤引用了不存在的数据列「${column}」；可用列：${[...ctx.columns].join('、') || '（无）'}`,
        pathSuffix,
        { column, availableColumns: [...ctx.columns] },
      );
    }
    parts.push(`String(row[${jsonLiteral(column)}])`);
    dynamic = true;
    lastIndex = match.index + match[0].length;
  }
  const tail = value.slice(lastIndex);
  if (tail !== '') parts.push(jsonLiteral(tail));

  if (parts.length === 0) return { expr: jsonLiteral(''), dynamic: false };
  if (parts.length === 1) return { expr: parts[0] as string, dynamic };
  return { expr: `(${parts.join(' + ')})`, dynamic };
}

function optionString(value: string): string {
  return jsonLiteral(value);
}

function targetTextOptions(target: Record<string, unknown>): string {
  const pairs: string[] = [];
  if (target['exact'] === true) {
    pairs.push('exact: true');
  }
  return pairs.length === 0 ? '' : `{ ${pairs.join(', ')} }`;
}

function requireString(
  value: unknown,
  ctx: ExpressionCompileContext,
  pathSuffix: string,
  message: string,
  maxLength: number,
): string | null {
  if (typeof value !== 'string' || value === '') {
    pushIssue(ctx, 'INVALID_STEP', message, pathSuffix);
    return null;
  }
  if (value.length > maxLength) {
    pushIssue(ctx, 'INVALID_STEP', `${message}（长度超过 ${maxLength}）`, pathSuffix);
    return null;
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  ctx: ExpressionCompileContext,
  pathSuffix: string,
  message: string,
): T | null {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    pushIssue(ctx, 'INVALID_STEP', message, pathSuffix);
    return null;
  }
  return value as T;
}

/**
 * 编译 Target 为官方 locator 表达式（page.<locator>）。
 * 返回 null 表示已记录 issue（调用方跳过该步骤）。
 */
export function compileTargetExpression(target: unknown, ctx: ExpressionCompileContext): string | null {
  if (!isRecord(target)) {
    pushIssue(ctx, 'INVALID_STEP', '缺少 target（目标元素）', 'target');
    return null;
  }
  const by = requireEnum<TargetType>(
    target['by'],
    TARGET_TYPES,
    ctx,
    'target.by',
    `target.by 必须是 ${TARGET_TYPES.join('|')} 之一`,
  );
  if (by === null) return null;

  switch (by) {
    case 'role': {
      const role = requireString(target['role'], ctx, 'target.role', 'by=role 时必须提供 role', 64);
      if (role === null) return null;
      const options: string[] = [];
      if (typeof target['name'] === 'string' && target['name'] !== '') {
        const nameExpr = compileValueExpression(target['name'], ctx, 'target.name');
        options.push(`name: ${nameExpr.expr}`);
      }
      if (target['exact'] === true) options.push('exact: true');
      if (target['level'] !== undefined && target['level'] !== null) {
        if (
          typeof target['level'] !== 'number' ||
          !Number.isInteger(target['level']) ||
          target['level'] < 1 ||
          target['level'] > 6
        ) {
          pushIssue(ctx, 'INVALID_STEP', 'target.level 必须是 1..6 的整数', 'target.level');
        } else {
          options.push(`level: ${target['level']}`);
        }
      }
      const optionText = options.length === 0 ? '' : `, { ${options.join(', ')} }`;
      return `page.getByRole(${optionString(role)}${optionText})`;
    }
    case 'testId': {
      const testId = requireString(target['testId'], ctx, 'target.testId', 'by=testId 时必须提供 testId', 200);
      if (testId === null) return null;
      const expr = compileValueExpression(testId, ctx, 'target.testId');
      return `page.getByTestId(${expr.expr})`;
    }
    case 'css': {
      const selector = requireString(target['selector'], ctx, 'target.selector', 'by=css 时必须提供 selector', 1000);
      if (selector === null) return null;
      ctx.warnings.push({
        code: 'CSS_SELECTOR',
        message: `第 ${ctx.stepId ?? '?'} 步使用 css 兜底定位（不推荐，优先 role/testId/label）`,
        ...(ctx.stepId === undefined ? {} : { stepId: ctx.stepId }),
      });
      const expr = compileValueExpression(selector, ctx, 'target.selector');
      return `page.locator(${expr.expr})`;
    }
    case 'label':
    case 'placeholder':
    case 'text':
    case 'alt':
    case 'title': {
      const text = requireString(target['text'], ctx, `target.text`, `by=${by} 时必须提供 text`, 2000);
      if (text === null) return null;
      const expr = compileValueExpression(text, ctx, 'target.text');
      const optionText = targetTextOptions(target);
      const method =
        by === 'label'
          ? 'getByLabel'
          : by === 'placeholder'
            ? 'getByPlaceholder'
            : by === 'text'
              ? 'getByText'
              : by === 'alt'
                ? 'getByAltText'
                : 'getByTitle';
      return `page.${method}(${expr.expr}${optionText === '' ? '' : `, ${optionText}`})`;
    }
    default: {
      pushIssue(ctx, 'INVALID_STEP', `未知的 target.by：${String(by)}`, 'target.by');
      return null;
    }
  }
}

export type MatcherMode = 'text' | 'value' | 'title' | 'url';

export interface Matcher {
  method: 'toHaveText' | 'toContainText' | 'toHaveValue' | 'toHaveTitle' | 'toHaveURL';
  expr: string;
}

function escapeRegExpSource(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 官方 URL glob 语义（`*` / `**`）转 RegExp 源；仅在静态值上使用。 */
export function globToRegExpSource(glob: string): string {
  const placeholder = '\u0000';
  // 先把 * 占位，避免被通用正则转义；再还原为 glob 语义。
  const marked = glob.replace(/\*/g, placeholder);
  const escaped = escapeRegExpSource(marked);
  const withDoubleStar = escaped.split(placeholder + placeholder).join('.*');
  const withSingleStar = withDoubleStar.split(placeholder).join('[^/]*');
  return `^${withSingleStar}$`;
}

/**
 * 编译 Web-First 断言参数。
 * - expectText：exact=false → 官方 toContainText（子串）；否则 toHaveText（整串）。
 * - expectValue / expectTitle：官方无 exact 选项 → 保持整串，exact=false 记录警告。
 * - expectURL：exact=false 且静态值 → glob 转 RegExp；动态值 → 警告并保持字符串。
 */
export function compileMatcher(
  rawValue: string,
  mode: MatcherMode,
  exact: boolean | undefined,
  ctx: ExpressionCompileContext,
  pathSuffix: string,
): Matcher | null {
  const valueExpr = compileValueExpression(rawValue, ctx, pathSuffix);
  if (mode === 'text') {
    if (exact === false) {
      return { method: 'toContainText', expr: valueExpr.expr };
    }
    return { method: 'toHaveText', expr: valueExpr.expr };
  }
  if (mode === 'value') {
    if (exact === false) {
      ctx.warnings.push({
        code: 'EXACT_UNSUPPORTED',
        message: 'expectValue 没有官方 exact 选项，已按整串匹配（toHaveValue）',
        ...(ctx.stepId === undefined ? {} : { stepId: ctx.stepId }),
      });
    }
    return { method: 'toHaveValue', expr: valueExpr.expr };
  }
  if (mode === 'title') {
    if (exact === false && valueExpr.dynamic === false) {
      const pattern = escapeRegExpSource(rawValue);
      return { method: 'toHaveTitle', expr: `new RegExp(${jsonLiteral(pattern)})` };
    }
    if (exact === false && valueExpr.dynamic) {
      ctx.warnings.push({
        code: 'EXACT_DYNAMIC_FALLBACK',
        message: 'expectTitle 的 exact=false 仅支持静态值，含变量时按整串匹配',
        ...(ctx.stepId === undefined ? {} : { stepId: ctx.stepId }),
      });
    }
    return { method: 'toHaveTitle', expr: valueExpr.expr };
  }
  // url
  if (exact === false && valueExpr.dynamic === false) {
    return { method: 'toHaveURL', expr: `new RegExp(${jsonLiteral(globToRegExpSource(rawValue))})` };
  }
  if (exact === false && valueExpr.dynamic) {
    ctx.warnings.push({
      code: 'EXACT_DYNAMIC_FALLBACK',
      message: 'expectURL 的 glob 仅支持静态值，含变量时按整串 URL 匹配',
      ...(ctx.stepId === undefined ? {} : { stepId: ctx.stepId }),
    });
  }
  return { method: 'toHaveURL', expr: valueExpr.expr };
}

export function describeTarget(target: unknown): string {
  if (!isRecord(target)) return '';
  const by = typeof target['by'] === 'string' ? target['by'] : '?';
  if (by === 'role' && typeof target['role'] === 'string') {
    return `${target['role']}${typeof target['name'] === 'string' ? `「${target['name']}」` : ''}`;
  }
  if (by === 'testId' && typeof target['testId'] === 'string') return `testId=${target['testId']}`;
  if (by === 'css' && typeof target['selector'] === 'string') return target['selector'];
  if (typeof target['text'] === 'string') return target['text'];
  return by;
}

export function normalizeDataCell(value: unknown): DataCell | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  return undefined;
}