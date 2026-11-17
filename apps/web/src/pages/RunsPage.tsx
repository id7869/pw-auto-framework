/**
 * 运行记录：历史列表（按状态/用例/套件过滤）、新建运行、取消、进入详情。
 * 接口：GET /api/v1/runs、POST /api/v1/runs/{id}/cancel（api-contract §5.4）。
 */
import { useState } from 'react';
import { useApi } from '../api/context.tsx';
import type { ApiErrorInfo } from '../api/http.ts';
import type { CaseListItem, Run, RunStatus, Suite } from '../api/types.ts';
import { useApiResource } from '../hooks/use-api-resource.ts';
import { usePagedList } from '../hooks/use-paged-list.ts';
import { navigate, useRoute } from '../hooks/use-route.ts';
import { formatDateTime, runDurationMs, shortId } from '../lib/format.ts';
import { RUN_STATUS_LABELS } from '../lib/labels.ts';
import { hrefForRun } from '../lib/hash-router.ts';
import { RunDialog } from '../components/RunDialog.tsx';
import {
  ConfirmButton,
  EmptyState,
  ErrorState,
  LoadMore,
  LoadingState,
  Notice,
  PageHeader,
  StatusPill,
  TableWrap,
} from '../components/ui.tsx';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部状态' },
  ...(Object.entries(RUN_STATUS_LABELS) as [RunStatus, string][]).map(([value, label]) => ({ value, label })),
];

export function RunsPage() {
  const api = useApi();
  const route = useRoute();
  const initialStatus = route.name === 'runs' ? (route.query['status'] ?? '') : '';

  const [status, setStatus] = useState(initialStatus);
  const [caseId, setCaseId] = useState('');
  const [suiteId, setSuiteId] = useState('');
  const [applied, setApplied] = useState({ status: initialStatus, caseId: '', suiteId: '' });
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState<ApiErrorInfo | null>(null);
  const [runOpen, setRunOpen] = useState(false);

  const runs = usePagedList<Run>(
    (cursor) =>
      api.listRuns({
        limit: 20,
        cursor: cursor ?? undefined,
        status: applied.status !== '' ? (applied.status as RunStatus) : undefined,
        caseId: applied.caseId !== '' ? applied.caseId : undefined,
        suiteId: applied.suiteId !== '' ? applied.suiteId : undefined,
        order: 'desc',
      }),
    [applied.status, applied.caseId, applied.suiteId],
  );

  const cases = useApiResource(() => api.listCases({ limit: 100 }), []);
  const suites = useApiResource(() => api.listSuites({ limit: 100 }), []);
  const caseItems: CaseListItem[] = cases.data?.items ?? [];
  const suiteItems: Suite[] = suites.data?.items ?? [];

  const caseName = (id: string | null): string => (id ? (caseItems.find((item) => item.id === id)?.name ?? id) : '—');
  const suiteName = (id: string | null): string => (id ? (suiteItems.find((item) => item.id === id)?.name ?? id) : '—');

  const cancelRun = async (run: Run): Promise<void> => {
    setNotice('');
    setActionError(null);
    const result = await api.cancelRun(run.id);
    if (result.ok) {
      setNotice(
        result.data.status === 'cancelled'
          ? `运行 ${shortId(run.id)} 已取消（已产出的结果与产物保留）`
          : `已请求取消运行 ${shortId(run.id)}，等待引擎收尾；状态：${RUN_STATUS_LABELS[result.data.status] ?? result.data.status}`,
      );
      runs.reload();
    } else {
      setActionError(result.error);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="运行记录"
        description="每次运行都对应一次官方 Playwright Test 执行；状态机为 queued → running → 终态，逐项结果来自官方 JSON 报告。"
        actions={
          <>
            <button type="button" className="button button-primary" onClick={() => setRunOpen(true)}>
              新建运行
            </button>
            <button type="button" className="button" onClick={runs.reload} disabled={runs.loading}>
              刷新
            </button>
          </>
        }
      />

      {notice !== '' ? (
        <Notice tone="success" title="操作成功">
          {notice}
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title={`操作失败（${actionError.code}）`}>
          {actionError.message}
        </Notice>
      ) : null}

      <section className="card" aria-labelledby="run-filter-title">
        <h2 id="run-filter-title">筛选</h2>
        <form
          className="filter-form"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied({ status, caseId, suiteId });
          }}
        >
          <div className="field">
            <label htmlFor="run-status" className="field-label">
              状态
            </label>
            <select id="run-status" className="input" value={status} onChange={(event) => setStatus(event.target.value)}>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="run-case-filter" className="field-label">
              用例
            </label>
            <select id="run-case-filter" className="input" value={caseId} onChange={(event) => setCaseId(event.target.value)}>
              <option value="">全部用例</option>
              {caseItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="run-suite-filter" className="field-label">
              套件
            </label>
            <select id="run-suite-filter" className="input" value={suiteId} onChange={(event) => setSuiteId(event.target.value)}>
              <option value="">全部套件</option>
              {suiteItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-actions">
            <button type="submit" className="button button-primary">
              查询
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setStatus('');
                setCaseId('');
                setSuiteId('');
                setApplied({ status: '', caseId: '', suiteId: '' });
              }}
            >
              重置
            </button>
          </div>
        </form>
      </section>

      <section className="card" aria-labelledby="run-list-title">
        <div className="card-head">
          <div>
            <h2 id="run-list-title">运行历史</h2>
            <p className="muted">已加载 {runs.items.length} 条；运行、结果项与产物写入后不可变，重跑会创建新运行。</p>
          </div>
        </div>

        {runs.loading && runs.items.length === 0 ? <LoadingState label="正在加载运行记录…" /> : null}
        {runs.error && runs.items.length === 0 ? (
          <ErrorState error={runs.error} title="运行记录加载失败" onRetry={runs.reload} />
        ) : runs.items.length === 0 && !runs.loading ? (
          <EmptyState
            title="还没有运行记录"
            description="选择一个用例或套件创建运行；运行状态、逐项结果与 trace 会沉淀在这里。"
            action={
              <button type="button" className="button button-primary" onClick={() => setRunOpen(true)}>
                新建运行
              </button>
            }
          />
        ) : (
          <>
            {runs.error ? (
              <Notice tone="warning" title="刷新失败，展示的是上次加载的数据">
                {runs.error.message}
              </Notice>
            ) : null}
            <TableWrap label="运行记录列表">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">运行</th>
                    <th scope="col">对象</th>
                    <th scope="col">状态</th>
                    <th scope="col">结果统计</th>
                    <th scope="col">耗时</th>
                    <th scope="col">请求时间</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.items.map((run) => {
                    const cancellable = run.status === 'queued' || run.status === 'running';
                    return (
                      <tr key={run.id}>
                        <td>
                          <a href={hrefForRun(run.id)} className="strong-link mono">
                            {shortId(run.id, 14)}
                          </a>
                          <div className="muted cell-sub">{run.kind === 'case' ? '用例运行' : '套件运行'}</div>
                        </td>
                        <td className="wrap">
                          {run.kind === 'case' ? caseName(run.caseId) : suiteName(run.suiteId)}
                          {run.datasetId ? <div className="muted mono break-all cell-sub">数据集 {run.datasetId}</div> : null}
                        </td>
                        <td>
                          <StatusPill status={run.status} />
                          {run.queuePosition !== null ? <div className="muted">排队位次 {run.queuePosition}</div> : null}
                          {run.cancelRequestedAt && cancellable ? <div className="field-warning">已请求取消</div> : null}
                        </td>
                        <td>
                          通过 {run.stats?.expected ?? 0} · 失败 {run.stats?.unexpected ?? 0} · flaky {run.stats?.flaky ?? 0} · 跳过{' '}
                          {run.stats?.skipped ?? 0}
                        </td>
                        <td>{runDurationMs(run) > 0 ? `${String(Math.round(runDurationMs(run) / 1000))} 秒` : '—'}</td>
                        <td>{formatDateTime(run.requestedAt)}</td>
                        <td>
                          <div className="row-actions">
                            <a className="button button-small" href={hrefForRun(run.id)}>
                              详情
                            </a>
                            {cancellable && !run.cancelRequestedAt ? (
                              <ConfirmButton
                                label="取消"
                                question={`取消运行 ${shortId(run.id)}？已产出的结果会保留。`}
                                confirmLabel="确认取消"
                                onConfirm={() => cancelRun(run)}
                              />
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <LoadMore hasMore={runs.hasMore} loading={runs.loadingMore} loadedCount={runs.items.length} onLoadMore={runs.loadMore} />
          </>
        )}
      </section>

      <Notice tone="info" title="关于实时状态">
        运行详情页会按 api-contract §0.4 轮询（1s→2s→5s→10s，终态停止）；若后端启用 SSE，则同时用事件触发即时刷新。列表页不自动轮询，请点「刷新」。
      </Notice>

      {runOpen ? (
        <RunDialog
          target={{ kind: 'choose' }}
          onClose={() => setRunOpen(false)}
          onStarted={(run) => {
            setRunOpen(false);
            setNotice('');
            navigate(`/runs/${encodeURIComponent(run.id)}`);
          }}
        />
      ) : null}
    </div>
  );
}