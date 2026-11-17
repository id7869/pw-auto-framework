/**
 * 步骤模型与步骤级校验（编译期强制规则）。
 * 权威来源：docs/api-contract.md §2.2「步骤级约束」与附录 A.3。
 *
 * 本文件只做**纯函数校验**，不触碰 Playwright、不执行任何代码；
 * 编译（生成 .spec.ts）由 packages/automation 负责，apps/api 只做入库前拦截。
 */

import { z } from 'zod';
import { describeTarget, targetSchema } from './target.ts';

export const STEP_ACTIONS = [
  'goto',
  'click',
  'dblclick',
  'fill',
  'press',
  'select',
  'check',
  'uncheck',
  'hover',
  'waitFor',
  'expectVisible',
  'expectText',
  'expectValue',
  'expectURL',
  'expectTitle',
  'screenshot',
  'setViewport',
] as const;

export type StepAction = (typeof STEP_ACTIONS)[number];

export const stepActionSchema = z.enum(STEP_ACTIONS);

export const WAIT_FOR_STATES = ['visible', 'hidden', 'attached', 'detached'] as const;
export type WaitForState = (typeof WAIT_FOR_STATES)[number];

export const stepSchema = z
  .object({
    id: z.string().min(1).max(64),
    action: stepActionSchema,
    label: z.string().max(200).optional(),
    target: targetSchema.optional(),
    value: z.string().max(8192).optional(),
    url: z.string().max(4096).optional(),
    key: z.string().max(64).optional(),
    state: z.enum(WAIT_FOR_STATES).optional(),
    fullPage: z.boolean().optional(),
    width: z.number().int().min(100).max(4096).optional(),
    height: z.number().int().min(100).max(4096).optional(),
    timeoutMs: z.number().int().min(0).max(120000).optional(),
    exact: z.boolean().optional(),
  })
  .strict();

export type Step = z.infer<typeof stepSchema>;

/** 校验问题：code 只允许这三个（与 api-contract §2.2/§2.8 的错误码一致） */
export const STEP_ISSUE_CODES = ['INVALID_STEP', 'UNKNOWN_COLUMN', 'CSS_SELECTOR'] as const;
export type StepIssueCode = (typeof STEP_ISSUE_CODES)[number];

export interface StepIssue {
  code: StepIssueCode;
  message: string;
  path: string;
  stepId?: string;
}

const VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** 提取字符串中的 {{列名}} 变量（去重、保持出现顺序） */
export function extractVariables(text: string | undefined | null): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (typeof name === 'string' && name.length > 0 && !found.includes(name)) found.push(name);
  }
  return found;
}

/** 收集一个步骤引用的全部变量（覆盖所有可含变量的字符串字段） */
export function collectStepVariables(step: Step): string[] {
  const texts: (string | undefined)[] = [step.value, step.url, step.label, step.key];
  if (step.target) {
    switch (step.target.by) {
      case 'role':
        texts.push(step.target.role, step.target.name);
        break;
      case 'testId':
        texts.push(step.target.testId);
        break;
      case 'css':
        texts.push(step.target.selector);
        break;
      default:
        texts.push(step.target.text);
    }
  }
  const variables: string[] = [];
  for (const text of texts) {
    for (const name of extractVariables(text)) {
      if (!variables.includes(name)) variables.push(name);
    }
  }
  return variables;
}

/** 步骤的默认 test.step 标题（缺省 label 时由 action + target 自动生成） */
export function describeStep(step: Step): string {
  switch (step.action) {
    case 'goto':
      return `打开 ${step.url ?? ''}`.trim();
    case 'screenshot':
      return '截图';
    case 'setViewport':
      return `设置视口 ${step.width ?? '?'}×${step.height ?? '?'}`;
    case 'expectURL':
      return `期望 URL ${step.url ?? step.value ?? ''}`.trim();
    case 'expectTitle':
      return `期望标题 ${step.value ?? ''}`.trim();
    case 'press':
      return step.target ? `在 ${describeTarget(step.target)} 按键 ${step.key ?? ''}`.trim() : `页面按键 ${step.key ?? ''}`.trim();
    case 'waitFor':
      return `等待 ${step.target ? describeTarget(step.target) : '页面'} 状态 ${step.state ?? 'visible'}`;
    default:
      return `${step.action} ${describeTarget(step.target)}`.trim();
  }
}

function isVariableUrl(url: string): boolean {
  return url.includes('{{');
}

/** goto/expectURL 的 URL 协议校验：含变量时延到运行时（由引擎按行值校验） */
function checkUrlScheme(url: string, path: string, stepId: string, issues: StepIssue[]): void {
  if (isVariableUrl(url)) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    issues.push({
      code: 'INVALID_STEP',
      message: `第 ${path} 的 URL 不是合法绝对地址：${url}`,
      path,
      stepId,
    });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    issues.push({
      code: 'INVALID_STEP',
      message: `第 ${path} 的 URL 只允许 http/https（官方浏览器不支持 file:// 等协议）：${url}`,
      path,
      stepId,
    });
  }
}

/**
 * 步骤语义校验（api-contract §2.2 逐行实现）。
 * 返回全部问题（不短路），便于 UI 一次展示多条。
 */
export function validateSteps(steps: readonly Step[]): StepIssue[] {
  const issues: StepIssue[] = [];
  const seenIds = new Set<string>();

  steps.forEach((step, index) => {
    const path = `steps[${index}]`;
    const stepId = step.id;
    const before = issues.length;

    if (seenIds.has(step.id)) {
      issues.push({ code: 'INVALID_STEP', message: `第 ${index + 1} 步的 id 与前面的步骤重复：${step.id}`, path: `${path}.id`, stepId });
    }
    seenIds.add(step.id);

    const needTarget = (): void => {
      if (!step.target) {
        issues.push({ code: 'INVALID_STEP', message: `第 ${index + 1} 步（${step.action}）缺少 target（目标定位器）`, path: `${path}.target`, stepId });
      }
    };
    const needValue = (label: string): void => {
      if (step.value === undefined) {
        issues.push({ code: 'INVALID_STEP', message: `第 ${index + 1} 步（${label}）缺少 value`, path: `${path}.value`, stepId });
      }
    };

    switch (step.action) {
      case 'goto':
        if (step.url === undefined) {
          issues.push({ code: 'INVALID_STEP', message: `第 ${index + 1} 步（goto）缺少 url`, path: `${path}.url`, stepId });
        } else {
          checkUrlScheme(step.url, `${path}.url`, stepId, issues);
        }
        break;
      case 'click':
      case 'dblclick':
      case 'hover':
      case 'check':
      case 'uncheck':
        needTarget();
        break;
      case 'fill':
        needTarget();
        needValue('fill');
        break;
      case 'press':
        if (step.key === undefined) {
          issues.push({ code: 'INVALID_STEP', message: `第 ${index + 1} 步（press）缺少 key（官方键名，如 Enter、Control+A）`, path: `${path}.key`, stepId });
        }
        break;
      case 'select':
        needTarget();
        needValue('select');
        break;
      case 'waitFor':
        if (step.state !== undefined && !(WAIT_FOR_STATES as readonly string[]).includes(step.state)) {
          issues.push({ code: 'INVALID_STEP', message: `第 ${index + 1} 步（waitFor）state 非法：${step.state}`, path: `${path}.state`, stepId });
        }
        break;
      case 'expectVisible':
        needTarget();
        break;
      case 'expectText':
      case 'expectValue':
        needTarget();
        needValue(step.action);
        break;
      case 'expectURL': {
        const url = step.url ?? step.value;
        if (url === undefined) {
          issues.push({ code: 'INVALID_STEP', message: `第 ${index + 1} 步（expectURL）缺少 url 或 value`, path: `${path}.url`, stepId });
        } else {
          checkUrlScheme(url, `${path}.url`, stepId, issues);
        }
        break;
      }
      case 'expectTitle':
        if (step.value === undefined) {
          issues.push({ code: 'INVALID_STEP', message: `第 ${index + 1} 步（expectTitle）缺少 value`, path: `${path}.value`, stepId });
        }
        break;
      case 'setViewport':
        if (step.width === undefined || step.height === undefined) {
          issues.push({ code: 'INVALID_STEP', message: `第 ${index + 1} 步（setViewport）缺少 width/height`, path: `${path}.width`, stepId });
        }
        break;
      case 'screenshot':
        break;
    }

    // CSS 兜底定位：不阻断保存，但必须给 warning（api-contract §2.8 的 CSS_SELECTOR 警告）
    if (step.target?.by === 'css' && issues.length === before) {
      issues.push({
        code: 'CSS_SELECTOR',
        message: `第 ${index + 1} 步使用 css 兜底定位（官方推荐 role/testId 等语义定位器）：${step.target.selector}`,
        path: `${path}.target`,
        stepId,
      });
    }
  });

  return issues;
}

/** 变量 → 数据集列校验（api-contract §2.2：列不存在 → UNKNOWN_COLUMN） */
export function validateStepColumns(steps: readonly Step[], columns: readonly string[]): StepIssue[] {
  const issues: StepIssue[] = [];
  const columnSet = new Set(columns);
  steps.forEach((step, index) => {
    for (const variable of collectStepVariables(step)) {
      if (!columnSet.has(variable)) {
        issues.push({
          code: 'UNKNOWN_COLUMN',
          message: `第 ${index + 1} 步引用了数据集不存在的列：{{${variable}}}`,
          path: `steps[${index}]`,
          stepId: step.id,
        });
      }
    }
  });
  return issues;
}

/** 分离阻断性问题与警告（css 兜底只算警告） */
export function splitStepIssues(issues: readonly StepIssue[]): { errors: StepIssue[]; warnings: StepIssue[] } {
  return {
    errors: issues.filter((issue) => issue.code !== 'CSS_SELECTOR'),
    warnings: issues.filter((issue) => issue.code === 'CSS_SELECTOR'),
  };
}

export type { StepIssue as ContractStepIssue };
export { describeStep as describeStepTitle };