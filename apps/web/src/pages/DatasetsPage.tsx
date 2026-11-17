/**
 * 数据集管理：按用例选择数据集，创建/编辑行、JSON/CSV 导入、行预览、用数据集运行。
 * 接口：/cases/{id}/datasets、/datasets/{id}、/datasets/{id}/rows（api-contract §3）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../api/context.tsx';
import type { ApiErrorInfo } from '../api/http.ts';
import { cellToText, loadAllDatasetRows } from '../api/endpoints.ts';
import type { CaseListItem, Dataset, DatasetRow, DatasetSource, PageResult } from '../api/types.ts';
import { useApiResource } from '../hooks/use-api-resource.ts';
import { usePagedList } from '../hooks/use-paged-list.ts';
import { navigate, useRoute } from '../hooks/use-route.ts';
import { DATASET_SOURCE_LABELS } from '../lib/labels.ts';
import { formatDateTime } from '../lib/format.ts';
import { buildHref, hrefForCase } from '../lib/hash-router.ts';
import { rowsFromCsv, rowsFromJson, rowsToJsonPreview } from '../lib/csv.ts';
import type { DatasetFormValues, DatasetRowDraft, FieldError } from '../lib/validation.ts';
import { toDatasetInput, toFieldErrors, validateDatasetForm } from '../lib/validation.ts';
import { RowsEditor, EnabledSummary } from '../components/RowsEditor.tsx';
import { RunDialog } from '../components/RunDialog.tsx';
import {
  Card,
  CodeText,
  ConfirmButton,
  EmptyState,
  ErrorState,
  FormErrors,
  KeyValueList,
  LoadMore,
  LoadingState,
  Notice,
  PageHeader,
  PlainText,
  SelectField,
  TableWrap,
  TextField,
} from '../components/ui.tsx';

interface EditorState {
  mode: 'create' | 'edit';
  datasetId: string | null;
  name: string;
  /** 编辑模式的服务器名称，用于判断是否需要 PATCH /datasets/{id} */
  originalName: string;
  source: DatasetSource;
  columns: string[];
  rows: DatasetRowDraft[];
  loadingRows: boolean;
}

const EMPTY_DATASET_PAGE: PageResult<Dataset> = { items: [], nextCursor: null, hasMore: false };

function rowsToDrafts(rows: readonly DatasetRow[], columns: readonly string[]): DatasetRowDraft[] {
  return rows.map((row) => {
    const values: Record<string, string> = {};
    for (const column of columns) values[column] = cellToText(row.data[column] ?? '');
    return { enabled: row.enabled, values };
  });
}

export function DatasetsPage() {
  const api = useApi();
  const route = useRoute();
  const [selectedCaseId, setSelectedCaseId] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [editorError, setEditorError] = useState<ApiErrorInfo | null>(null);
  const [editorNotice, setEditorNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [importFormat, setImportFormat] = useState<'json' | 'csv'>('json');
  const [importText, setImportText] = useState('');
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [previewDataset, setPreviewDataset] = useState<Dataset | null>(null);
  const [listNotice, setListNotice] = useState('');
  const [listError, setListError] = useState<ApiErrorInfo | null>(null);
  const [runTarget, setRunTarget] = useState<{ caseId: string; datasetId: string; caseName: string } | null>(null);

  const cases = useApiResource(
    () => api.listCases({ limit: 100, status: 'active' }),
    [],
  );
  const caseItems: CaseListItem[] = cases.data?.items ?? [];

  const datasets = usePagedList<Dataset>(
    (cursor) =>
      selectedCaseId === ''
        ? Promise.resolve({ ok: true as const, data: EMPTY_DATASET_PAGE })
        : api.listDatasets(selectedCaseId, { limit: 20, cursor: cursor ?? undefined }),
    [selectedCaseId],
  );

  const selectedCase = caseItems.find((item) => item.id === selectedCaseId);

  useEffect(() => {
    if (selectedCaseId !== '') return;
    const fromQuery = route.name === 'datasets' ? route.query['caseId'] : undefined;
    if (fromQuery && caseItems.some((item) => item.id === fromQuery)) {
      setSelectedCaseId(fromQuery);
      return;
    }
    const first = caseItems[0];
    if (first) setSelectedCaseId(first.id);
  }, [caseItems, route, selectedCaseId]);

  const openCreate = (): void => {
    setEditor({ mode: 'create', datasetId: null, name: '', originalName: '', source: 'manual', columns: [], rows: [], loadingRows: false });
    setErrors([]);
    setEditorError(null);
    setEditorNotice('');
    setImportText('');
    setImportErrors([]);
    setImportWarnings([]);
  };

  const openEdit = useCallback(
    async (dataset: Dataset): Promise<void> => {
      setEditor({
        mode: 'edit',
        datasetId: dataset.id,
        name: dataset.name,
        originalName: dataset.name,
        source: dataset.source,
        columns: dataset.columns,
        rows: [],
        loadingRows: true,
      });
      setErrors([]);
      setEditorError(null);
      setEditorNotice('');
      setImportText('');
      setImportErrors([]);
      setImportWarnings([]);
      const loaded = await loadAllDatasetRows(api, dataset.id);
      if (!loaded.ok) {
        setEditorError({ code: loaded.error.code, message: loaded.error.message });
        setEditor((prev) => (prev ? { ...prev, loadingRows: false } : prev));
        return;
      }
      const columns =
        dataset.columns.length > 0
          ? dataset.columns
          : [...new Set(loaded.rows.flatMap((row) => Object.keys(row.data)))];
      setEditor((prev) =>
        prev
          ? {
              ...prev,
              columns,
              rows: rowsToDrafts(loaded.rows, columns),
              loadingRows: false,
            }
          : prev,
      );
    },
    [api],
  );

  const initialDatasetId = route.name === 'datasets' ? route.query['datasetId'] : undefined;
  useEffect(() => {
    if (!initialDatasetId || editor !== null) return;
    const found = datasets.items.find((item) => item.id === initialDatasetId);
    if (found) void openEdit(found);
  }, [initialDatasetId, datasets.items, editor, openEdit]);

  const closeEditor = (): void => {
    setEditor(null);
    setErrors([]);
    setEditorError(null);
  };

  const updateEditor = (patch: Partial<EditorState>): void => {
    setEditor((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const applyImport = (): void => {
    const result = importFormat === 'json' ? rowsFromJson(importText) : rowsFromCsv(importText);
    setImportErrors(result.errors);
    setImportWarnings(result.warnings);
    if (result.errors.length === 0) {
      updateEditor({
        columns: result.columns,
        rows: result.rows,
        source: importFormat === 'json' ? 'json' : 'csv',
      });
    }
  };

  const saveEditor = async (): Promise<void> => {
    if (!editor) return;
    setEditorNotice('');
    setEditorError(null);
    const values: DatasetFormValues = {
      name: editor.name,
      source: editor.source,
      columns: editor.columns,
      rows: editor.rows,
    };
    const clientErrors = validateDatasetForm(values);
    setErrors(clientErrors);
    if (clientErrors.length > 0) return;
    setSaving(true);
    const datasetId = editor.datasetId ?? '';
    const trimmedName = editor.name.trim();
    let renamed = false;
    if (editor.mode === 'edit' && datasetId !== '' && trimmedName !== editor.originalName) {
      const renameResult = await api.patchDataset(datasetId, { name: trimmedName });
      if (!renameResult.ok) {
        setSaving(false);
        setEditorError(renameResult.error);
        const renameErrors = toFieldErrors(renameResult.error.details);
        if (renameErrors.length > 0) setErrors(renameErrors);
        return;
      }
      renamed = true;
      setEditor((prev) => (prev ? { ...prev, originalName: trimmedName, name: trimmedName } : prev));
    }

    const input = toDatasetInput(values, editor.source);
    const result =
      editor.mode === 'create'
        ? await api.createDataset(selectedCaseId, input)
        : await api.replaceDatasetRows(datasetId, input.rows);
    setSaving(false);
    if (result.ok) {
      setListNotice(
        editor.mode === 'create'
          ? `已创建数据集「${input.name}」`
          : `已保存「${trimmedName}」的数据行（全量替换，行号已重排${renamed ? '，名称已更新' : ''}）`,
      );
      closeEditor();
      datasets.reload();
    } else {
      setEditorError(result.error);
      if (renamed) setListNotice('数据集名称已更新，但数据行保存失败，请重试数据行保存。');
      const serverErrors = toFieldErrors(result.error.details);
      if (serverErrors.length > 0) setErrors(serverErrors);
    }
  };

  const deleteDataset = async (dataset: Dataset): Promise<void> => {
    setListNotice('');
    setListError(null);
    const result = await api.deleteDataset(dataset.id);
    if (result.ok) {
      setListNotice(`已删除数据集「${dataset.name}」（软删除，历史运行仍可读）`);
      if (previewDataset?.id === dataset.id) setPreviewDataset(null);
      if (editor?.datasetId === dataset.id) closeEditor();
      datasets.reload();
    } else {
      setListError(result.error);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="数据集"
        description="数据集绑定在用例上：每一行数据会编译成一个独立的官方 test（标题带 [row:N]），逐行状态来自官方 JSON 报告。"
        actions={
          <button type="button" className="button" onClick={() => datasets.reload()} disabled={datasets.loading || selectedCaseId === ''}>
            刷新
          </button>
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

      <Card title="选择用例" description="数据集的归属对象；切换用例会重新加载其数据集。">
        {cases.loading ? (
          <LoadingState label="正在加载用例列表…" />
        ) : cases.error ? (
          <ErrorState error={cases.error} title="用例列表加载失败" onRetry={cases.reload} />
        ) : caseItems.length === 0 ? (
          <EmptyState
            title="还没有测试用例"
            description="数据集必须绑定到用例；请先创建一个测试用例。"
            action={
              <a className="button button-primary" href={buildHref('/cases/new')}>
                去新建用例
              </a>
            }
          />
        ) : (
          <div className="inline-form">
            <SelectField
              id="dataset-case"
              label="测试用例"
              value={selectedCaseId}
              options={caseItems.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(value) => {
                setSelectedCaseId(value);
                closeEditor();
                setPreviewDataset(null);
              }}
              emptyLabel="请选择用例"
              required
              hint={selectedCase ? `用例 ID：${selectedCase.id}；数据集按该用例隔离` : undefined}
            />
            {selectedCase ? (
              <a className="button button-small" href={hrefForCase(selectedCase.id)}>
                打开用例编辑器
              </a>
            ) : null}
          </div>
        )}
      </Card>

      <Card
        title="数据集列表"
        description="创建后可逐行编辑；PUT 全量替换会重排行号，历史运行使用其已固化的快照。"
        actions={
          <button type="button" className="button button-primary" onClick={openCreate} disabled={selectedCaseId === ''}>
            新建数据集
          </button>
        }
      >
        {selectedCaseId === '' ? (
          <EmptyState title="请先选择用例" description="数据集按用例管理。" />
        ) : datasets.loading && datasets.items.length === 0 ? (
          <LoadingState label="正在加载数据集…" />
        ) : datasets.error && datasets.items.length === 0 ? (
          <ErrorState error={datasets.error} title="数据集加载失败" onRetry={datasets.reload} />
        ) : datasets.items.length === 0 ? (
          <EmptyState
            title="该用例还没有数据集"
            description="可以手工录入列与行，也可以粘贴 JSON 数组或 CSV 快速导入。"
            action={
              <button type="button" className="button button-primary" onClick={openCreate}>
                新建数据集
              </button>
            }
          />
        ) : (
          <>
            <TableWrap label="数据集列表">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">名称</th>
                    <th scope="col">来源</th>
                    <th scope="col">列</th>
                    <th scope="col">行数 / 启用</th>
                    <th scope="col">更新时间</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {datasets.items.map((dataset) => (
                    <tr key={dataset.id}>
                      <td>
                        <span className="strong">{dataset.name}</span>
                        <div className="muted mono break-all cell-sub">{dataset.id}</div>
                      </td>
                      <td>{DATASET_SOURCE_LABELS[dataset.source] ?? dataset.source}</td>
                      <td className="mono break-all">{dataset.columns.join('、') || '—'}</td>
                      <td>
                        {dataset.rowsCount} / {dataset.enabledRowsCount}
                        {dataset.enabledRowsCount === 0 ? <div className="field-warning">全部行已禁用</div> : null}
                      </td>
                      <td>{formatDateTime(dataset.updatedAt)}</td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="button button-small" onClick={() => void openEdit(dataset)}>
                            编辑行
                          </button>
                          <button
                            type="button"
                            className="button button-small"
                            aria-expanded={previewDataset?.id === dataset.id}
                            onClick={() => setPreviewDataset(previewDataset?.id === dataset.id ? null : dataset)}
                          >
                            {previewDataset?.id === dataset.id ? '收起预览' : '行预览'}
                          </button>
                          <button
                            type="button"
                            className="button button-small button-primary"
                            disabled={!selectedCaseId}
                            onClick={() =>
                              setRunTarget({
                                caseId: selectedCaseId,
                                datasetId: dataset.id,
                                caseName: selectedCase?.name ?? selectedCaseId,
                              })
                            }
                          >
                            用此数据集运行
                          </button>
                          <ConfirmButton
                            label="删除"
                            question={`删除数据集「${dataset.name}」？（软删除）`}
                            confirmLabel="确认删除"
                            onConfirm={() => deleteDataset(dataset)}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <LoadMore
              hasMore={datasets.hasMore}
              loading={datasets.loadingMore}
              loadedCount={datasets.items.length}
              onLoadMore={datasets.loadMore}
            />
          </>
        )}
      </Card>

      {previewDataset ? <DatasetPreview dataset={previewDataset} onClose={() => setPreviewDataset(null)} /> : null}

      {editor ? (
        <Card
          title={editor.mode === 'create' ? '新建数据集' : `编辑数据集 · ${editor.name}`}
          description="列名会作为 {{列名}} 变量名；单元格按文本提交。保存时由后端校验列/行边界。"
          actions={
            <button type="button" className="button" onClick={closeEditor} disabled={saving}>
              关闭
            </button>
          }
        >
          {editorNotice !== '' ? <Notice tone="success" title="提示">{editorNotice}</Notice> : null}
          {editorError ? (
            <Notice tone="danger" title={`操作失败（${editorError.code}）`}>
              {editorError.message}
              {editorError.details && editorError.details.length > 0 ? (
                <ul className="tight-list">
                  {editorError.details.map((detail) => (
                    <li key={`${detail.path}:${detail.message}`}>
                      <code>{detail.path}</code>：<PlainText text={detail.message} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </Notice>
          ) : null}
          <FormErrors errors={errors} />

          <div className="form-grid">
            <TextField
              id="dataset-name"
              label="数据集名称"
              value={editor.name}
              onChange={(value) => updateEditor({ name: value })}
              required
              maxLength={200}
              placeholder="例如：首页问候-3 组数据"
              hint={editor.mode === 'edit' ? '修改名称会通过 PATCH /datasets/{id} 保存' : undefined}
              error={errors.find((error) => error.path === 'name')?.message}
              disabled={saving}
            />
            <SelectField
              id="dataset-source"
              label="来源（仅用于展示与记录）"
              value={editor.source}
              options={[
                { value: 'manual', label: DATASET_SOURCE_LABELS.manual },
                { value: 'json', label: DATASET_SOURCE_LABELS.json },
                { value: 'csv', label: DATASET_SOURCE_LABELS.csv },
              ]}
              onChange={(value) => updateEditor({ source: value as DatasetSource })}
              hint={
                editor.mode === 'edit'
                  ? '来源在创建后不可修改（PATCH 仅支持名称）；如需变更来源请新建数据集'
                  : '导入 JSON/CSV 会自动切换来源；行数据始终可手工修改'
              }
              disabled={saving || editor.mode === 'edit'}
            />
          </div>

          <details className="import-panel" open={editor.columns.length === 0}>
            <summary>从 JSON / CSV 导入行</summary>
            <div className="inline-form">
              <SelectField
                id="dataset-import-format"
                label="导入格式"
                value={importFormat}
                options={[
                  { value: 'json', label: 'JSON 数组：[{"名字":"张三"}]' },
                  { value: 'csv', label: 'CSV：首行表头' },
                ]}
                onChange={(value) => setImportFormat(value === 'csv' ? 'csv' : 'json')}
              />
              <button type="button" className="button" onClick={applyImport} disabled={saving || importText.trim() === ''}>
                解析并填入
              </button>
            </div>
            <TextField
              id="dataset-import-text"
              label="粘贴内容"
              value={importText}
              onChange={setImportText}
              multiline
              rows={6}
              monospace
              placeholder={importFormat === 'json' ? '[{"名字":"张三","期望":"你好，张三"}]' : '名字,期望\n张三,"你好，张三"'}
              hint="解析成功后填充到下方表格；导入失败会给出中文错误，不会提交后端"
            />
            {importErrors.length > 0 ? (
              <div className="form-errors" role="alert">
                <p className="form-errors-title">导入内容有问题</p>
                <ul>
                  {importErrors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {importWarnings.length > 0 ? (
              <Notice tone="warning" title="导入提示">
                <ul className="tight-list">
                  {importWarnings.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
          </details>

          {editor.loadingRows ? (
            <LoadingState label="正在加载全部数据行…" />
          ) : (
            <>
              <RowsEditor
                columns={editor.columns}
                rows={editor.rows}
                disabled={saving}
                onChange={(columns, rows) => updateEditor({ columns, rows })}
              />
              <p className="muted">
                行数上限 500、列数上限 50、单元格上限 8192 字符；<EnabledSummary rows={editor.rows} />
              </p>
              <details>
                <summary>查看将提交的 JSON 预览</summary>
                <CodeText>{rowsToJsonPreview(editor.columns, editor.rows)}</CodeText>
              </details>
            </>
          )}

          <div className="page-actions">
            <button type="button" className="button button-primary" onClick={() => void saveEditor()} disabled={saving || editor.loadingRows}>
              {saving ? '保存中…' : editor.mode === 'create' ? '创建数据集' : '保存数据行（全量替换）'}
            </button>
            <button type="button" className="button" onClick={closeEditor} disabled={saving}>
              取消
            </button>
          </div>
        </Card>
      ) : null}

      {runTarget ? (
        <RunDialog
          target={{ kind: 'case', caseId: runTarget.caseId, caseName: runTarget.caseName, datasetId: runTarget.datasetId }}
          onClose={() => setRunTarget(null)}
          onStarted={(run) => {
            setRunTarget(null);
            navigate(`/runs/${encodeURIComponent(run.id)}`);
          }}
        />
      ) : null}
    </div>
  );
}

function DatasetPreview({ dataset, onClose }: { dataset: Dataset; onClose: () => void }) {
  const api = useApi();
  const preview = useApiResource(() => api.listDatasetRows(dataset.id, { limit: 5 }), [dataset.id]);
  return (
    <Card
      title={`行预览 · ${dataset.name}`}
      description="仅展示前 5 行（GET /datasets/{id}/rows?limit=5）；完整数据请在「编辑行」中查看。"
      actions={
        <button type="button" className="button button-small" onClick={onClose}>
          关闭预览
        </button>
      }
    >
      {preview.loading ? (
        <LoadingState label="正在加载行预览…" />
      ) : preview.error ? (
        <ErrorState error={preview.error} title="行预览加载失败" onRetry={preview.reload} />
      ) : (preview.data?.items.length ?? 0) === 0 ? (
        <EmptyState title="没有数据行" description="该数据集目前是空行集合。" />
      ) : (
        <>
          <TableWrap label="数据集行预览">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">行号</th>
                  {dataset.columns.map((column) => (
                    <th scope="col" key={column}>
                      {column}
                    </th>
                  ))}
                  <th scope="col">启用</th>
                </tr>
              </thead>
              <tbody>
                {(preview.data?.items ?? []).map((row) => (
                  <tr key={row.id}>
                    <th scope="row">{row.rowIndex}</th>
                    {dataset.columns.map((column) => (
                      <td className="mono break-all" key={column}>
                        {cellToText(row.data[column] ?? '')}
                      </td>
                    ))}
                    <td>{row.enabled ? '是' : '否'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <KeyValueList
            items={[
              { label: '数据集 ID', value: <span className="mono break-all">{dataset.id}</span> },
              { label: '总行数 / 启用行数', value: `${String(dataset.rowsCount)} / ${String(dataset.enabledRowsCount)}` },
              { label: '列', value: dataset.columns.join('、') || '—' },
            ]}
          />
        </>
      )}
    </Card>
  );
}