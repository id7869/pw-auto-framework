/**
 * 用例编辑器：结构化步骤 / 原始 Playwright Test 代码双模式，带本地草稿与版本信息。
 * 接口：GET/POST/PATCH /api/v1/cases、POST /cases/{id}/validate（api-contract §2）。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useApi } from '../api/context.tsx';
import type { ApiErrorInfo } from '../api/http.ts';
import type { Case, CaseValidateResult, Dataset } from '../api/types.ts';
import type { PageResult } from '../api/types.ts';
import { useApiResource } from '../hooks/use-api-resource.ts';
import { navigate, useRoute } from '../hooks/use-route.ts';
import type { Tone } from '../lib/labels.ts';
import { CASE_MODE_LABELS } from '../lib/labels.ts';
import { formatDateTime } from '../lib/format.ts';
import { stripAnsi } from '../lib/ansi.ts';
import { buildHref, hrefForCase } from '../lib/hash-router.ts';
import { normalizeSteps } from '../lib/steps.ts';
import type { CaseDraft } from '../lib/drafts.ts';
import { clearCaseDraft, getLocalStorage, loadCaseDraft, saveCaseDraft } from '../lib/drafts.ts';
import type { CaseFormValues, FieldError } from '../lib/validation.ts';
import { formatTagsInput, parseTagsInput, toCaseInput, toCasePatchInput, toFieldErrors, validateCaseForm } from '../lib/validation.ts';
import { StepEditor } from '../components/StepEditor.tsx';
import { RunDialog } from '../components/RunDialog.tsx';
import { NlCaseEditor } from './NlCaseEditor.tsx';
import {
  Card,
  CodeText,
  ErrorState,
  FormErrors,
  KeyValueList,
  LoadingState,
  Notice,
  PageHeader,
  SelectField,
  TagList,
  TextField,
} from '../components/ui.tsx';

const EMPTY_DATASETS: PageResult<Dataset> = { items: [], nextCursor: null, hasMore: false };

function emptyCaseForm(): CaseFormValues {
  return { name: '', description: '', mode: 'steps', steps: [], code: '', tagsText: '', status: 'active' };
}

function fromCase(item: Case): CaseFormValues {
  return {
    name: item.name,
    description: item.description ?? '',
    mode: item.mode === 'code' ? 'code' : 'steps',
    steps: item.mode === 'steps' ? (item.steps ?? []) : [],
    code: item.code ?? '',
    tagsText: formatTagsInput(item.tags ?? []),
    status: item.status === 'archived' ? 'archived' : 'active',
  };
}

interface NoticeState {
  tone: Tone;
  title: string;
  text: ReactNode;
}

export function CaseEditorPage() {
  const api = useApi();
  const route = useRoute();
  const caseId = route.name === 'case-edit' ? route.caseId : null;
  const isNew = caseId === null;

  const [form, setForm] = useState<CaseFormValues>(emptyCaseForm);
  const [version, setVersion] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [initializedFor, setInitializedFor] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [formError, setFormError] = useState<ApiErrorInfo | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftCandidate, setDraftCandidate] = useState<CaseDraft | null>(null);
  const [draftNotice, setDraftNotice] = useState('');
  const [validateDatasetId, setValidateDatasetId] = useState('');
  const [validateResult, setValidateResult] = useState<CaseValidateResult | null>(null);
  const [validateError, setValidateError] = useState<ApiErrorInfo | null>(null);
  const [validating, setValidating] = useState(false);
  const [runOpen, setRunOpen] = useState(false);

  const caseResource = useApiResource<Case | null>(
    () => (caseId ? api.getCase(caseId) : Promise.resolve({ ok: true as const, data: null })),
    [caseId],
  );
  const datasetsResource = useApiResource<PageResult<Dataset>>(
    () => (caseId ? api.listDatasets(caseId, { limit: 100 }) : Promise.resolve({ ok: true as const, data: EMPTY_DATASETS })),
    [caseId],
  );

  useEffect(() => {
    if (caseId === null) {
      if (initializedFor !== 'new') {
        setInitializedFor('new');
        setForm(emptyCaseForm());
        setVersion(null);
        setUpdatedAt(null);
      }
      return;
    }
    const loaded = caseResource.data;
    if (loaded && loaded.id === caseId && initializedFor !== `${loaded.id}:${String(loaded.version)}`) {
      setForm(fromCase(loaded));
      setVersion(loaded.version);
      setUpdatedAt(loaded.updatedAt);
      setInitializedFor(`${loaded.id}:${String(loaded.version)}`);
      setErrors([]);
      setFormError(null);
    }
  }, [caseId, caseResource.data, initializedFor]);

  useEffect(() => {
    const draft = loadCaseDraft(getLocalStorage(), caseId);
    setDraftCandidate(draft);
  }, [caseId]);

  useEffect(() => {
    if (!isNew && caseResource.data && route.query['created'] === '1' && notice === null) {
      setNotice({ tone: 'success', title: '用例已创建', text: '可以继续编辑步骤，或点击「运行」创建第一次运行。' });
    }
  }, [isNew, caseResource.data, route.query, notice]);

  const errorAt = (path: string): string | undefined => errors.find((error) => error.path === path)?.message;
  const tagsPreview = parseTagsInput(form.tagsText);

  const setField = <K extends keyof CaseFormValues>(key: K, value: CaseFormValues[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveDraft = (): void => {
    const ok = saveCaseDraft(getLocalStorage(), caseId, form);
    setDraftNotice(
      ok
        ? `草稿已保存到本地浏览器（${formatDateTime(new Date().toISOString())}）；仅包含用例内容，不含任何密钥。`
        : '草稿保存失败：浏览器本地存储不可用（可能处于隐私模式）。',
    );
  };

  const discardDraft = (): void => {
    clearCaseDraft(getLocalStorage(), caseId);
    setDraftCandidate(null);
    setDraftNotice('已丢弃本地草稿。');
  };

  const restoreDraft = (): void => {
    if (!draftCandidate) return;
    setForm(draftCandidate.values);
    setDraftCandidate(null);
    setDraftNotice(`已恢复 ${formatDateTime(draftCandidate.savedAt)} 保存的草稿，请确认后保存。`);
  };

  const reloadFromServer = (): void => {
    setInitializedFor(null);
    setFormError(null);
    caseResource.reload();
  };

  const handleSave = async (): Promise<void> => {
    setNotice(null);
    setFormError(null);
    const clientErrors = validateCaseForm(form);
    setErrors(clientErrors);
    if (clientErrors.length > 0) {
      setNotice({ tone: 'danger', title: '表单校验未通过', text: '请修正下面标注的问题后再保存。' });
      return;
    }
    setSaving(true);
    const createInput = toCaseInput(form);
    const result = caseId
      ? await api.patchCase(caseId, version ?? 1, toCasePatchInput(form))
      : await api.createCase(createInput);
    setSaving(false);

    if (result.ok) {
      const saved = result.data;
      setVersion(saved.version);
      setUpdatedAt(saved.updatedAt);
      setErrors([]);
      clearCaseDraft(getLocalStorage(), caseId);
      setDraftCandidate(null);
      if (caseId === null) {
        navigate(`/cases/${encodeURIComponent(saved.id)}/edit`, { created: '1' });
      } else {
        setInitializedFor(`${saved.id}:${String(saved.version)}`);
        setNotice({ tone: 'success', title: '保存成功', text: `已保存（版本 ${String(saved.version)}）。` });
      }
      return;
    }

    setFormError(result.error);
    const serverErrors = toFieldErrors(result.error.details);
    if (serverErrors.length > 0) setErrors(serverErrors);
    const stored = saveCaseDraft(getLocalStorage(), caseId, form);
    setNotice({
      tone: 'danger',
      title: `保存失败（${result.error.code}）`,
      text: `${result.error.message}${stored ? '；草稿已保留在本地浏览器，可稍后重试。' : ''}`,
    });
  };

  const handleValidate = async (): Promise<void> => {
    if (!caseId) {
      setNotice({ tone: 'warning', title: '尚未保存', text: '请先保存用例后再做编译校验。' });
      return;
    }
    setValidating(true);
    setValidateError(null);
    setValidateResult(null);
    const result = await api.validateCase(caseId, validateDatasetId !== '' ? { datasetId: validateDatasetId } : {});
    setValidating(false);
    if (result.ok) setValidateResult(result.data);
    else setValidateError(result.error);
  };

  if (caseId && caseResource.loading && version === null) {
    return (
      <div className="page">
        <LoadingState label="正在加载用例…" />
      </div>
    );
  }

  if (caseId && caseResource.error) {
    return (
      <div className="page">
        <PageHeader title="编辑用例" actions={<a className="button" href={buildHref('/cases')}>返回用例列表</a>} />
        <ErrorState
          error={caseResource.error}
          title={caseResource.error.code === 'NOT_FOUND' ? '用例不存在或已删除' : '用例加载失败'}
          onRetry={reloadFromServer}
        />
      </div>
    );
  }

  if (isNew) {
    return <NlCaseEditor key="new" caseItem={null} />;
  }

  if (caseResource.data?.nl) {
    return <NlCaseEditor key={caseResource.data.id} caseItem={caseResource.data} />;
  }

  const title = isNew ? '新建用例' : `编辑用例 · ${form.name || caseId}`;

  return (
    <div className="page">
      <PageHeader
        title={title}
        description="结构化步骤会编译为官方 @playwright/test 规格；每行数据集会生成一个独立 test（标题带 [row:N]）。"
        actions={
          <>
            <a className="button" href={buildHref('/cases')}>
              返回列表
            </a>
            <button type="button" className="button" onClick={handleSaveDraft} disabled={saving}>
              保存草稿
            </button>
            <button type="button" className="button" onClick={() => void handleValidate()} disabled={saving || validating || caseId === null}>
              {validating ? '校验中…' : '编译校验'}
            </button>
            <button type="button" className="button" onClick={() => setRunOpen(true)} disabled={saving || caseId === null || version === null}>
              运行
            </button>
            <button type="button" className="button button-primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      />

      {draftCandidate ? (
        <Notice
          tone="warning"
          title={`检测到本地草稿（保存于 ${formatDateTime(draftCandidate.savedAt)}）`}
          actions={
            <>
              <button type="button" className="button button-small button-primary" onClick={restoreDraft}>
                恢复草稿
              </button>
              <button type="button" className="button button-small" onClick={discardDraft}>
                丢弃草稿
              </button>
            </>
          }
        >
          草稿只保存在当前浏览器，不包含任何密钥；恢复后会覆盖当前表单内容。
        </Notice>
      ) : null}
      {draftNotice !== '' ? (
        <Notice tone="info" title="草稿">
          {draftNotice}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone={notice.tone} title={notice.title}>
          {notice.text}
        </Notice>
      ) : null}
      {formError ? (
        <Notice tone="danger" title={`保存失败（${formError.code}）`}>
          {formError.message}
          {formError.requestId ? `（请求 ID：${formError.requestId}）` : ''}
          {formError.code === 'VERSION_CONFLICT' ? (
            <button type="button" className="button button-small" onClick={reloadFromServer}>
              重新加载服务器版本
            </button>
          ) : null}
        </Notice>
      ) : null}

      <FormErrors errors={errors} />

      <Card title="基本信息" description="名称必填；标签用于筛选，可为空。">
        <div className="form-grid">
          <TextField
            id="case-name"
            label="用例名称"
            value={form.name}
            onChange={(value) => setField('name', value)}
            required
            maxLength={200}
            placeholder="例如：首页展示与问候文案"
            error={errorAt('name')}
            disabled={saving}
          />
          <TextField
            id="case-description"
            label="描述（可选）"
            value={form.description}
            onChange={(value) => setField('description', value)}
            maxLength={2000}
            hint="0~2000 字符，便于团队理解用例意图"
            error={errorAt('description')}
            disabled={saving}
          />
          <SelectField
            id="case-mode"
            label="编辑模式"
            value={form.mode}
            options={[
              { value: 'steps', label: CASE_MODE_LABELS.steps },
              { value: 'code', label: CASE_MODE_LABELS.code },
            ]}
            onChange={(value) => setField('mode', value === 'code' ? 'code' : 'steps')}
            hint="结构化步骤面向普通用户；原始代码面向需要更强表达力的测试开发"
            disabled={saving}
          />
          <SelectField
            id="case-status"
            label="用例状态"
            value={form.status}
            options={[
              { value: 'active', label: '启用（active）' },
              { value: 'archived', label: '归档（archived）' },
            ]}
            onChange={(value) => setField('status', value === 'archived' ? 'archived' : 'active')}
            hint="归档用例仍可被历史运行引用，但列表中默认仍可见"
            disabled={saving}
          />
          <TextField
            id="case-tags"
            label="标签（可选）"
            value={form.tagsText}
            onChange={(value) => setField('tagsText', value)}
            placeholder="@fast, 首页"
            hint="逗号分隔，最多 20 个，每个 1~30 字符"
            error={errorAt('tags')}
            disabled={saving}
          />
          <div className="field">
            <span className="field-label">标签预览</span>
            <TagList tags={tagsPreview} />
          </div>
        </div>
      </Card>

      <Card
        title={form.mode === 'steps' ? '结构化步骤' : '原始 Playwright Test 代码'}
        description={
          form.mode === 'steps'
            ? '每个步骤编译为官方 test.step + 官方 Playwright API；支持上移/下移/删除与逐步骤校验。'
            : '代码将作为官方 @playwright/test 规格在受控工作目录中执行。'
        }
        actions={
          form.mode === 'steps' ? (
            <span className="muted">共 {form.steps.length} 步（上限 200）</span>
          ) : (
            <span className="muted">{form.code.length} / 200000 字符</span>
          )
        }
      >
        {form.mode === 'steps' ? (
          <StepEditor
            steps={form.steps}
            errors={errors}
            disabled={saving}
            onChange={(steps) => setField('steps', steps)}
          />
        ) : (
          <div className="code-mode">
            <Notice tone="warning" title="原始代码模式的说明与风险">
              <ul className="tight-list">
                <li>代码会作为官方 <code>@playwright/test</code> 规格直接执行；只应使用官方文档中的 API。</li>
                <li>框架不做 AST 审计（PRD H5），请勿写入密钥、token、cookie 等敏感内容。</li>
                <li>建议优先使用结构化步骤；确需复杂逻辑（循环、多页面）时再切换到代码模式。</li>
                <li>代码中的断言、trace、截图均由官方 runner 产生，框架只回收官方 JSON 报告与产物。</li>
              </ul>
            </Notice>
            <TextField
              id="case-code"
              label="Playwright Test 代码"
              value={form.code}
              onChange={(value) => setField('code', value)}
              multiline
              rows={20}
              monospace
              maxLength={200000}
              hint="1~200000 字符；保存后可用「编译校验」检查是否能编译"
              error={errorAt('code')}
              disabled={saving}
            />
          </div>
        )}
      </Card>

      <Card title="编译校验（保存后）" description="调用 POST /api/v1/cases/{id}/validate：不执行，只检查步骤编译与数据集列引用。">
        <div className="validate-row">
          <SelectField
            id="case-validate-dataset"
            label="校验时使用的数据集（可选）"
            value={validateDatasetId}
            options={(datasetsResource.data?.items ?? []).map((dataset) => ({
              value: dataset.id,
              label: `${dataset.name}（${String(dataset.rowsCount)} 行）`,
            }))}
            onChange={setValidateDatasetId}
            emptyLabel="不绑定数据集（仅校验步骤）"
            hint="绑定数据集后会校验 {{列名}} 引用是否存在"
            disabled={validating || caseId === null}
          />
          <button type="button" className="button" onClick={() => void handleValidate()} disabled={validating || caseId === null}>
            {validating ? '校验中…' : '开始校验'}
          </button>
        </div>
        {caseId === null ? <p className="muted">首次保存后才能做编译校验。</p> : null}
        {validateError ? <ErrorState error={validateError} title="编译校验失败" /> : null}
        {validateResult ? (
          <Notice tone={validateResult.ok ? 'success' : 'danger'} title={validateResult.ok ? '校验通过' : '校验未通过'}>
            <p>
              步骤数：{validateResult.stepsCount} · 数据行数：{validateResult.rowsCount}
            </p>
            {validateResult.compiledSpecPath ? (
              <p className="mono break-all">编译产物：{validateResult.compiledSpecPath}</p>
            ) : null}
            {validateResult.warnings.length > 0 ? (
              <ul className="tight-list">
                {validateResult.warnings.map((warning) => (
                  <li key={`${warning.code}:${warning.stepId ?? ''}:${warning.message}`}>
                    [{warning.code}] {stripAnsi(warning.message)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">没有警告。</p>
            )}
          </Notice>
        ) : null}
      </Card>

      {form.mode === 'steps' ? (
        <details className="advanced">
          <summary>查看将提交的结构化步骤（合同 Step JSON）</summary>
          <CodeText>{JSON.stringify(normalizeSteps(form.steps), null, 2)}</CodeText>
        </details>
      ) : null}

      <Card title="版本信息" description="PATCH 使用 If-Match: &quot;&lt;version&gt;&quot; 做乐观锁；版本冲突时需重新加载。">
        <KeyValueList
          items={[
            { label: '用例 ID', value: <span className="mono break-all">{caseId ?? '未保存（保存后生成 case_…）'}</span> },
            { label: '当前版本', value: version === null ? '未保存' : String(version) },
            { label: '最后更新', value: formatDateTime(updatedAt) },
            { label: '状态', value: form.status === 'active' ? '启用' : '归档' },
            {
              label: '固定链接',
              value: caseId ? <a href={hrefForCase(caseId)}>用例编辑页</a> : <span className="muted">保存后生成</span>,
            },
          ]}
        />
      </Card>

      <div className="page-actions bottom-actions">
        <button type="button" className="button button-primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" className="button" onClick={handleSaveDraft} disabled={saving}>
          保存草稿
        </button>
        <button type="button" className="button" onClick={() => setRunOpen(true)} disabled={caseId === null || version === null}>
          运行
        </button>
      </div>

      {runOpen && caseId ? (
        <RunDialog
          target={{ kind: 'case', caseId, caseName: form.name, datasetId: validateDatasetId !== '' ? validateDatasetId : undefined }}
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