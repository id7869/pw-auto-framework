/**
 * 通用 UI 组件：四态（加载/空/错误/正常）、徽标、表单字段、复制/二次确认、对话框。
 * 无 UI 依赖库；样式见 src/styles.css。
 */
import { useEffect, useId, useRef, useState } from 'react';
import type {
  ChangeEvent,
  InputHTMLAttributes,
  ReactNode,
  RefObject,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import type { ApiErrorInfo } from '../api/http.ts';
import type { ComparisonChange, ItemOutcomeValue, RunStatus } from '../api/types.ts';
import type { Tone } from '../lib/labels.ts';
import {
  COMPARISON_CHANGE_LABELS,
  COMPARISON_CHANGE_TONES,
  OUTCOME_LABELS,
  OUTCOME_TONES,
  RUN_STATUS_LABELS,
  RUN_STATUS_TONES,
  VERDICT_LABELS,
  VERDICT_TONES,
  errorCodeLabel,
} from '../lib/labels.ts';
import type { FieldError } from '../lib/validation.ts';
import { stripAnsi } from '../lib/ansi.ts';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StatusPill({ status }: { status: RunStatus | string }) {
  const label = RUN_STATUS_LABELS[status as RunStatus] ?? `未知状态（${String(status)}）`;
  const tone = RUN_STATUS_TONES[status as RunStatus] ?? 'neutral';
  return (
    <span className={`pill pill-${tone}`} data-status={status}>
      {label}
    </span>
  );
}

export function OutcomePill({ outcome }: { outcome: ItemOutcomeValue | string }) {
  const label = OUTCOME_LABELS[outcome as ItemOutcomeValue] ?? String(outcome);
  const tone = OUTCOME_TONES[outcome as ItemOutcomeValue] ?? 'neutral';
  return (
    <span className={`pill pill-${tone}`} data-outcome={outcome}>
      {label}
    </span>
  );
}

export function ChangePill({ change }: { change: ComparisonChange | string }) {
  const label = COMPARISON_CHANGE_LABELS[change as ComparisonChange] ?? String(change);
  const tone = COMPARISON_CHANGE_TONES[change as ComparisonChange] ?? 'neutral';
  return (
    <span className={`pill pill-${tone}`} data-change={change}>
      {label}
    </span>
  );
}

export function VerdictPill({ verdict }: { verdict: string }) {
  const label = VERDICT_LABELS[verdict] ?? verdict;
  const tone = VERDICT_TONES[verdict] ?? 'neutral';
  return <span className={`pill pill-${tone}`}>{label}</span>;
}

export function LoadingState({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="state state-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state state-empty">
      <p className="state-title">{title}</p>
      {description ? <p className="muted">{description}</p> : null}
      {action ? <div className="state-action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  error,
  title = '加载失败',
  onRetry,
}: {
  error: ApiErrorInfo;
  title?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state state-error" role="alert">
      <p className="state-title">{title}</p>
      <p className="error-message">{stripAnsi(error.message)}</p>
      <p className="error-meta">
        错误码：<code>{error.code}</code>
        {error.httpStatus !== undefined ? ` · HTTP ${String(error.httpStatus)}` : ''}
        {error.requestId ? ` · 请求 ID ${error.requestId}` : ''}
        {errorCodeLabel(error.code) !== error.code ? ` · ${errorCodeLabel(error.code)}` : ''}
      </p>
      {error.details && error.details.length > 0 ? (
        <ul className="error-details">
          {error.details.map((detail) => (
            <li key={`${detail.path}:${detail.message}`}>
              <code>{detail.path}</code>：{stripAnsi(detail.message)}
            </li>
          ))}
        </ul>
      ) : null}
      {onRetry ? (
        <button type="button" className="button" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

/**
 * 递归清洗 Notice 的「直接文本节点」：后端消息可能含 ANSI 控制符（F3）。
 * 注意：包裹在 <p>/<ul> 等元素里的文本由各调用方用 PlainText/stripAnsi 处理。
 */
function sanitizeTextNodes(node: ReactNode): ReactNode {
  if (typeof node === 'string') return stripAnsi(node);
  if (Array.isArray(node)) return node.map((child) => sanitizeTextNodes(child));
  return node;
}

export function Notice({
  tone = 'info',
  title,
  children,
  actions,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const role = tone === 'danger' || tone === 'warning' ? 'alert' : 'status';
  return (
    <div className={`notice notice-${tone}`} role={role}>
      <div className="notice-body">
        {title ? <p className="notice-title">{title}</p> : null}
        <div className="notice-text">{sanitizeTextNodes(children)}</div>
      </div>
      {actions ? <div className="notice-actions">{actions}</div> : null}
    </div>
  );
}

/** 展示后端/官方文本的最小包装：统一剥离 ANSI，保留原始值供复制 */
export function PlainText({ text }: { text: string | null | undefined }) {
  return <>{stripAnsi(text)}</>;
}

export function Card({
  title,
  description,
  actions,
  children,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const autoId = useId();
  const headingId = `${id ?? autoId}-title`;
  return (
    <section className="card" id={id} aria-labelledby={title ? headingId : undefined}>
      {title || actions ? (
        <div className="card-head">
          <div>
            {title ? <h2 id={headingId}>{title}</h2> : null}
            {description ? <p className="muted">{description}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function KeyValueList({
  items,
  ariaLabel,
  className = 'kv',
}: {
  items: { label: string; value: ReactNode }[];
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <dl className={className} aria-label={ariaLabel}>
      {items.map((item) => (
        <div className="kv-row" key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FormErrors({ errors, title = '请修正以下问题' }: { errors: readonly FieldError[]; title?: string }) {
  if (errors.length === 0) return null;
  return (
    <div className="form-errors" role="alert">
      <p className="form-errors-title">{title}</p>
      <ul>
        {errors.map((error) => (
          <li key={`${error.path}:${error.message}`}>{stripAnsi(error.message)}</li>
        ))}
      </ul>
    </div>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label htmlFor={id} className="field-label">
        {label}
        {required ? (
          <>
            {' '}
            <span className="req" aria-hidden="true">
              *
            </span>
            <span className="sr-only">（必填）</span>
          </>
        ) : null}
      </label>
      {children}
      {hint ? (
        <p className="field-hint" id={`${id}-hint`}>
          {stripAnsi(hint)}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${id}-error`} role="alert">
          {stripAnsi(error)}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter((value): value is string => value !== null);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  required,
  disabled,
  placeholder,
  type = 'text',
  maxLength,
  autoFocus,
  multiline,
  rows = 4,
  monospace,
  listId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  type?: 'text' | 'url' | 'password';
  maxLength?: number;
  autoFocus?: boolean;
  multiline?: boolean;
  rows?: number;
  monospace?: boolean;
  listId?: string;
}) {
  const common = {
    id,
    value,
    placeholder,
    disabled,
    maxLength,
    autoFocus,
    list: listId,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy(id, hint, error),
    className: `input${monospace ? ' mono' : ''}`,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required}>
      {multiline ? (
        <textarea {...(common as TextareaHTMLAttributes<HTMLTextAreaElement>)} rows={rows} />
      ) : (
        <input {...(common as InputHTMLAttributes<HTMLInputElement>)} type={type} />
      )}
    </Field>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  required,
  disabled,
  min,
  max,
  step,
}: {
  id: string;
  label: string;
  value: number | '';
  onChange: (value: number | '') => void;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required}>
      <input
        id={id}
        className="input"
        type="number"
        value={value === '' ? '' : String(value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === '') {
            onChange('');
            return;
          }
          const parsed = Number(raw);
          onChange(Number.isFinite(parsed) ? parsed : '');
        }}
      />
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function SelectField({
  id,
  label,
  value,
  options,
  onChange,
  hint,
  error,
  required,
  disabled,
  emptyLabel,
  ...rest
}: {
  id: string;
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  emptyLabel?: string;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'value' | 'onChange' | 'children'>) {
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required}>
      <select
        id={id}
        className="input"
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.target.value)}
        {...rest}
      >
        {emptyLabel ? <option value="">{emptyLabel}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function CheckboxField({
  id,
  label,
  checked,
  onChange,
  hint,
  error,
  disabled,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`field field-checkbox${error ? ' field-invalid' : ''}`}>
      <label className="checkbox" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {hint ? (
        <p className="field-hint" id={`${id}-hint`}>
          {stripAnsi(hint)}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${id}-error`} role="alert">
          {stripAnsi(error)}
        </p>
      ) : null}
    </div>
  );
}

export function CopyButton({
  text,
  label = '复制',
  copiedLabel = '已复制',
  ariaLabel,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  ariaLabel?: string;
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const onCopy = async (): Promise<void> => {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };
  return (
    <span className="copy-button">
      <button type="button" className="button button-small" onClick={() => void onCopy()} aria-label={ariaLabel ?? label}>
        {status === 'copied' ? copiedLabel : label}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {status === 'copied' ? '已复制到剪贴板' : status === 'failed' ? '复制失败，请手动选择文本复制' : ''}
      </span>
      {status === 'failed' ? <span className="copy-failed">复制失败，请手动选择文本</span> : null}
    </span>
  );
}

export function ConfirmButton({
  label,
  confirmLabel = '确认',
  cancelLabel = '取消',
  question = '确认执行该操作？',
  onConfirm,
  disabled,
  tone = 'danger',
}: {
  label: string;
  confirmLabel?: string;
  cancelLabel?: string;
  question?: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  tone?: 'danger' | 'primary' | 'plain';
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const buttonClass = tone === 'plain' ? 'button button-plain button-small' : `button button-small${tone === 'danger' ? ' button-danger' : ''}`;
  if (!confirming) {
    return (
      <button type="button" className={buttonClass} disabled={disabled} onClick={() => setConfirming(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm-group" role="group" aria-label={question}>
      <span className="confirm-question">{question}</span>
      <button
        type="button"
        className={`button button-small${tone === 'danger' ? ' button-danger' : ''}`}
        disabled={disabled || busy}
        onClick={() => {
          setBusy(true);
          void Promise.resolve(onConfirm())
            .catch(() => undefined)
            .finally(() => {
              setBusy(false);
              setConfirming(false);
            });
        }}
      >
        {busy ? '执行中…' : confirmLabel}
      </button>
      <button type="button" className="button button-plain button-small" disabled={busy} onClick={() => setConfirming(false)}>
        {cancelLabel}
      </button>
    </span>
  );
}

export function LoadMore({
  hasMore,
  loading,
  loadedCount,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  loadedCount: number;
  onLoadMore: () => void;
}) {
  return (
    <div className="load-more">
      <span className="muted">已加载 {loadedCount} 项</span>
      {hasMore ? (
        <button type="button" className="button" onClick={onLoadMore} disabled={loading}>
          {loading ? '加载中…' : '加载更多'}
        </button>
      ) : (
        <span className="muted">没有更多了</span>
      )}
    </div>
  );
}

export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  initialFocusRef,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target =
      initialFocusRef?.current ??
      dialogRef.current?.querySelector<HTMLElement>('select, input, textarea, button, [href]') ??
      dialogRef.current;
    target?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [onClose, initialFocusRef]);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" aria-label="关闭对话框" onClick={onClose}>
            ×
          </button>
        </div>
        {description ? <p className="muted dialog-description">{description}</p> : null}
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function TagList({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return <span className="muted">—</span>;
  return (
    <span className="tag-list">
      {tags.map((tag) => (
        <span className="tag" key={tag}>
          {tag}
        </span>
      ))}
    </span>
  );
}

export function CodeText({ children }: { children: string }) {
  return <pre className="code-block">{stripAnsi(children)}</pre>;
}

export function InlineFieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p className="field-error" role="alert">
      {stripAnsi(message)}
    </p>
  );
}

export function TableWrap({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

export function ReloadButton({ onClick, label = '刷新' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="button button-small" onClick={onClick}>
      {label}
    </button>
  );
}