/**
 * 结构化步骤编辑器：动作 + 目标定位器 + 值/按键/等待状态/视口/超时，
 * 支持上移、下移、删除与服务端/前端校验错误就地展示。
 * 规则来源：docs/api-contract.md §2.2。
 */
import { useState } from 'react';
import type { Step, StepAction, Target, TargetBy } from '../api/types.ts';
import {
  COMMON_ROLES,
  STEP_ACTION_META,
  STEP_ACTION_OPTIONS,
  TARGET_BY_OPTIONS,
  WAIT_STATE_OPTIONS,
  changeStepAction,
  createStep,
  defaultTarget,
  emptyTargetFor,
  moveStep,
  removeStep,
  summarizeTarget,
  updateStepAt,
} from '../lib/steps.ts';
import type { FieldError } from '../lib/validation.ts';
import { CheckboxField, Field, NumberField, PlainText, SelectField, TextField } from './ui.tsx';

const GROUPS = ['导航', '交互', '断言', '等待', '取证', '视口'] as const;
const COMMON_KEYS = ['Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'ArrowUp', 'ArrowDown', 'Control+A', 'Control+C', 'Shift+Tab'];

export interface StepEditorProps {
  steps: Step[];
  onChange: (steps: Step[]) => void;
  errors: readonly FieldError[];
  disabled?: boolean;
}

export function StepEditor({ steps, onChange, errors, disabled }: StepEditorProps) {
  const [newAction, setNewAction] = useState<StepAction>('click');
  const grouped = GROUPS.map((group) => ({
    group,
    items: STEP_ACTION_OPTIONS.filter((option) => option.group === group),
  }));

  const addStep = (): void => {
    onChange([...steps, createStep(newAction, steps)]);
  };

  return (
    <div className="step-editor">
      <datalist id="pw-step-roles">
        {COMMON_ROLES.map((role) => (
          <option key={role} value={role} />
        ))}
      </datalist>
      <datalist id="pw-step-keys">
        {COMMON_KEYS.map((key) => (
          <option key={key} value={key} />
        ))}
      </datalist>

      {steps.length === 0 ? (
        <p className="muted step-empty">还没有步骤。请在下方选择动作并添加第一个步骤。</p>
      ) : null}

      {steps.map((step, index) => (
        <StepCard
          key={step.id}
          step={step}
          index={index}
          total={steps.length}
          errors={errors}
          disabled={disabled}
          onChange={(next) => onChange(updateStepAt(steps, index, next))}
          onMove={(direction) => onChange(moveStep(steps, index, direction))}
          onRemove={() => onChange(removeStep(steps, index))}
        />
      ))}

      <div className="add-step">
        <Field id="pw-add-step-action" label="添加步骤" hint="每个步骤会编译成官方 test.step + 官方 Playwright API 调用">
          <div className="add-step-row">
            <select
              id="pw-add-step-action"
              className="input"
              value={newAction}
              disabled={disabled}
              onChange={(event) => setNewAction(event.target.value as StepAction)}
            >
              {grouped.map((group) => (
                <optgroup key={group.group} label={group.group}>
                  {group.items.map((option) => (
                    <option key={option.action} value={option.action}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button type="button" className="button" onClick={addStep} disabled={disabled || steps.length >= 200}>
              添加步骤
            </button>
          </div>
        </Field>
        <p className="muted">{STEP_ACTION_META[newAction].hint}</p>
      </div>
    </div>
  );
}

function StepCard({
  step,
  index,
  total,
  errors,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  step: Step;
  index: number;
  total: number;
  errors: readonly FieldError[];
  disabled?: boolean;
  onChange: (patch: Partial<Step>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const meta = STEP_ACTION_META[step.action];
  const stepErrors = errors.filter((error) => error.path === `steps[${String(index)}]` || error.path.startsWith(`steps[${String(index)}].`));
  const errorAt = (field: string): string | undefined =>
    stepErrors.find((error) => error.path === `steps[${String(index)}].${field}` || error.path.startsWith(`steps[${String(index)}].${field}.`))
      ?.message;

  return (
    <article className="step-card" aria-labelledby={`step-${String(index)}-title`}>
      <header className="step-card-head">
        <h3 id={`step-${String(index)}-title`}>
          第 {index + 1} 步 · {meta.label}
        </h3>
        <div className="step-actions">
          <button type="button" className="button button-small" disabled={disabled || index === 0} onClick={() => onMove(-1)} aria-label={`上移第 ${String(index + 1)} 步`}>
            上移
          </button>
          <button
            type="button"
            className="button button-small"
            disabled={disabled || index === total - 1}
            onClick={() => onMove(1)}
            aria-label={`下移第 ${String(index + 1)} 步`}
          >
            下移
          </button>
          <button type="button" className="button button-small button-danger" disabled={disabled} onClick={onRemove} aria-label={`删除第 ${String(index + 1)} 步`}>
            删除
          </button>
        </div>
      </header>

      <div className="step-grid">
        <SelectField
          id={`step-${String(index)}-action`}
          label="动作"
          value={step.action}
          options={STEP_ACTION_OPTIONS.map((option) => ({ value: option.action, label: `${option.group} · ${option.label}` }))}
          onChange={(value) => onChange(changeStepAction(step, value as StepAction))}
          disabled={disabled}
          required
        />
        <TextField
          id={`step-${String(index)}-label`}
          label="步骤标题（可选）"
          value={step.label ?? ''}
          onChange={(value) => onChange({ label: value })}
          placeholder={`缺省：${meta.label}`}
          hint="写入官方 test.step 的标题，便于失败定位"
          disabled={disabled}
          maxLength={200}
        />
      </div>

      <p className="muted step-hint">{meta.hint}</p>

      {step.action === 'goto' ? (
        <TextField
          id={`step-${String(index)}-url`}
          label="页面地址"
          value={step.url ?? ''}
          onChange={(value) => onChange({ url: value })}
          placeholder="https://example.com 或 http://127.0.0.1:4174/?name={{名字}}"
          hint="必须是 http/https；可插入 {{列名}} 变量"
          error={errorAt('url')}
          required
          disabled={disabled}
        />
      ) : null}

      {meta.target === 'required' || meta.target === 'optional' ? (
        step.target ? (
          <div className="target-editor">
            <TargetEditor
              step={step}
              index={index}
              required={meta.target === 'required'}
              errorAt={errorAt}
              disabled={disabled}
              onChange={onChange}
            />
            {meta.target === 'optional' ? (
              <button
                type="button"
                className="button button-plain button-small"
                disabled={disabled}
                onClick={() => onChange({ target: undefined })}
              >
                移除目标（改为页面级操作）
              </button>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            className="button button-plain button-small"
            disabled={disabled}
            onClick={() => onChange({ target: defaultTarget() })}
          >
            添加目标定位器（{meta.target === 'required' ? '必填' : '可选'}）
          </button>
        )
      ) : null}

      {meta.value !== 'none' && step.action !== 'expectURL' ? (
        <TextField
          id={`step-${String(index)}-value`}
          label="值"
          value={step.value ?? ''}
          onChange={(value) => onChange({ value })}
          placeholder="支持 {{列名}} 变量"
          hint={`对应${meta.label}的期望值/填写值`}
          error={errorAt('value')}
          required={meta.value === 'required'}
          disabled={disabled}
        />
      ) : null}

      {step.action === 'expectURL' ? (
        <TextField
          id={`step-${String(index)}-url`}
          label="期望 URL 或 glob 模式"
          value={step.url ?? step.value ?? ''}
          onChange={(value) => onChange({ url: value, value: undefined })}
          placeholder="http://127.0.0.1:4174/ 或 **/login**"
          hint="官方 expect(page).toHaveURL；glob 匹配时请取消精确匹配" 
          error={errorAt('url')}
          required
          disabled={disabled}
        />
      ) : null}

      {meta.key ? (
        <TextField
          id={`step-${String(index)}-key`}
          label="键名"
          value={step.key ?? ''}
          onChange={(value) => onChange({ key: value })}
          placeholder="Enter"
          hint="官方键名，例如 Enter、Tab、Control+A"
          error={errorAt('key')}
          required
          disabled={disabled}
          listId="pw-step-keys"
        />
      ) : null}

      {meta.state ? (
        <SelectField
          id={`step-${String(index)}-state`}
          label="等待状态"
          value={step.state ?? 'visible'}
          options={WAIT_STATE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
          onChange={(value) => onChange({ state: value as Step['state'] })}
          disabled={disabled}
        />
      ) : null}

      {meta.size ? (
        <div className="step-grid">
          <NumberField
            id={`step-${String(index)}-width`}
            label="视口宽度"
            value={step.width ?? ''}
            onChange={(value) => onChange({ width: value === '' ? undefined : value })}
            min={100}
            max={4096}
            error={errorAt('width')}
            required
            disabled={disabled}
          />
          <NumberField
            id={`step-${String(index)}-height`}
            label="视口高度"
            value={step.height ?? ''}
            onChange={(value) => onChange({ height: value === '' ? undefined : value })}
            min={100}
            max={4096}
            error={errorAt('height')}
            required
            disabled={disabled}
          />
        </div>
      ) : null}

      {meta.fullPage ? (
        <CheckboxField
          id={`step-${String(index)}-fullpage`}
          label="整页截图（fullPage）"
          checked={step.fullPage === true}
          onChange={(checked) => onChange({ fullPage: checked })}
          disabled={disabled}
        />
      ) : null}

      {step.action === 'expectText' || step.action === 'expectURL' ? (
        <CheckboxField
          id={`step-${String(index)}-exact`}
          label="精确匹配（exact）"
          checked={step.exact === true}
          onChange={(checked) => onChange({ exact: checked })}
          hint={step.action === 'expectURL' ? 'glob 匹配时通常应关闭精确匹配' : '默认包含匹配；勾选后要求完全相等'}
          disabled={disabled}
        />
      ) : null}

      <NumberField
        id={`step-${String(index)}-timeout`}
        label="步骤超时（毫秒，可选）"
        value={step.timeoutMs ?? ''}
        onChange={(value) => onChange({ timeoutMs: value === '' ? undefined : value })}
        min={0}
        max={120000}
        hint="0 表示使用官方默认；范围 0~120000"
        error={errorAt('timeoutMs')}
        disabled={disabled}
      />

      {stepErrors.length > 0 ? (
        <div className="form-errors" role="alert">
          <p className="form-errors-title">该步骤需要修正</p>
          <ul>
            {stepErrors.map((error) => (
              <li key={`${error.path}:${error.message}`}>
                <PlainText text={error.message} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

function TargetEditor({
  step,
  index,
  required,
  errorAt,
  disabled,
  onChange,
}: {
  step: Step;
  index: number;
  required: boolean;
  errorAt: (field: string) => string | undefined;
  disabled?: boolean;
  onChange: (patch: Partial<Step>) => void;
}) {
  const target = step.target ?? defaultTarget();
  const prefix = `step-${String(index)}-`;
  const update = (patch: Partial<Target>): void => {
    onChange({ target: { ...target, ...patch } as Target });
  };
  const changeBy = (by: TargetBy): void => {
    onChange({ target: emptyTargetFor(by) });
  };

  return (
    <div className="target-box">
      <div className="target-head">
        <span className="target-title">目标定位器</span>
        {required ? <span className="badge badge-info">必填</span> : <span className="badge badge-neutral">可选</span>}
      </div>
      <div className="step-grid">
        <SelectField
          id={`${prefix}target-by`}
          label="定位方式"
          value={target.by}
          options={TARGET_BY_OPTIONS.map((option) => ({ value: option.by, label: option.label }))}
          onChange={(value) => changeBy(value as TargetBy)}
          hint={TARGET_BY_OPTIONS.find((option) => option.by === target.by)?.hint}
          disabled={disabled}
        />
        {target.by === 'role' ? (
          <TextField
            id={`${prefix}target-role`}
            label="角色"
            value={target.role ?? ''}
            onChange={(value) => update({ role: value })}
            placeholder="button / heading / textbox"
            hint="官方 getByRole 的角色名，可用下方建议值"
            error={errorAt('target.role')}
            required
            disabled={disabled}
            listId="pw-step-roles"
          />
        ) : null}
        {target.by === 'testId' ? (
          <TextField
            id={`${prefix}target-testid`}
            label="测试 ID（data-testid）"
            value={target.testId ?? ''}
            onChange={(value) => update({ testId: value })}
            placeholder="hello"
            hint="官方 getByTestId；需要页面提供 data-testid"
            error={errorAt('target.testId')}
            required
            disabled={disabled}
          />
        ) : null}
        {target.by !== 'role' && target.by !== 'testId' && target.by !== 'css' ? (
          <TextField
            id={`${prefix}target-text`}
            label={target.by === 'label' ? '表单标签文本' : target.by === 'placeholder' ? '占位提示文本' : target.by === 'alt' ? '图片替代文本' : target.by === 'title' ? 'title 文本' : '可见文本'}
            value={target.text ?? ''}
            onChange={(value) => update({ text: value })}
            hint="按官方定位器语义精确匹配页面文本"
            error={errorAt('target.text')}
            required
            disabled={disabled}
          />
        ) : null}
        {target.by === 'css' ? (
          <>
            <TextField
              id={`${prefix}target-selector`}
              label="CSS 选择器"
              value={target.selector ?? ''}
              onChange={(value) => update({ selector: value })}
              placeholder="#submit, .btn-primary"
              error={errorAt('target.selector')}
              required
              disabled={disabled}
            />
            <p className="field-warning">不推荐：CSS 选择器在页面改版后容易失效，优先使用角色 / 标签 / 测试 ID。</p>
          </>
        ) : null}
        {target.by === 'role' ? (
          <>
            <TextField
              id={`${prefix}target-name`}
              label="可访问名称（可选）"
              value={target.name ?? ''}
              onChange={(value) => update({ name: value })}
              placeholder="演示站"
              hint="对应官方 getByRole(role, { name })"
              disabled={disabled}
            />
            <div className="step-grid">
              <CheckboxField
                id={`${prefix}target-exact`}
                label="名称精确匹配（exact）"
                checked={target.exact === true}
                onChange={(checked) => update({ exact: checked })}
                disabled={disabled}
              />
              <NumberField
                id={`${prefix}target-level`}
                label="标题级别（可选，1~6）"
                value={target.level ?? ''}
                onChange={(value) => update({ level: value === '' ? undefined : value })}
                min={1}
                max={6}
                hint="仅 heading 角色常用"
                disabled={disabled}
              />
            </div>
          </>
        ) : null}
        {target.by !== 'role' && target.by !== 'css' ? (
          <CheckboxField
            id={`${prefix}target-exact`}
            label="文本精确匹配（exact）"
            checked={target.exact === true}
            onChange={(checked) => update({ exact: checked })}
            disabled={disabled}
          />
        ) : null}
      </div>
      <p className="muted target-summary">当前目标：{summarizeTarget(target)}</p>
    </div>
  );
} 