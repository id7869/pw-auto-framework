/**
 * 套件管理：用例的有序集合，支持创建/编辑顺序与批量运行。
 * 接口：/api/v1/suites（api-contract §4）。套件运行不支持数据集（合同限制，UI 明示）。
 */
import { useEffect, useState } from 'react';
import { useApi } from '../api/context.tsx';
import type { ApiErrorInfo } from '../api/http.ts';
import type { CaseListItem, Suite } from '../api/types.ts';
import { useApiResource } from '../hooks/use-api-resource.ts';
import { usePagedList } from '../hooks/use-paged-list.ts';
import { navigate, useRoute } from '../hooks/use-route.ts';
import { CASE_MODE_LABELS } from '../lib/labels.ts';
import { formatDateTime } from '../lib/format.ts';
import { buildHref } from '../lib/hash-router.ts';
import type { FieldError } from '../lib/validation.ts';
import { firstError, validateSuiteForm } from '../lib/validation.ts';
import { RunDialog } from '../components/RunDialog.tsx';
import {
  Card,
  ConfirmButton,
  EmptyState,
  ErrorState,
  FormErrors,
  LoadMore,
  LoadingState,
  Notice,
  PageHeader,
  TableWrap,
  TextField,
} from '../components/ui.tsx';

interface SuiteEditor {
  mode: 'create' | 'edit';
  suiteId: string | null;
  name: string;
  description: string;
  caseIds: string[];
}

export function SuitesPage() {
  const api = useApi();
  const route = useRoute();
  const [q, setQ] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [editor, setEditor] = useState<SuiteEditor | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [editorError, setEditorError] = useState<ApiErrorInfo | null>(null);
  const [listNotice, setListNotice] = useState('');
  const [listError, setListError] = useState<ApiErrorInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [caseQuery, setCaseQuery] = useState('');
  const [runSuite, setRunSuite] = useState<Suite | null>(null);

  const suites = usePagedList<Suite>(
    (cursor) => api.listSuites({ limit: 20, cursor: cursor ?? undefined, q: appliedQ !== '' ? appliedQ : undefined }),
    [appliedQ],
  );
  const cases = useApiResource(() => api.listCases({ limit: 100 }), []);
  const caseItems: CaseListItem[] = cases.data?.items ?? [];

  const openCreate = (): void => {
    setEditor({ mode: 'create', suiteId: null, name: '', description: '', caseIds: [] });
    setErrors([]);
    setEditorError(null);
    setCaseQuery('');
  };

  const openEdit = (suite: Suite): void => {
    setEditor({
      mode: 'edit',
      suiteId: suite.id,
      name: suite.name,
      description: suite.description,
      caseIds: [...suite.caseIds],
    });
    setErrors([]);
    setEditorError(null);
    setCaseQuery('');
  };

  const suiteIdFromQuery = route.name === 'suites' ? route.query['suiteId'] : undefined;
  useEffect(() => {
    if (!suiteIdFromQuery || editor !== null) return;
    const found = suites.items.find((item) => item.id === suiteIdFromQuery);
    if (found) openEdit(found);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suiteIdFromQuery, suites.items, editor]);

  const closeEditor = (): void => {
    setEditor(null);
    setErrors([]);
    setEditorError(null);
  };

  const toggleCase = (caseId: string, checked: boolean): void => {
    setEditor((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        caseIds: checked ? [...prev.caseIds, caseId] : prev.caseIds.filter((id) => id !== caseId),
      };
    });
  };

  const moveCase = (index: number, direction: -1 | 1): void => {
    setEditor((prev) => {
      if (!prev) return prev;
      const target = index + direction;
      if (target < 0 || target >= prev.caseIds.length) return prev;
      const next = [...prev.caseIds];
      const current = next[index];
      const other = next[target];
      if (current === undefined || other === undefined) return prev;
      next[index] = other;
      next[target] = current;
      return { ...prev, caseIds: next };
    });
  };

  const saveEditor = async (): Promise<void> => {
    if (!editor) return;
    setEditorError(null);
    const clientErrors = validateSuiteForm({
      name: editor.name,
      description: editor.description,
      caseIds: editor.caseIds,
    });
    setErrors(clientErrors);
    if (clientErrors.length > 0) return;

    setSaving(true);
    if (editor.mode === 'create') {
      const result = await api.createSuite({
        name: editor.name.trim(),
        description: editor.description.trim(),
        caseIds: editor.caseIds,
      });
      setSaving(false);
      if (result.ok) {
        setListNotice(`已创建套件「${result.data.name}」（${String(result.data.casesCount)} 个用例）`);
        closeEditor();
        suites.reload();
      } else {
        setEditorError(result.error);
      }
      return;
    }

    const suiteId = editor.suiteId;
    if (!suiteId) {
      setSaving(false);
      setEditorError({ code: 'INTERNAL_ERROR', message: '缺少套件 ID，请重新打开套件' });
      return;
    }
    const patched = await api.patchSuite(suiteId, { name: editor.name.trim(), description: editor.description.trim() });
    if (!patched.ok) {
      setSaving(false);
      setEditorError(patched.error);
      return;
    }
    const replaced = await api.replaceSuiteCases(suiteId, editor.caseIds);
    setSaving(false);
    if (replaced.ok) {
      setListNotice(`已保存套件「${replaced.data.name}」的用例顺序（${String(replaced.data.casesCount)} 个用例）`);
      closeEditor();
      suites.reload();
    } else {
      setEditorError(replaced.error);
    }
  };

  const deleteSuite = async (suite: Suite): Promise<void> => {
    setListNotice('');
    setListError(null);
    const result = await api.deleteSuite(suite.id);
    if (result.ok) {
      setListNotice(`已删除套件「${suite.name}」（软删除）`);
      if (editor?.suiteId === suite.id) closeEditor();
      suites.reload();
    } else {
      setListError(result.error);
    }
  };

  const caseName = (caseId: string): string => caseItems.find((item) => item.id === caseId)?.name ?? caseId;
  const filteredCases = caseItems.filter((item) => caseQuery === '' || item.name.includes(caseQuery));

  return (
    <div className="page">
      <PageHeader
        title="套件"
        description="把多个用例按顺序组成套件，一次运行完成批量回归；套件运行不支持数据集（数据集绑定在用例上）。"
        actions={
          <>
            <button type="button" className="button button-primary" onClick={openCreate}>
              新建套件
            </button>
            <button type="button" className="button" onClick={suites.reload} disabled={suites.loading}>
              刷新
            </button>
          </>
        }
      />

      {listNotice !== '' ? (
        <Notice tone="success" title="操作成功">
          {listNotice}
        </Notice>
      ) : null}
      {listError ? (
        <Notice tone="danger" title={`操作失败（${listError.code}）`}>
          {listError.message}
        </Notice>
      ) : null}

      <Card
        title="套件列表"
        actions={
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              setAppliedQ(q.trim());
            }}
          >
            <label className="sr-only" htmlFor="suite-q">
              搜索套件
            </label>
            <input id="suite-q" className="input" value={q} maxLength={100} placeholder="按名称搜索" onChange={(event) => setQ(event.target.value)} />
            <button type="submit" className="button">
              查询
            </button>
          </form>
        }
      >
        {suites.loading && suites.items.length === 0 ? (
          <LoadingState label="正在加载套件…" />
        ) : suites.error && suites.items.length === 0 ? (
          <ErrorState error={suites.error} title="套件加载失败" onRetry={suites.reload} />
        ) : suites.items.length === 0 ? (
          <EmptyState
            title="还没有套件"
            description="创建套件并选择至少一个用例，即可批量运行。"
            action={
              <button type="button" className="button button-primary" onClick={openCreate}>
                新建套件
              </button>
            }
          />
        ) : (
          <>
            <TableWrap label="套件列表">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">名称</th>
                    <th scope="col">用例数</th>
                    <th scope="col">用例顺序</th>
                    <th scope="col">更新时间</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {suites.items.map((suite) => (
                    <tr key={suite.id}>
                      <td>
                        <span className="strong">{suite.name}</span>
                        <div className="muted cell-sub">{suite.description || '无描述'}</div>
                        <div className="muted mono break-all cell-sub">{suite.id}</div>
                      </td>
                      <td>{suite.casesCount}</td>
                      <td className="wrap">{suite.caseIds.map(caseName).join(' → ') || '—'}</td>
                      <td>{formatDateTime(suite.updatedAt)}</td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="button button-small" onClick={() => openEdit(suite)}>
                            编辑
                          </button>
                          <button type="button" className="button button-small button-primary" onClick={() => setRunSuite(suite)}>
                            批量运行
                          </button>
                          <ConfirmButton
                            label="删除"
                            question={`删除套件「${suite.name}」？（软删除）`}
                            confirmLabel="确认删除"
                            onConfirm={() => deleteSuite(suite)}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <LoadMore
              hasMore={suites.hasMore}
              loading={suites.loadingMore}
              loadedCount={suites.items.length}
              onLoadMore={suites.loadMore}
            />
          </>
        )}
      </Card>

      {editor ? (
        <Card
          title={editor.mode === 'create' ? '新建套件' : `编辑套件 · ${editor.name}`}
          description="用例按下方顺序执行；套件运行不支持数据集，每个用例使用默认数据集或单次执行。"
          actions={
            <button type="button" className="button" onClick={closeEditor} disabled={saving}>
              关闭
            </button>
          }
        >
          {editorError ? (
            <Notice tone="danger" title={`操作失败（${editorError.code}）`}>
              {editorError.message}
            </Notice>
          ) : null}
          <FormErrors errors={errors} />
          <div className="form-grid">
            <TextField
              id="suite-name"
              label="套件名称"
              value={editor.name}
              onChange={(value) => setEditor((prev) => (prev ? { ...prev, name: value } : prev))}
              required
              maxLength={200}
              error={firstError(errors.filter((error) => error.path === 'name'))?.message}
              disabled={saving}
            />
            <TextField
              id="suite-description"
              label="描述（可选）"
              value={editor.description}
              onChange={(value) => setEditor((prev) => (prev ? { ...prev, description: value } : prev))}
              maxLength={2000}
              disabled={saving}
            />
          </div>

          <div className="suite-picker">
            <div className="suite-picker-col">
              <h3>可选用例</h3>
              <TextField
                id="suite-case-search"
                label="筛选用例"
                value={caseQuery}
                onChange={setCaseQuery}
                placeholder="按名称筛选"
                disabled={saving}
              />
              {cases.loading ? (
                <LoadingState label="正在加载用例…" />
              ) : cases.error ? (
                <ErrorState error={cases.error} title="用例加载失败" onRetry={cases.reload} />
              ) : caseItems.length === 0 ? (
                <EmptyState
                  title="还没有用例"
                  description="请先创建测试用例。"
                  action={
                    <a className="button" href={buildHref('/cases/new')}>
                      新建用例
                    </a>
                  }
                />
              ) : (
                <ul className="check-list">
                  {filteredCases.map((item) => {
                    const checked = editor.caseIds.includes(item.id);
                    return (
                      <li key={item.id}>
                        <label className="checkbox" htmlFor={`suite-case-${item.id}`}>
                          <input
                            id={`suite-case-${item.id}`}
                            type="checkbox"
                            checked={checked}
                            disabled={saving || (!checked && editor.caseIds.length >= 100)}
                            onChange={(event) => toggleCase(item.id, event.target.checked)}
                          />
                          <span>
                            {item.name}
                            <span className="muted"> · {CASE_MODE_LABELS[item.mode] ?? item.mode}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="suite-picker-col">
              <h3>已选用例（按执行顺序）</h3>
              {editor.caseIds.length === 0 ? (
                <p className="muted">从左侧勾选用例；至少选择 1 个。</p>
              ) : (
                <ol className="ordered-list">
                  {editor.caseIds.map((caseId, index) => (
                    <li key={caseId}>
                      <span className="order-index">{index + 1}</span>
                      <span className="order-name">{caseName(caseId)}</span>
                      <span className="row-actions">
                        <button
                          type="button"
                          className="button button-small"
                          disabled={saving || index === 0}
                          aria-label={`上移 ${caseName(caseId)}`}
                          onClick={() => moveCase(index, -1)}
                        >
                          上移
                        </button>
                        <button
                          type="button"
                          className="button button-small"
                          disabled={saving || index === editor.caseIds.length - 1}
                          aria-label={`下移 ${caseName(caseId)}`}
                          onClick={() => moveCase(index, 1)}
                        >
                          下移
                        </button>
                        <button
                          type="button"
                          className="button button-small button-danger"
                          disabled={saving}
                          aria-label={`移除 ${caseName(caseId)}`}
                          onClick={() => toggleCase(caseId, false)}
                        >
                          移除
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>

          <div className="page-actions">
            <button type="button" className="button button-primary" onClick={() => void saveEditor()} disabled={saving}>
              {saving ? '保存中…' : editor.mode === 'create' ? '创建套件' : '保存套件'}
            </button>
            <button type="button" className="button" onClick={closeEditor} disabled={saving}>
              取消
            </button>
          </div>
        </Card>
      ) : null}

      {runSuite ? (
        <RunDialog
          target={{ kind: 'suite', suiteId: runSuite.id, suiteName: runSuite.name }}
          onClose={() => setRunSuite(null)}
          onStarted={(run) => {
            setRunSuite(null);
            navigate(`/runs/${encodeURIComponent(run.id)}`);
          }}
        />
      ) : null}
    </div>
  );
}