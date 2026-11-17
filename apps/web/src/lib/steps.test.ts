import { describe, expect, it } from 'vitest';
import { STEP_ACTIONS } from '../api/types.ts';
import {
  STEP_ACTION_META,
  changeStepAction,
  createStep,
  defaultTarget,
  emptyTargetFor,
  moveStep,
  normalizeStep,
  normalizeSteps,
  removeStep,
  summarizeStep,
  summarizeTarget,
  validateStep,
  validateSteps,
} from './steps.ts';

describe('lib/steps：动作元数据与默认值', () => {
  it('17 个官方动作全部有元数据', () => {
    expect(STEP_ACTIONS).toHaveLength(17);
    for (const action of STEP_ACTIONS) {
      const meta = STEP_ACTION_META[action];
      expect(meta.action).toBe(action);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.hint.length).toBeGreaterThan(0);
    }
  });

  it('新建步骤按动作填充默认值', () => {
    expect(createStep('goto', [])).toMatchObject({ id: 'st_1', action: 'goto', url: '' });
    expect(createStep('press', [])).toMatchObject({ key: 'Enter', target: defaultTarget() });
    expect(createStep('waitFor', [])).toMatchObject({ state: 'visible' });
    expect(createStep('screenshot', [])).toMatchObject({ fullPage: false });
    expect(createStep('setViewport', [])).toMatchObject({ width: 1280, height: 720 });
    expect(createStep('expectText', [])).toMatchObject({ target: defaultTarget(), value: '' });
    expect(createStep('expectURL', [])).toMatchObject({ url: '', exact: false });
  });

  it('步骤 ID 递增且稳定', () => {
    const first = createStep('click', []);
    const steps = [first];
    const second = createStep('click', steps);
    expect(first.id).toBe('st_1');
    expect(second.id).toBe('st_2');
    const third = createStep('click', [first, { ...second, id: 'st_7' }]);
    expect(third.id).toBe('st_8');
  });

  it('切换动作只保留新动作适用字段', () => {
    const step = { id: 'st_1', action: 'goto' as const, url: 'https://example.com', timeoutMs: 5000 };
    const next = changeStepAction(step, 'click');
    expect(next.action).toBe('click');
    expect(next.url).toBeUndefined();
    expect(next.target).toEqual(defaultTarget());
    expect(next.timeoutMs).toBe(5000);
  });
});

describe('lib/steps：排序与删除', () => {
  const steps = [createStep('click', []), createStep('fill', []), createStep('expectVisible', [])];

  it('上移/下移', () => {
    const down = moveStep(steps, 0, 1);
    expect(down[0]?.action).toBe('fill');
    expect(down[1]?.action).toBe('click');
    expect(moveStep(steps, 0, -1).map((step) => step.action)).toEqual(steps.map((step) => step.action));
    expect(moveStep(steps, 2, 1)[2]?.action).toBe('expectVisible');
  });

  it('删除指定索引', () => {
    expect(removeStep(steps, 1).map((step) => step.action)).toEqual(['click', 'expectVisible']);
    expect(removeStep(steps, 9)).toHaveLength(3);
  });
});

describe('lib/steps：逐步骤校验（api-contract §2.2）', () => {
  it('click 缺少目标', () => {
    const errors = validateStep({ id: 'st_1', action: 'click' }, 0);
    expect(errors[0]?.path).toBe('steps[0].target');
    expect(errors[0]?.message).toBe('第 1 步：缺少目标定位器');
  });

  it('fill 缺少值与目标', () => {
    const errors = validateStep({ id: 'st_1', action: 'fill', target: { by: 'testId', testId: '' } }, 1);
    expect(errors.some((error) => error.path === 'steps[1].target.testId')).toBe(true);
    expect(errors.some((error) => error.path === 'steps[1].value')).toBe(true);
  });

  it('goto 必须是 http/https，但允许 {{列}} 变量', () => {
    expect(validateStep({ id: 's', action: 'goto', url: 'ftp://x' }, 0)[0]?.message).toContain('http');
    expect(validateStep({ id: 's', action: 'goto', url: 'http://127.0.0.1:4174/' }, 0)).toEqual([]);
    expect(validateStep({ id: 's', action: 'goto', url: 'http://127.0.0.1:4174/?name={{名字}}' }, 0)).toEqual([]);
    expect(validateStep({ id: 's', action: 'goto', url: '' }, 0)[0]?.path).toBe('steps[0].url');
  });

  it('press 缺少键名', () => {
    expect(validateStep({ id: 's', action: 'press' }, 0)[0]?.path).toBe('steps[0].key');
  });

  it('setViewport 宽高范围 100~4096', () => {
    expect(validateStep({ id: 's', action: 'setViewport', width: 99, height: 720 }, 0)).toHaveLength(1);
    expect(validateStep({ id: 's', action: 'setViewport', width: 1280, height: 5000 }, 0)).toHaveLength(1);
    expect(validateStep({ id: 's', action: 'setViewport', width: 1280, height: 720 }, 0)).toEqual([]);
  });

  it('timeoutMs 范围 0~120000', () => {
    const valid = { by: 'testId' as const, testId: 'hello' };
    expect(validateStep({ id: 's', action: 'click', target: valid, timeoutMs: 200000 }, 0)[0]?.message).toContain('120000');
    expect(validateStep({ id: 's', action: 'click', target: valid, timeoutMs: 0 }, 0)).toEqual([]);
  });

  it('expectURL 可用 value 而不是 url', () => {
    expect(validateStep({ id: 's', action: 'expectURL', value: '**/login' }, 0)).toEqual([]);
  });

  it('重复步骤 ID 与超过 200 步被拒绝', () => {
    const duplicate = [createStep('click', []), createStep('click', [])];
    duplicate[1] = { ...duplicate[1]!, id: duplicate[0]!.id };
    const errors = validateSteps(duplicate);
    expect(errors.some((error) => error.path === 'steps[1].id')).toBe(true);

    const tooMany = Array.from({ length: 201 }, (_, index) => ({ id: `st_${String(index + 1)}`, action: 'click' as const, target: defaultTarget() }));
    expect(validateSteps(tooMany).some((error) => error.path === 'steps')).toBe(true);
  });
});

describe('lib/steps：摘要与合同归一化', () => {
  it('目标摘要', () => {
    expect(summarizeTarget(undefined)).toBe('未设置目标');
    expect(summarizeTarget({ by: 'role', role: 'heading', name: '演示站' })).toContain('heading');
    expect(summarizeTarget({ by: 'testId', testId: 'hello' })).toContain('hello');
    expect(summarizeTarget({ by: 'css', selector: '#btn' })).toContain('#btn');
    expect(summarizeTarget({ by: 'label', text: '用户名' })).toContain('用户名');
  });

  it('步骤摘要包含关键参数', () => {
    expect(summarizeStep({ id: 's', action: 'goto', url: 'http://x' })).toContain('http://x');
    expect(summarizeStep({ id: 's', action: 'press', key: 'Enter' })).toContain('Enter');
    expect(summarizeStep({ id: 's', action: 'setViewport', width: 800, height: 600 })).toContain('800×600');
  });

  it('归一化剔除无关字段（Target additionalProperties:false）', () => {
    const role = normalizeStep({
      id: 'st_1',
      action: 'expectVisible',
      target: { by: 'role', role: 'heading', name: '', text: '脏数据', selector: '#x', exact: false, level: 2 },
    });
    expect(role.target).toEqual({ by: 'role', role: 'heading', level: 2 });

    const text = normalizeStep({ id: 'st_2', action: 'click', target: { by: 'label', text: '用户名', selector: '#x', exact: true } });
    expect(text.target).toEqual({ by: 'label', text: '用户名', exact: true });
  });

  it('expectURL 的 value 归一化为 url，且只在该动作保留 exact', () => {
    const normalized = normalizeStep({ id: 'st_1', action: 'expectURL', value: '**/login', exact: true, target: defaultTarget() });
    expect(normalized.url).toBe('**/login');
    expect(normalized.value).toBeUndefined();
    expect(normalized.target).toBeUndefined();
    expect(normalized.exact).toBe(true);

    const valueStep = normalizeStep({ id: 'st_2', action: 'expectValue', target: { by: 'testId', testId: 'x' }, value: 'v', exact: true });
    expect(valueStep.exact).toBeUndefined();
  });

  it('emptyTargetFor 生成干净的定位器', () => {
    expect(emptyTargetFor('role')).toEqual({ by: 'role', role: '' });
    expect(emptyTargetFor('css')).toEqual({ by: 'css', selector: '' });
    expect(emptyTargetFor('text')).toEqual({ by: 'text', text: '' });
    expect(normalizeSteps([{ id: 's', action: 'goto', url: 'http://x' }])[0]?.url).toBe('http://x');
  });
});