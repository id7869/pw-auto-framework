/**
 * 结构化步骤模型：动作元数据、默认值、增删移动、目标摘要与逐步骤校验。
 * 规则来源：docs/api-contract.md §2.2「步骤级约束」（违反 → 后端 422 INVALID_STEP）。
 */
import { STEP_ACTIONS } from '../api/types.ts';
import type { Step, StepAction, Target, TargetBy, WaitState } from '../api/types.ts';
import type { FieldError } from './validation.ts';

export type StepGroup = '导航' | '交互' | '断言' | '等待' | '取证' | '视口';

export interface StepActionMeta {
  action: StepAction;
  label: string;
  group: StepGroup;
  /** 目标定位器的必填性 */
  target: 'required' | 'optional' | 'none';
  /** 值（value）的必填性 */
  value: 'required' | 'optional' | 'none';
  url: boolean;
  key: boolean;
  state: boolean;
  size: boolean;
  fullPage: boolean;
  exact: boolean;
  hint: string;
}

export const STEP_ACTION_META: Record<StepAction, StepActionMeta> = {
  goto: {
    action: 'goto',
    label: '打开页面',
    group: '导航',
    target: 'none',
    value: 'none',
    url: true,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 page.goto(url)；地址必须是 http/https，可含 {{列名}} 变量',
  },
  click: {
    action: 'click',
    label: '点击',
    group: '交互',
    target: 'required',
    value: 'none',
    url: false,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 locator.click()',
  },
  dblclick: {
    action: 'dblclick',
    label: '双击',
    group: '交互',
    target: 'required',
    value: 'none',
    url: false,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 locator.dblclick()',
  },
  fill: {
    action: 'fill',
    label: '填写',
    group: '交互',
    target: 'required',
    value: 'required',
    url: false,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 locator.fill(value)；值可含 {{列名}} 变量',
  },
  press: {
    action: 'press',
    label: '按键',
    group: '交互',
    target: 'optional',
    value: 'none',
    url: false,
    key: true,
    state: false,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 locator.press(key) / page.keyboard.press(key)；键名如 Enter、Control+A',
  },
  select: {
    action: 'select',
    label: '选择下拉项',
    group: '交互',
    target: 'required',
    value: 'required',
    url: false,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 locator.selectOption(value)',
  },
  check: {
    action: 'check',
    label: '勾选',
    group: '交互',
    target: 'required',
    value: 'none',
    url: false,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 locator.check()',
  },
  uncheck: {
    action: 'uncheck',
    label: '取消勾选',
    group: '交互',
    target: 'required',
    value: 'none',
    url: false,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 locator.uncheck()',
  },
  hover: {
    action: 'hover',
    label: '悬停',
    group: '交互',
    target: 'required',
    value: 'none',
    url: false,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 locator.hover()',
  },
  waitFor: {
    action: 'waitFor',
    label: '等待状态',
    group: '等待',
    target: 'optional',
    value: 'none',
    url: false,
    key: false,
    state: true,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 locator.waitFor({ state })；省略目标时等待页面级载荷状态',
  },
  expectVisible: {
    action: 'expectVisible',
    label: '断言可见',
    group: '断言',
    target: 'required',
    value: 'none',
    url: false,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 expect(locator).toBeVisible()',
  },
  expectText: {
    action: 'expectText',
    label: '断言文本',
    group: '断言',
    target: 'required',
    value: 'required',
    url: false,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: true,
    hint: '官方 expect(locator).toHaveText(value, { exact })',
  },
  expectValue: {
    action: 'expectValue',
    label: '断言输入值',
    group: '断言',
    target: 'required',
    value: 'required',
    url: false,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 expect(locator).toHaveValue(value)',
  },
  expectURL: {
    action: 'expectURL',
    label: '断言 URL',
    group: '断言',
    target: 'none',
    value: 'optional',
    url: true,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: true,
    hint: '官方 expect(page).toHaveURL(url)；可填 glob 模式',
  },
  expectTitle: {
    action: 'expectTitle',
    label: '断言页面标题',
    group: '断言',
    target: 'none',
    value: 'required',
    url: false,
    key: false,
    state: false,
    size: false,
    fullPage: false,
    exact: false,
    hint: '官方 expect(page).toHaveTitle(value)',
  },
  screenshot: {
    action: 'screenshot',
    label: '截图',
    group: '取证',
    target: 'none',
    value: 'none',
    url: false,
    key: false,
    state: false,
    size: false,
    fullPage: true,
    exact: false,
    hint: '官方 page.screenshot()；产物索引由框架登记',
  },
  setViewport: {
    action: 'setViewport',
    label: '设置视口',
    group: '视口',
    target: 'none',
    value: 'none',
    url: false,
    key: false,
    state: false,
    size: true,
    fullPage: false,
    exact: false,
    hint: '官方 page.setViewportSize({ width, height })',
  },
};

export const STEP_ACTION_OPTIONS: { action: StepAction; label: string; group: StepGroup }[] = STEP_ACTIONS.map(
  (action) => ({ action, label: STEP_ACTION_META[action].label, group: STEP_ACTION_META[action].group }),
);

export interface TargetByOption {
  by: TargetBy;
  label: string;
  hint: string;
  recommended: boolean;
}

export const TARGET_BY_OPTIONS: TargetByOption[] = [
  { by: 'role', label: '角色（推荐）', hint: '官方 getByRole，贴近用户与无障碍语义', recommended: true },
  { by: 'label', label: '表单标签（推荐）', hint: '官方 getByLabel', recommended: true },
  { by: 'testId', label: '测试 ID（推荐）', hint: '官方 getByTestId，对应 data-testid', recommended: true },
  { by: 'placeholder', label: '占位提示', hint: '官方 getByPlaceholder', recommended: false },
  { by: 'text', label: '可见文本', hint: '官方 getByText', recommended: false },
  { by: 'alt', label: '图片替代文本', hint: '官方 getByAltText', recommended: false },
  { by: 'title', label: 'title 属性', hint: '官方 getByTitle', recommended: false },
  { by: 'css', label: 'CSS 选择器（不推荐）', hint: '兜底定位，页面改版后容易失效', recommended: false },
];

export const COMMON_ROLES: string[] = [
  'button',
  'link',
  'heading',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listitem',
  'img',
  'dialog',
  'navigation',
  'main',
  'form',
  'table',
  'row',
  'cell',
  'tab',
  'menuitem',
];

export const WAIT_STATE_OPTIONS: { value: WaitState; label: string }[] = [
  { value: 'visible', label: '可见（visible）' },
  { value: 'hidden', label: '隐藏（hidden）' },
  { value: 'attached', label: '已挂载（attached）' },
  { value: 'detached', label: '已移除（detached）' },
];

export function defaultTarget(): Target {
  return { by: 'testId', testId: '' };
}

/** 切换定位方式时构造干净的 Target（避免残留无关字段） */
export function emptyTargetFor(by: TargetBy): Target {
  switch (by) {
    case 'role':
      return { by: 'role', role: '' };
    case 'testId':
      return { by: 'testId', testId: '' };
    case 'css':
      return { by: 'css', selector: '' };
    default:
      return { by, text: '' };
  }
}

/** 生成稳定且唯一的步骤 id（st_1、st_2…） */
export function nextStepId(steps: readonly Step[]): string {
  let max = 0;
  for (const step of steps) {
    const matched = /^st_(\d+)$/u.exec(step.id);
    const digits = matched?.[1];
    if (digits !== undefined) max = Math.max(max, Number(digits));
  }
  return `st_${String(max + 1)}`;
}

/** 新建步骤：按动作填充合理默认值（字段范围见合同 §2.2） */
export function createStep(action: StepAction, steps: readonly Step[]): Step {
  const base: Step = { id: nextStepId(steps), action };
  switch (action) {
    case 'goto':
      return { ...base, url: '' };
    case 'press':
      return { ...base, key: 'Enter', target: defaultTarget() };
    case 'waitFor':
      return { ...base, target: defaultTarget(), state: 'visible' };
    case 'screenshot':
      return { ...base, fullPage: false };
    case 'setViewport':
      return { ...base, width: 1280, height: 720 };
    case 'expectURL':
      return { ...base, url: '', exact: false };
    case 'expectTitle':
      return { ...base, value: '' };
    case 'fill':
    case 'select':
    case 'expectText':
    case 'expectValue':
      return { ...base, target: defaultTarget(), value: '' };
    case 'click':
    case 'dblclick':
    case 'check':
    case 'uncheck':
    case 'hover':
    case 'expectVisible':
      return { ...base, target: defaultTarget() };
    default:
      return { ...base, target: defaultTarget() };
  }
}

/** 切换动作：保留 id/label，丢弃新动作不适用的字段；保留仍适用的配置 */
export function changeStepAction(step: Step, action: StepAction): Step {
  const meta = STEP_ACTION_META[action];
  const next: Step = { id: step.id, action };
  if (step.label !== undefined && step.label !== '') next.label = step.label;
  if (meta.target !== 'none') {
    next.target = step.target ?? defaultTarget();
  }
  if (meta.url) next.url = step.url ?? '';
  if (meta.value === 'required') next.value = step.value ?? '';
  if (meta.value === 'optional' && step.value !== undefined) next.value = step.value;
  if (meta.key) next.key = step.key ?? 'Enter';
  if (meta.state) next.state = step.state ?? 'visible';
  if (meta.size) {
    next.width = step.width ?? 1280;
    next.height = step.height ?? 720;
  }
  if (meta.fullPage) next.fullPage = step.fullPage ?? false;
  if (meta.exact) next.exact = step.exact ?? false;
  if (step.timeoutMs !== undefined) next.timeoutMs = step.timeoutMs;
  return next;
}

export function moveStep(steps: readonly Step[], index: number, direction: -1 | 1): Step[] {
  const targetIndex = index + direction;
  if (index < 0 || index >= steps.length || targetIndex < 0 || targetIndex >= steps.length) {
    return [...steps];
  }
  const next = [...steps];
  const current = next[index];
  const other = next[targetIndex];
  if (!current || !other) return next;
  next[index] = other;
  next[targetIndex] = current;
  return next;
}

export function removeStep(steps: readonly Step[], index: number): Step[] {
  return steps.filter((_, current) => current !== index);
}

export function updateStepAt(steps: readonly Step[], index: number, patch: Partial<Step>): Step[] {
  return steps.map((step, current) => (current === index ? { ...step, ...patch } : step));
}

/** 目标定位器的中文摘要 */
export function summarizeTarget(target: Target | undefined): string {
  if (!target) return '未设置目标';
  switch (target.by) {
    case 'role': {
      const name = target.name?.trim() ? `，名称「${target.name}」` : '';
      const level = target.level ? `，级别 ${String(target.level)}` : '';
      return `角色「${target.role || '未填'}」${name}${level}`;
    }
    case 'testId':
      return `测试 ID「${target.testId ?? ''}」`;
    case 'label':
      return `表单标签「${target.text ?? ''}」`;
    case 'placeholder':
      return `占位提示「${target.text ?? ''}」`;
    case 'text':
      return `可见文本「${target.text ?? ''}」`;
    case 'alt':
      return `图片替代文本「${target.text ?? ''}」`;
    case 'title':
      return `title「${target.text ?? ''}」`;
    case 'css':
      return `CSS「${target.selector ?? ''}」`;
    default:
      return '未设置目标';
  }
}

/** 步骤的中文摘要（列表折叠时展示） */
export function summarizeStep(step: Step): string {
  const meta = STEP_ACTION_META[step.action];
  const parts: string[] = [meta.label];
  if (meta.url) {
    const url = step.url ?? step.value ?? '';
    if (url !== '') parts.push(url);
  }
  if (meta.target !== 'none') parts.push(summarizeTarget(step.target));
  if (meta.value === 'required' && step.value) parts.push(`值为「${step.value}」`);
  if (meta.key) parts.push(`键名「${step.key ?? ''}」`);
  if (meta.state) parts.push(`状态 ${step.state ?? 'visible'}`);
  if (meta.size) parts.push(`${String(step.width ?? '')}×${String(step.height ?? '')}`);
  return parts.join(' · ');
}

export function stepTitle(step: Step, index: number): string {
  return step.label?.trim() ? step.label : `步骤 ${String(index + 1)}：${STEP_ACTION_META[step.action].label}`;
}

function validateTarget(target: Target | undefined, path: string, required: boolean): FieldError[] {
  if (!target) {
    return required ? [{ path, message: '缺少目标定位器' }] : [];
  }
  const errors: FieldError[] = [];
  if (target.by === 'role') {
    if (!target.role?.trim()) errors.push({ path: `${path}.role`, message: '请填写角色（如 button、heading）' });
    if (target.level !== undefined && (target.level < 1 || target.level > 6)) {
      errors.push({ path: `${path}.level`, message: '标题级别需在 1~6 之间' });
    }
  } else if (target.by === 'testId') {
    if (!target.testId?.trim()) errors.push({ path: `${path}.testId`, message: '请填写测试 ID（data-testid）' });
  } else if (target.by === 'css') {
    if (!target.selector?.trim()) errors.push({ path: `${path}.selector`, message: '请填写 CSS 选择器' });
  } else if (!target.text?.trim()) {
    errors.push({ path: `${path}.text`, message: '请填写定位文本' });
  }
  return errors;
}

/** 单步校验（严格对应合同 §2.2 的必填表） */
export function validateStep(step: Step, index: number): FieldError[] {
  const meta = STEP_ACTION_META[step.action];
  if (!meta) return [{ path: `steps[${String(index)}].action`, message: `未知动作：${String(step.action)}` }];
  const prefix = `第 ${String(index + 1)} 步：`;
  const path = `steps[${String(index)}]`;
  const errors: FieldError[] = [];

  if (meta.target === 'required') {
    errors.push(...validateTarget(step.target, `${path}.target`, true));
  } else if (meta.target === 'optional' && step.target) {
    errors.push(...validateTarget(step.target, `${path}.target`, false));
  }

  if (meta.value === 'required' && (step.value === undefined || step.value === '')) {
    errors.push({ path: `${path}.value`, message: '请填写值' });
  }

  if (step.action === 'goto' || step.action === 'expectURL') {
    const url = step.action === 'goto' ? step.url : (step.url ?? step.value);
    if (!url || url.trim() === '') {
      errors.push({ path: `${path}.url`, message: step.action === 'goto' ? '请填写页面地址' : '请填写期望 URL 或匹配模式' });
    } else if (step.action === 'goto' && !/^https?:\/\//iu.test(url) && !url.includes('{{')) {
      errors.push({ path: `${path}.url`, message: '页面地址必须以 http:// 或 https:// 开头' });
    }
  }

  if (step.action === 'press' && !step.key?.trim()) {
    errors.push({ path: `${path}.key`, message: '请填写键名，例如 Enter' });
  }

  if (step.action === 'setViewport') {
    for (const dimension of ['width', 'height'] as const) {
      const value = dimension === 'width' ? step.width : step.height;
      if (value === undefined || !Number.isInteger(value) || value < 100 || value > 4096) {
        errors.push({ path: `${path}.${dimension}`, message: '视口宽高需为 100~4096 的整数' });
      }
    }
  }

  if (step.timeoutMs !== undefined) {
    if (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 0 || step.timeoutMs > 120000) {
      errors.push({ path: `${path}.timeoutMs`, message: '步骤超时需为 0~120000 毫秒（0 表示使用官方默认）' });
    }
  }

  return errors.map((error) => ({ path: error.path, message: `${prefix}${error.message}` }));
}

export function validateSteps(steps: readonly Step[]): FieldError[] {
  const errors: FieldError[] = [];
  if (steps.length > 200) {
    errors.push({ path: 'steps', message: '步骤数量不能超过 200 项' });
  }
  const seen = new Set<string>();
  steps.forEach((step, index) => {
    if (step.id.trim() === '') {
      errors.push({ path: `steps[${String(index)}].id`, message: `第 ${String(index + 1)} 步缺少步骤 ID` });
    } else if (seen.has(step.id)) {
      errors.push({ path: `steps[${String(index)}].id`, message: `第 ${String(index + 1)} 步的步骤 ID 重复` });
    }
    seen.add(step.id);
    errors.push(...validateStep(step, index));
  });
  return errors;
}

export type { FieldError };

/**
 * 目标定位器归一化：Target 的 JSON Schema 是 additionalProperties:false（合同附录 A.3），
 * 提交前必须剔除当前定位方式无关的字段，避免后端 422。
 */
export function normalizeTarget(target: Target): Target {
  if (target.by === 'role') {
    const out: Target = { by: 'role', role: (target.role ?? '').trim() };
    const name = target.name?.trim();
    if (name) out.name = name;
    if (target.exact === true) out.exact = true;
    if (target.level !== undefined) out.level = target.level;
    return out;
  }
  if (target.by === 'testId') {
    return { by: 'testId', testId: (target.testId ?? '').trim() };
  }
  if (target.by === 'css') {
    return { by: 'css', selector: (target.selector ?? '').trim() };
  }
  const out: Target = { by: target.by, text: (target.text ?? '').trim() };
  if (target.exact === true) out.exact = true;
  return out;
}

/** 步骤归一化：只保留当前动作使用的字段（与 Contract Step schema 对齐） */
export function normalizeStep(step: Step): Step {
  const meta = STEP_ACTION_META[step.action];
  const out: Step = { id: step.id, action: step.action };
  const label = step.label?.trim();
  if (label) out.label = label;
  if (meta.target !== 'none' && step.target) {
    out.target = normalizeTarget(step.target);
  }
  if (meta.url) {
    const url = step.action === 'expectURL' ? (step.url ?? step.value ?? '') : (step.url ?? '');
    out.url = url;
  }
  if (meta.value === 'required') {
    out.value = step.value ?? '';
  } else if (meta.value === 'optional' && step.value !== undefined && step.action !== 'expectURL') {
    out.value = step.value;
  }
  if (meta.key) out.key = step.key ?? 'Enter';
  if (meta.state) out.state = step.state ?? 'visible';
  if (meta.size) {
    out.width = step.width ?? 1280;
    out.height = step.height ?? 720;
  }
  if (meta.fullPage) out.fullPage = step.fullPage === true;
  if (step.action === 'expectText' || step.action === 'expectURL') {
    out.exact = step.exact === true;
  }
  if (step.timeoutMs !== undefined && step.timeoutMs !== null) out.timeoutMs = step.timeoutMs;
  return out;
}

export function normalizeSteps(steps: readonly Step[]): Step[] {
  return steps.map((step) => normalizeStep(step));
}
