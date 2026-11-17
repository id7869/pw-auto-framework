/**
 * 新建运行对话框：选择用例/套件（可选数据集）+ 运行参数 → POST /api/v1/runs。
 * 严格按 api-contract §5.3：202 返回 queued/running 的 Run，前端随后进入运行详情轮询。
 */
import { useMemo, useState } from 'react';
import type { ApiErrorInfo } from '../api/http.ts';
import { createIdempotencyKey } from '../api/http.ts';
import { nextIdempotencyKey } from '../lib/idempotency.ts';
import { useApi } from '../api/context.tsx';
import type { CaseListItem, Dataset, Run, RunCreateRequest, RunOptions, Suite } from '../api/types.ts';
import { useApiResource } from '../hooks/use-api-resource.ts';
import type { PageResult } from '../api/types.ts';
import {
  BROWSER_OPTIONS,
  DEFAULT_RUN_OPTIONS,
  SCREENSHOT_OPTIONS,
  TRACE_OPTIONS,
  VIDEO_OPTIONS,
  firstError,
  validateRunOptions,
} from '../lib/validation.ts';
import type { FieldError } from '../lib/validation.ts';
import {
  CheckboxField,
  Dialog,
  FormErrors,
  Notice,
  NumberField,
  SelectField,
  TextField,
} from './ui.tsx';

export type RunDialogTarget =
  | { kind: 'case'; caseId: string; caseName?: string; datasetId?: string }
  | { kind: 'suite'; suiteId: string; suiteName?: string }
  | { kind: 'choose' };

export interface RunDialogProps {
  target: RunDialogTarget;
  onClose: () => void;
  onStarted: (run: Run) => void;
}

const EMPTY_PAGE: PageResult<Dataset> = { items: [], nextCursor: null, hasMore: false };
const EMPTY_CASE_PAGE: PageResult<CaseListItem> = { items: [], nextCursor: null, hasMore: false };
const EMPTY_SUITE_PAGE: PageResult<Suite> = { items: [], nextCursor: null, hasMore: false };

export function RunDialog({ target, onClose, onStarted }: RunDialogProps) {
  const api = useApi();
  const chooser = target.kind === 'choose';
  const [kind, setKind] = useState<'case' | 'suite'>(target.kind === 'suite' ? 'suite' : 'case');
  const [caseId, setCaseId] = useState(target.kind === 'case' ? target.caseId : '');
  const [suiteId, setSuiteId] = useState(target.kind === 'suite' ? target.suiteId : '');
  const [datasetId, setDatasetId] = useState(target.kind === 'case' ? (target.datasetId ?? '') : '');
  const [options, setOptions] = useState<RunOptions>({ ...DEFAULT_RUN_OPTIONS });
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiErrorInfo | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  // 对话框打开即确定本次创建意图的幂等键；useMemo 保证同一挂载实例内稳定，失败重试复用
  const initialIdempotencyKey = useMemo(() => createIdempotencyKey(), []);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => initialIdempotencyKey);

  const cases = useApiResource<PageResult<CaseListItem>>(
    () => (chooser ? api.listCases({ limit: 100 }) : Promise.resolve({ ok: true, data: EMPTY_CASE_PAGE })),
    [chooser],
  );
  const suites = useApiResource<PageResult<Suite>>(
    () => (chooser ? api.listSuites({ limit: 100 }) : Promise.resolve({ ok: true, data: EMPTY_SUITE_PAGE })),
    [chooser],
  );
  const datasets = useApiResource(
    () => (kind === 'case' && caseId !== '' ? api.listDatasets(caseId, { limit: 100 }) : Promise.resolve({ ok: true as const, data: EMPTY_PAGE })),
    [kind, caseId],
  );

  const caseOptions = useMemo(
    () => (cases.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.name}（${item.mode === 'steps' ? '结构化' : '原始代码'}）` })),
    [cases.data],
  );
  const suiteOptions = useMemo(
    () => (suites.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.name}（${String(item.casesCount)} 个用例）` })),
    [suites.data],
  );
  const datasetOptions = useMemo(
    () => (datasets.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.name}（${String(item.rowsCount)} 行）` })),
    [datasets.data],
  );

  const fixedCaseName = target.kind === 'case' ? target.caseName : undefined;
  const fixedSuiteName = target.kind === 'suite' ? target.suiteName : undefined;

  const submit = async (): Promise<void> => {
    const errors: FieldError[] = [];
    if (kind === 'case' && caseId === '') errors.push({ path: 'caseId', message: '请选择测试用例' });
    if (kind === 'suite' && suiteId === '') errors.push({ path: 'suiteId', message: '请选择套件' });
    const optionErrors = validateRunOptions(options, reason);
    setFieldErrors([...errors, ...optionErrors]);
    setError(null);
    if (errors.length > 0 || optionErrors.length > 0) return;

    const input: RunCreateRequest =
      kind === 'case'
        ? {
            target: { kind: 'case', caseId },
            options,
            ...(datasetId !== '' ? { datasetId } : {}),
            ...(reason.trim() !== '' ? { reason: reason.trim() } : {}),
          }
        : {
            target: { kind: 'suite', suiteId },
            options,
            ...(reason.trim() !== '' ? { reason: reason.trim() } : {}),
          };

    setSubmitting(true);
    const submitKey = nextIdempotencyKey(idempotencyKey, false);
    const result = await api.createRun(input, submitKey);
    setIdempotencyKey(nextIdempotencyKey(submitKey, result.ok));
    setSubmitting(false);
    if (result.ok) {
      onStarted(result.data);
      return;
    }
    setError(result.error);
    if (result.error.details) {
      setFieldErrors(result.error.details.map((detail) => ({ path: detail.path, message: detail.message })));
    }
  };

  const targetSummary = (() => {
    if (kind === 'suite') {
      if (fixedSuiteName) return `套件：${fixedSuiteName}`;
      const found = suiteOptions.find((option) => option.value === suiteId);
      return found ? `套件：${found.label}` : '套件：未选择';
    }
    if (fixedCaseName) return `用例：${fixedCaseName}`;
    const found = caseOptions.find((option) => option.value === caseId);
    return found ? `用例：${found.label}` : '用例：未选择';
  })();

  return (
    <Dialog
      title="新建运行"
      description="运行由后端以官方 @playwright/test 子进程执行；创建后可实时查看 queued → running → 终态。"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="button" className="button button-primary" onClick={() => void submit()} disabled={submitting}>
            {submitting ? '创建中…' : '创建运行'}
          </button>
        </>
      }
    >
      <div className="dialog-form">
        {error ? <Notice tone="danger" title="创建运行失败">{error.message}（错误码：{error.code}）</Notice> : null}
        <FormErrors errors={fieldErrors} title="无法创建运行，请修正：" />

        {chooser ? (
          <SelectField
            id="run-target-kind"
            label="运行对象"
            value={kind}
            options={[
              { value: 'case', label: '测试用例（可绑定数据集）' },
              { value: 'suite', label: '套件（批量运行）' },
            ]}
            onChange={(value) => {
              setKind(value === 'suite' ? 'suite' : 'case');
              setDatasetId('');
            }}
          />
        ) : (
          <p className="run-target-summary">{targetSummary}</p>
        )}

        {chooser && kind === 'case' ? (
          cases.loading ? (
            <p className="muted">正在加载用例列表…</p>
          ) : cases.error ? (
            <Notice tone="danger" title="用例列表加载失败">
              {cases.error.message}
            </Notice>
          ) : (
            <SelectField
              id="run-case-id"
              label="测试用例"
              value={caseId}
              options={caseOptions}
              onChange={(value) => {
                setCaseId(value);
                setDatasetId('');
              }}
              emptyLabel="请选择用例"
              required
              error={firstError(fieldErrors.filter((item) => item.path === 'caseId'))?.message}
            />
          )
        ) : null}

        {chooser && kind === 'suite' ? (
          suites.loading ? (
            <p className="muted">正在加载套件列表…</p>
          ) : suites.error ? (
            <Notice tone="danger" title="套件列表加载失败">
              {suites.error.message}
            </Notice>
          ) : (
            <SelectField
              id="run-suite-id"
              label="套件"
              value={suiteId}
              options={suiteOptions}
              onChange={(value) => setSuiteId(value)}
              emptyLabel="请选择套件"
              required
              error={firstError(fieldErrors.filter((item) => item.path === 'suiteId'))?.message}
            />
          )
        ) : null}

        {kind === 'case' ? (
          <>
            {datasets.loading ? (
              <p className="muted">正在加载数据集…</p>
            ) : datasets.error ? (
              <Notice tone="warning" title="数据集加载失败（可仍然不使用数据集运行）">
                {datasets.error.message}
              </Notice>
            ) : (
              <SelectField
                id="run-dataset-id"
                label="数据集（可选）"
                value={datasetId}
                options={datasetOptions}
                onChange={(value) => setDatasetId(value)}
                emptyLabel="不使用数据集（单次执行）"
                hint="数据集中每个启用的行会生成一个独立 test，标题带 [row:N]；逐行结果在运行详情的「逐行结果」表查看。"
                disabled={caseId === '' && !fixedCaseName}
              />
            )}
            {datasets.data?.hasMore ? <p className="muted">数据集较多，仅列出前 100 个。</p> : null}
          </>
        ) : (
          <Notice tone="info" title="套件运行说明">
            套件运行不支持数据集（数据集绑定在用例上）；每个用例使用其默认数据集或单次执行。此限制来自接口合同 §4。
          </Notice>
        )}

        <details className="options">
          <summary>高级运行选项（官方 Playwright 参数）</summary>
          <div className="step-grid">
            <SelectField
              id="run-option-retries"
              label="重试次数"
              value={String(options.retries)}
              options={[0, 1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) }))}
              onChange={(value) => setOptions((prev) => ({ ...prev, retries: Number(value) }))}
              hint="首跑失败、重试通过会被官方标记为 flaky"
            />
            <SelectField
              id="run-option-workers"
              label="并行数"
              value={String(options.workers)}
              options={[1, 2, 3, 4].map((value) => ({ value: String(value), label: String(value) }))}
              onChange={(value) => setOptions((prev) => ({ ...prev, workers: Number(value) }))}
              hint="单机稳定优先，默认 1"
            />
            <NumberField
              id="run-option-timeout"
              label="运行超时（毫秒）"
              value={options.timeoutMs}
              onChange={(value) => setOptions((prev) => ({ ...prev, timeoutMs: value === '' ? 0 : value }))}
              min={1000}
              max={3600000}
              hint="1000~3600000，默认 60000"
              error={firstError(fieldErrors.filter((item) => item.path === 'options.timeoutMs'))?.message}
            />
            <SelectField
              id="run-option-trace"
              label="Trace"
              value={options.trace}
              options={TRACE_OPTIONS}
              onChange={(value) => setOptions((prev) => ({ ...prev, trace: value as RunOptions['trace'] }))}
            />
            <SelectField
              id="run-option-screenshot"
              label="截图"
              value={options.screenshot}
              options={SCREENSHOT_OPTIONS}
              onChange={(value) => setOptions((prev) => ({ ...prev, screenshot: value as RunOptions['screenshot'] }))}
            />
            <SelectField
              id="run-option-video"
              label="录屏"
              value={options.video}
              options={VIDEO_OPTIONS}
              onChange={(value) => setOptions((prev) => ({ ...prev, video: value as RunOptions['video'] }))}
            />
            <SelectField
              id="run-option-browser"
              label="浏览器"
              value={options.browser}
              options={BROWSER_OPTIONS}
              onChange={(value) => setOptions((prev) => ({ ...prev, browser: value as RunOptions['browser'] }))}
            />
            <CheckboxField
              id="run-option-headed"
              label="显示浏览器窗口（headed）"
              checked={options.headed}
              onChange={(checked) => setOptions((prev) => ({ ...prev, headed: checked }))}
              hint="本机调试用；默认无头运行"
            />
            <CheckboxField
              id="run-option-failonflaky"
              label="flaky 也判为失败（failOnFlaky）"
              checked={options.failOnFlaky}
              onChange={(checked) => setOptions((prev) => ({ ...prev, failOnFlaky: checked }))}
              hint="官方配置 failOnFlakyTests；默认关闭"
            />
            <CheckboxField
              id="run-option-allow-stale-nl"
              label="NL 已过期仍允许运行（allowStaleNl）"
              checked={options.allowStaleNl === true}
              onChange={(checked) => setOptions((prev) => ({ ...prev, allowStaleNl: checked }))}
              hint="默认关闭；NL stale 时后端返回 409 NL_STALE"
            />
          </div>
        </details>

        <TextField
          id="run-reason"
          label="运行备注（可选）"
          value={reason}
          onChange={setReason}
          hint="最多 200 字符，写入运行记录便于回归追踪"
          maxLength={200}
          error={firstError(fieldErrors.filter((item) => item.path === 'reason'))?.message}
        />

        <p className="muted">
          创建运行会在后端排队并调用官方 CLI；同一对话框内的失败重试会复用同一幂等键（Idempotency-Key），避免重复创建运行；成功后重置。
        </p>
      </div>
    </Dialog>
  );
}