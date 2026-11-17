/**
 * NL-first 用例编辑器（§12）：
 * - 业务视图：多行业务句子（行号/注释/{{列}}）+ 生成任务/验收，不出现任何动作下拉；
 * - 步骤视图：接受后只读 steps（含 NL 行映射）；
 * - 代码视图：GET /cases/{id}/spec?preview=1 只读预览，不提供从代码反推 NL。
 *
 * 本组件只渲染服务端生成的 NL/步骤/告警；不内置模型、不伪造生成结果。
 */
import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../api/context.tsx';
import type { ApiErrorInfo } from '../api/http.ts';
import type {
  Case,
  CaseInput,
  CaseValidateResult,
  Dataset,
  NlGeneration,
  NlSource,
  NlSpecPreview,
  PageResult,
  Step,
} from '../api/types.ts';
import { useApiResource } from '../hooks/use-api-resource.ts';
import { navigate } from '../hooks/use-route.ts';
import type { Tone } from '../lib/labels.ts';
import {
  NL_EXTERNAL_AGENT_NOTE,
  NL_LINE_KIND_LABELS,
  NL_STATUS_LABELS,
  NL_STATUS_TONES,
} from '../lib/labels.ts';
import { formatDateTime } from '../lib/format.ts';
import { buildHref } from '../lib/hash-router.ts';
import {
  formatNlLines,
  isGenerationActive,
  isGenerationStale,
  nlLinesFromStepOrigin,
} from '../lib/nl.ts';
import {
  formatTagsInput,
  parseTagsInput,
  toFieldErrors,
  validateCaseForm,
} from '../lib/validation.ts';
import type { FieldError } from '../lib/validation.ts';
import { NlTextEditor } from '../components/nl/NlTextEditor.tsx';
import { NlGenerationPanel } from '../components/nl/NlGenerationPanel.tsx';
import { StepReadOnlyTable } from '../components/nl/StepReadOnlyTable.tsx';
import { RunDialog } from '../components/RunDialog.tsx';
import {
  Badge,
  Card,
  CodeText,
  EmptyState,
  ErrorState,
  FormErrors,
  KeyValueList,
  LoadingState,
  Notice,
  PageHeader,
  PlainText,
  SelectField,
  TagList,
  TextField,
} from '../components/ui.tsx';

const EMPTY_DATASETS: PageResult<Dataset> = { items: [], nextCursor: null, hasMore: false };

type ViewMode = 'business' | 'steps' | 'code';
type BasicsState = { name: string; description: string; tagsText: string; status: 'active' | 'archived' };
interface NoticeState {
  tone: Tone;
  title: string;
  text: string;
}

export function NlCaseEditor({ caseItem }: { caseItem: Case | null }) {
  const api = useApi();
  const caseId = caseItem?.id ?? null;

  const [caseData, setCaseData] = useState<Case | null>(caseItem);
  const [basics, setBasics] = useState<BasicsState>({
    name: caseItem?.name ?? '',
    description: caseItem?.description ?? '',
    tagsText: formatTagsInput(caseItem?.tags ?? []),
    status: caseItem?.status === 'archived' ? 'archived' : 'active',
  });
  const [version, setVersion] = useState<number | null>(caseItem?.version ?? null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(caseItem?.updatedAt ?? null);
  const [nlText, setNlText] = useState(caseItem?.nl?.text ?? '');
  const [savedNlText, setSavedNlText] = useState(caseItem?.nl?.text ?? '');
  const [nlSource, setNlSource] = useState<NlSource | null>(caseItem?.nl ?? null);
  const [view, setView] = useState<ViewMode>('business');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [formError, setFormError] = useState<ApiErrorInfo | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [saving, setSaving] = useState(false);
  const [datasetId, setDatasetId] = useState('');
  const [runOpen, setRunOpen] = useState(false);

  const [generation, setGeneration] = useState<NlGeneration | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<ApiErrorInfo | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [acceptForce, setAcceptForce] = useState(false);

  const [spec, setSpec] = useState<NlSpecPreview | null>(null);
  const [specLoading, setSpecLoading] = useState(false);
  const [specError, setSpecError] = useState<ApiErrorInfo | null>(null);

  const [validateResult, setValidateResult] = useState<CaseValidateResult | null>(null);
  const [validateError, setValidateError] = useState<ApiErrorInfo | null>(null);
  const [validating, setValidating] = useState(false);

  const datasets = useApiResource<PageResult<Dataset>>(
    () => (caseId ? api.listDatasets(caseId, { limit: 100 }) : Promise.resolve({ ok: true, data: EMPTY_DATASETS })),
    [caseId],
  );
  const datasetItems = datasets.data?.items ?? [];
  const selectedDataset = datasetItems.find((item) => item.id === datasetId) ?? null;
  const datasetColumns = selectedDataset?.columns ?? [];

  const setBasicsField = <K extends keyof BasicsState>(key: K, value: BasicsState[K]): void => {
    setBasics((prev) => ({ ...prev, [key]: value }));
  };

  const applyCase = useCallback((next: Case): void => {
    setCaseData(next);
    setVersion(next.version);
    setUpdatedAt(next.updatedAt);
    setNlSource(next.nl ?? null);
    if (next.nl) {
      setNlText(next.nl.text);
      setSavedNlText(next.nl.text);
    }
    setBasics({
      name: next.name,
      description: next.description ?? '',
      tagsText: formatTagsInput(next.tags ?? []),
      status: next.status === 'archived' ? 'archived' : 'active',
    });
  }, []);

  const refreshCase = useCallback(async (): Promise<void> => {
    if (!caseId) return;
    const result = await api.getCase(caseId);
    if (result.ok) applyCase(result.data);
  }, [api, applyCase, caseId]);

  // 打开用例时恢复最近一次活跃/待验收的生成任务
  useEffect(() => {
    if (!caseId) return;
    let alive = true;
    void api.listNlGenerations(caseId, { limit: 10 }).then((result) => {
      if (!alive || !result.ok) return;
      const latest = result.data.items.find(
        (item) => item.status === 'queued' || item.status === 'running' || item.status === 'ready',
      );
      if (latest) setGeneration(latest);
    });
    return () => {
      alive = false;
    };
  }, [api, caseId]);

  // 轮询生成任务（queued/running）；失败退避重试，不伪造状态
  useEffect(() => {
    if (!caseId || !generation) return;
    if (!isGenerationActive(generation.status)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const result = await api.getNlGeneration(caseId, generation.id);
      if (cancelled) return;
      if (result.ok) {
        setGeneration(result.data);
        if (isGenerationActive(result.data.status)) {
          timer = setTimeout(() => void tick(), 2000);
        } else {
          await refreshCase();
        }
      } else {
        setGenError(result.error);
        timer = setTimeout(() => void tick(), 5000);
      }
    };
    timer = setTimeout(() => void tick(), 1500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, caseId, generation?.id, generation?.status, refreshCase, generation]);

  const validateBasics = (): FieldError[] =>
    validateCaseForm({
      name: basics.name,
      description: basics.description,
      mode: 'steps',
      steps: [],
      code: '',
      tagsText: basics.tagsText,
      status: basics.status,
    });

  const saveCase = async (): Promise<string | null> => {
    setFormError(null);
    setNotice(null);
    const clientErrors = validateBasics();
    setErrors(clientErrors);
    if (clientErrors.length > 0) return null;
    const tags = parseTagsInput(basics.tagsText);
    setSaving(true);
    if (!caseId) {
      const input: CaseInput = {
        name: basics.name.trim(),
        description: basics.description.trim(),
        mode: 'steps',
        steps: [],
        code: null,
        tags,
        ...(nlText.trim() === '' ? {} : { nl: { text: nlText } }),
      };
      const result = await api.createCase(input);
      setSaving(false);
      if (!result.ok) {
        setFormError(result.error);
        const serverErrors = toFieldErrors(result.error.details);
        if (serverErrors.length > 0) setErrors(serverErrors);
        return null;
      }
      return result.data.id;
    }

    const patch: CaseInput = {
      name: basics.name.trim(),
      description: basics.description.trim(),
      tags,
      status: basics.status,
    };
    const result = await api.patchCase(caseId, version ?? caseData?.version ?? 1, patch);
    if (!result.ok) {
      setSaving(false);
      setFormError(result.error);
      const serverErrors = toFieldErrors(result.error.details);
      if (serverErrors.length > 0) setErrors(serverErrors);
      return null;
    }
    setVersion(result.data.version);
    setUpdatedAt(result.data.updatedAt);

    if (nlText.trim() !== savedNlText) {
      if (nlText.trim() === '') {
        setSaving(false);
        setFormError({ code: 'VALIDATION_FAILED', message: 'NL 文本不能为空；如需移除 NL 请先改用旧版步骤编辑或调用删除接口' });
        return null;
      }
      const putResult = await api.putCaseNl(caseId, nlText);
      if (!putResult.ok) {
        setSaving(false);
        setFormError(putResult.error);
        return null;
      }
      setNlSource(putResult.data);
      setSavedNlText(nlText);
    }
    const fresh = await api.getCase(caseId);
    setSaving(false);
    if (fresh.ok) applyCase(fresh.data);
    setNotice({ tone: 'success', title: '保存成功', text: 'NL 文本已保存；生成并接受后才会成为可执行的 steps。' });
    return caseId;
  };

  const createGeneration = async (targetCaseId: string, force: boolean): Promise<void> => {
    setGenError(null);
    setGenBusy(true);
    const result = await api.createNlGeneration(targetCaseId, { generator: 'agent', force });
    setGenBusy(false);
    if (result.ok) {
      setGeneration(result.data);
      setNotice({
        tone: 'info',
        title: '生成任务已创建',
        text: '等待外部 coding agent 领取并提交生成结果；本框架不内置模型，页面会自动轮询状态。',
      });
      void refreshCase();
    } else {
      setGenError(result.error);
    }
  };

  const handleSave = async (): Promise<void> => {
    const savedId = await saveCase();
    if (savedId && !caseId) {
      navigate(`/cases/${encodeURIComponent(savedId)}/edit`, { created: '1' });
    }
  };

  const handleSaveAndGenerate = async (): Promise<void> => {
    const savedId = await saveCase();
    if (!savedId) return;
    if (!caseId) {
      await createGeneration(savedId, false);
      navigate(`/cases/${encodeURIComponent(savedId)}/edit`, { created: '1' });
      return;
    }
    await createGeneration(savedId, false);
  };

  const handleGenerate = async (): Promise<void> => {
    if (!caseId) {
      setNotice({ tone: 'warning', title: '尚未保存', text: '请先保存用例与 NL 文本，再创建生成任务。' });
      return;
    }
    if (nlText.trim() === '') {
      setNotice({ tone: 'warning', title: 'NL 为空', text: '请先填写业务句子。' });
      return;
    }
    if (nlText !== savedNlText) {
      const savedId = await saveCase();
      if (!savedId) return;
    }
    await createGeneration(caseId, false);
  };

  const handleRegenerate = async (): Promise<void> => {
    if (!caseId) return;
    await createGeneration(caseId, true);
  };

  const handleAccept = async (): Promise<void> => {
    if (!caseId || !generation) return;
    setGenError(null);
    setGenBusy(true);
    const stale = isGenerationStale(generation, nlSource);
    const result = await api.acceptNlGeneration(caseId, generation.id, {
      force: stale && acceptForce,
      code: false,
    });
    setGenBusy(false);
    if (result.ok) {
      applyCase(result.data.case);
      setGeneration(result.data.generation);
      setSpec(null);
      setView('steps');
      setAcceptForce(false);
      setNotice({
        tone: 'success',
        title: '已接受生成结果',
        text: '执行真相是本次写入的 steps；可切换到步骤/代码视图检查。',
      });
    } else {
      setGenError(result.error);
    }
  };

  const handleReject = async (): Promise<void> => {
    if (!caseId || !generation) return;
    if (rejectReason.trim() === '') {
      setGenError({ code: 'VALIDATION_FAILED', message: '请填写拒绝原因' });
      return;
    }
    setGenBusy(true);
    setGenError(null);
    const result = await api.rejectNlGeneration(caseId, generation.id, rejectReason.trim());
    setGenBusy(false);
    if (result.ok) {
      setGeneration(result.data);
      setRejectReason('');
      setNotice({ tone: 'info', title: '已拒绝生成结果', text: '可修改 NL 文本后重新生成。' });
    } else {
      setGenError(result.error);
    }
  };

  const handleCancel = async (): Promise<void> => {
    if (!caseId || !generation) return;
    setGenBusy(true);
    const result = await api.cancelNlGeneration(caseId, generation.id);
    setGenBusy(false);
    if (result.ok) {
      setGeneration(result.data);
      setNotice({ tone: 'info', title: '已取消生成任务', text: '可以修改文本后重新生成。' });
    } else {
      setGenError(result.error);
    }
  };

  const loadSpec = async (): Promise<void> => {
    if (!caseId) return;
    setSpecLoading(true);
    setSpecError(null);
    const result = await api.previewCaseSpec(caseId);
    setSpecLoading(false);
    if (result.ok) setSpec(result.data);
    else setSpecError(result.error);
  };

  useEffect(() => {
    if (view === 'code' && caseId && spec === null && !specLoading && specError === null) void loadSpec();
    // 只依赖视图/用例；spec 状态由手动刷新管理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, caseId]);

  const handleValidate = async (): Promise<void> => {
    if (!caseId) {
      setNotice({ tone: 'warning', title: '尚未保存', text: '请先保存用例后再校验。' });
      return;
    }
    setValidating(true);
    setValidateError(null);
    setValidateResult(null);
    const result = await api.validateCase(caseId, datasetId === '' ? {} : { datasetId });
    setValidating(false);
    if (result.ok) setValidateResult(result.data);
    else setValidateError(result.error);
  };

  const runBlockReason = (() => {
    if (!caseId) return '请先保存用例';
    if (!nlSource) return '该用例没有 NL 源';
    if (nlSource.status === 'draft' || nlSource.status === 'generating' || nlSource.status === 'invalid') {
      return NL_STATUS_LABELS[nlSource.status];
    }
    return null;
  })();
  const steps: Step[] = caseData?.steps ?? [];
  const nlLines = nlLinesFromStepOrigin(caseData?.stepOrigin);
  const unsavedNl = nlText !== savedNlText;

  return (
    <div className="page">
      <PageHeader
        title={caseId ? `编辑用例 · ${basics.name || caseId}` : '新建自然语言用例'}
        description="用业务句子描述测试；生成并接受后，执行真相是官方 Playwright steps。本框架不内置模型，生成由外部 coding agent/skill 完成。"
        actions={
          <>
            <a className="button" href={buildHref('/cases')}>
              返回列表
            </a>
            <button type="button" className="button" onClick={() => void handleSave()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button type="button" className="button button-primary" onClick={() => void handleSaveAndGenerate()} disabled={saving || genBusy || nlText.trim() === ''}>
              保存并生成
            </button>
            <button type="button" className="button" onClick={() => void handleValidate()} disabled={validating || caseId === null}>
              {validating ? '校验中…' : '编译校验'}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setRunOpen(true)}
              disabled={caseId === null || runBlockReason !== null}
              title={runBlockReason ?? undefined}
            >
              运行
            </button>
          </>
        }
      />

      {notice ? (
        <Notice tone={notice.tone} title={notice.title}>
          {notice.text}
        </Notice>
      ) : null}
      {formError ? (
        <Notice tone="danger" title={`保存失败（${formError.code}）`}>
          {formError.message}
          {formError.requestId ? `（请求 ID：${formError.requestId}）` : ''}
        </Notice>
      ) : null}
      <FormErrors errors={errors} />
      {validateError ? (
        <ErrorState error={validateError} title="编译校验失败" onRetry={() => void handleValidate()} />
      ) : null}
      {validateResult ? (
        <Notice tone={validateResult.ok ? 'success' : 'danger'} title={validateResult.ok ? '校验通过' : '校验未通过'}>
          <p>
            步骤数：{validateResult.stepsCount} · 数据行数：{validateResult.rowsCount}
          </p>
          {validateResult.warnings.length > 0 ? (
            <ul className="tight-list">
              {validateResult.warnings.map((warning) => (
                <li key={`${warning.code}:${warning.stepId ?? ''}:${warning.message}`}>
                  [{warning.code}] {warning.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}

      <Card title="基本信息" description="名称必填；NL 文本只描述业务意图，不要求选择动作。">
        <div className="form-grid">
          <TextField
            id="nl-case-name"
            label="用例名称"
            value={basics.name}
            onChange={(value) => setBasicsField('name', value)}
            required
            maxLength={200}
            placeholder="例如：登录后看到欢迎语"
            error={errors.find((error) => error.path === 'name')?.message}
            disabled={saving}
          />
          <TextField
            id="nl-case-description"
            label="描述（可选）"
            value={basics.description}
            onChange={(value) => setBasicsField('description', value)}
            maxLength={2000}
            disabled={saving}
          />
          <TextField
            id="nl-case-tags"
            label="标签（可选）"
            value={basics.tagsText}
            onChange={(value) => setBasicsField('tagsText', value)}
            placeholder="@fast, 首页"
            hint="逗号分隔，最多 20 个"
            disabled={saving}
          />
          <SelectField
            id="nl-case-status"
            label="用例状态"
            value={basics.status}
            options={[
              { value: 'active', label: '启用（active）' },
              { value: 'archived', label: '归档（archived）' },
            ]}
            onChange={(value) => setBasicsField('status', value === 'archived' ? 'archived' : 'active')}
            disabled={saving}
          />
          <div className="field">
            <span className="field-label">标签预览</span>
            <TagList tags={parseTagsInput(basics.tagsText)} />
          </div>
        </div>
      </Card>

      <div className="view-tabs" role="tablist" aria-label="用例视图">
        {(
          [
            ['business', '业务（NL）'],
            ['steps', '步骤（只读）'],
            ['code', '代码（只读）'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            className={`button${view === value ? ' button-primary' : ''}`}
            onClick={() => setView(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'business' ? (
        <>
          <Card
            title="业务句子"
            description="一行一句；以 # 开头为注释；可用 {{列名}} 引用数据集列。生成由外部 agent 完成，本框架不内置模型。"
            actions={
              <div className="row-actions">
                <button type="button" className="button button-small" onClick={() => void handleSave()} disabled={saving}>
                  保存 NL
                </button>
                <button
                  type="button"
                  className="button button-small button-primary"
                  onClick={() => void handleGenerate()}
                  disabled={saving || genBusy || nlText.trim() === '' || (caseId !== null && generation !== null && isGenerationActive(generation.status))}
                >
                  生成步骤（agent）
                </button>
              </div>
            }
          >
            {nlSource ? (
              <div className="nl-status-row">
                <Badge tone={NL_STATUS_TONES[nlSource.status]}>{NL_STATUS_LABELS[nlSource.status]}</Badge>
                {nlSource.origin ? <span className="muted">来源：{nlSource.origin}</span> : null}
                {nlSource.generatorVersion ? <span className="muted mono">生成器：{nlSource.generatorVersion}</span> : null}
                {nlSource.status === 'stale' ? (
                  <span className="field-warning">文本已修改：重新生成并接受后才能继续运行</span>
                ) : null}
              </div>
            ) : (
              <Notice tone="info" title="这是 NL 草稿">
                填写业务句子并保存后创建生成任务；生成并接受后才会写入可执行 steps。
              </Notice>
            )}
            {nlSource?.status === 'stale' ? (
              <Notice tone="warning" title="NL 已过期（stale）">
                <p>{NL_EXTERNAL_AGENT_NOTE}</p>
                <p>直接运行会被后端以 409 NL_STALE 拦截；请在运行对话框勾选 allowStaleNl，或重新生成并接受。</p>
              </Notice>
            ) : null}
            {unsavedNl ? <p className="field-warning">NL 文本有未保存修改；请先保存再生成。</p> : null}

            <NlTextEditor
              value={nlText}
              onChange={(value) => {
                setNlText(value);
                setGenError(null);
              }}
              disabled={saving || genBusy || nlSource?.status === 'generating'}
              columns={datasetColumns}
            />

            {nlSource && nlSource.lines.length > 0 ? (
              <details className="nl-server-lines">
                <summary>服务端 NL 行解析（{nlSource.lines.length} 行；只读）</summary>
                <ul className="tight-list">
                  {nlSource.lines.map((line) => (
                    <li key={line.line}>
                      <span className="mono">第 {line.line} 行</span>{' '}
                      <Badge tone="neutral">{NL_LINE_KIND_LABELS[line.kind] ?? line.kind}</Badge>{' '}
                      {line.stepId ? <span className="mono muted">→ {line.stepId}</span> : null}{' '}
                      <PlainText text={line.text} />
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div className="form-grid">
              <SelectField
                id="nl-dataset"
                label="数据集（可选）"
                value={datasetId}
                options={datasetItems.map((dataset) => ({
                  value: dataset.id,
                  label: `${dataset.name}（${String(dataset.rowsCount)} 行 / 启用 ${String(dataset.enabledRowsCount)}）`,
                }))}
                onChange={setDatasetId}
                emptyLabel="不使用数据集"
                hint="列名可插入 NL 文本；带数据集运行时一行生成一个独立 test（[row:N]）"
                disabled={saving || datasets.loading}
              />
              {datasets.error ? (
                <Notice tone="warning" title="数据集加载失败（仍可不用数据集）">
                  {datasets.error.message}
                </Notice>
              ) : null}
              {selectedDataset ? (
                <div className="field">
                  <span className="field-label">数据集列</span>
                  <div className="nl-columns">
                    {selectedDataset.columns.length === 0 ? <span className="muted">该数据集没有列</span> : null}
                    {selectedDataset.columns.map((column) => (
                      <code className="tag mono" key={column}>
                        {`{{${column}}}`}
                      </code>
                    ))}
                  </div>
                  <p className="muted">在下方业务句子编辑器的列按钮中点击同名变量即可插入到光标处。</p>
                  {selectedDataset.enabledRowsCount === 0 ? (
                    <p className="field-warning">该数据集所有行均已禁用；带数据集运行会返回 422 EMPTY_DATASET。</p>
                  ) : null}
                </div>
              ) : null}
            </div>
            {selectedDataset ? (
              <p className="muted">
                当前数据集：{selectedDataset.name} · {selectedDataset.rowsCount} 行（启用 {selectedDataset.enabledRowsCount} 行）。数据行编辑请到{' '}
                <a href={buildHref('/datasets', { caseId: caseId ?? undefined, datasetId: selectedDataset.id })}>数据集页</a>。
              </p>
            ) : (
              <p className="muted">
                还没有数据集？可在 <a href={buildHref('/datasets', { caseId: caseId ?? undefined })}>数据集页</a> 为用例创建。
              </p>
            )}

            {caseId ? (
              <div className="row-actions">
                <button type="button" className="button button-small" onClick={() => void handleValidate()} disabled={validating}>
                  {validating ? '校验中…' : '带数据集校验'}
                </button>
                <button type="button" className="button button-small" onClick={() => setRunOpen(true)} disabled={runBlockReason !== null} title={runBlockReason ?? undefined}>
                  运行（可带数据集）
                </button>
              </div>
            ) : (
              <p className="muted">首次保存后才能生成/校验/运行。</p>
            )}
          </Card>

          {generation ? (
            <NlGenerationPanel
              generation={generation}
              nlSource={nlSource}
              busy={genBusy}
              error={genError}
              rejectReason={rejectReason}
              acceptForce={acceptForce}
              onRejectReasonChange={setRejectReason}
              onAcceptForceChange={setAcceptForce}
              onAccept={() => void handleAccept()}
              onReject={() => void handleReject()}
              onCancel={() => void handleCancel()}
              onRegenerate={() => void handleRegenerate()}
            />
          ) : (
            <Card title="生成任务" description="保存 NL 后点击“生成步骤（agent）”创建任务；任务由外部 skill 领取生成。">
              <p className="muted">{NL_EXTERNAL_AGENT_NOTE}</p>
              <EmptyState title="还没有生成任务" description="先保存 NL 文本，再生成步骤并在这里验收。" />
            </Card>
          )}
        </>
      ) : null}

      {view === 'steps' ? (
        <Card
          title="步骤（只读）"
          description="执行真相是服务端 steps；由 NL 生成结果 Accept 后写入。原始 NL 行号来自 stepOrigin。"
          actions={<span className="muted">共 {steps.length} 步 · NL 行：{formatNlLines(nlLines)}</span>}
        >
          {caseId === null ? (
            <EmptyState title="尚未保存" description="保存并接受生成结果后才能查看步骤。" />
          ) : (
            <StepReadOnlyTable caseItem={{ ...(caseData ?? ({} as Case)), steps, stepOrigin: caseData?.stepOrigin ?? null, nl: nlSource }} />
          )}
        </Card>
      ) : null}

      {view === 'code' ? (
        <Card
          title="代码（只读预览）"
          description="由官方 @playwright/test 编译生成；只读，用于审计/复现。不提供从代码反推 NL 的能力。"
          actions={
            <button type="button" className="button button-small" onClick={() => void loadSpec()} disabled={specLoading || caseId === null}>
              {specLoading ? '加载中…' : '刷新预览'}
            </button>
          }
        >
          {caseId === null ? (
            <EmptyState title="尚未保存" description="保存用例后可预览编译产物。" />
          ) : specLoading && spec === null ? (
            <LoadingState label="正在加载代码预览…" />
          ) : specError ? (
            <ErrorState error={specError} title="代码预览不可用" onRetry={() => void loadSpec()} />
          ) : spec ? (
            <>
              <p className="muted">
                步骤数：{spec.stepsCount} · 数据行数：{spec.rowsCount}
              </p>
              {spec.warnings.length > 0 ? (
                <Notice tone="warning" title="编译告警">
                  <ul className="tight-list">
                    {spec.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
              <CodeText>{spec.text}</CodeText>
              <p className="muted">代码只读；不会从代码反向生成 NL。修改 NL 后请重新生成并接受。</p>
            </>
          ) : (
            <EmptyState title="尚未加载预览" description="点击“刷新预览”读取 GET /cases/{id}/spec?preview=1。" />
          )}
        </Card>
      ) : null}

      <Card title="版本信息" description="保存 NL 会重置为草稿；已接受后再次修改会产生 stale。">
        <KeyValueList
          items={[
            { label: '用例 ID', value: <span className="mono break-all">{caseId ?? '未保存（保存后生成）'}</span> },
            { label: '当前版本', value: version === null ? '未保存' : String(version) },
            { label: 'NL 状态', value: nlSource ? NL_STATUS_LABELS[nlSource.status] : '无 NL' },
            { label: '来源哈希', value: <span className="mono">{nlSource?.sourceHash ?? '—'}</span> },
            { label: '最后更新', value: formatDateTime(updatedAt) },
            { label: 'stepOrigin 行', value: formatNlLines(nlLines) },
          ]}
        />
      </Card>

      {runOpen && caseId ? (
        <RunDialog
          target={{ kind: 'case', caseId, caseName: basics.name, datasetId: datasetId === '' ? undefined : datasetId }}
          onClose={() => setRunOpen(false)}
          onStarted={(run) => {
            setRunOpen(false);
            navigate(`/runs/${encodeURIComponent(run.id)}`);
          }}
        />
      ) : null}
    </div>
  );
}