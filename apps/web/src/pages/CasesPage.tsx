/**
 * 测试用例列表：搜索/筛选、分页加载、新建入口、编辑、运行、删除。
 * 接口：GET /api/v1/cases、DELETE /api/v1/cases/{id}（api-contract §2）。
 */
import { useState } from 'react';
import { useApi } from '../api/context.tsx';
import type { ApiErrorInfo } from '../api/http.ts';
import type { CaseListItem, CaseStatus } from '../api/types.ts';
import { usePagedList } from '../hooks/use-paged-list.ts';
import { navigate } from '../hooks/use-route.ts';
import { CASE_MODE_LABELS } from '../lib/labels.ts';
import { formatDateTime } from '../lib/format.ts';
import { buildHref, hrefForCase } from '../lib/hash-router.ts';
import {
  ConfirmButton,
  EmptyState,
  ErrorState,
  LoadMore,
  LoadingState,
  Notice,
  PageHeader,
  TableWrap,
  TagList,
} from '../components/ui.tsx';
import { RunDialog } from '../components/RunDialog.tsx';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '启用（active）' },
  { value: 'archived', label: '归档（archived）' },
];

export function CasesPage() {
  const api = useApi();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [applied, setApplied] = useState<{ q: string; status: string; tag: string }>({ q: '', status: '', tag: '' });
  const [actionError, setActionError] = useState<ApiErrorInfo | null>(null);
  const [notice, setNotice] = useState('');
  const [runCase, setRunCase] = useState<{ caseId: string; caseName: string } | null>(null);

  const list = usePagedList<CaseListItem>(
    (cursor) =>
      api.listCases({
        limit: 20,
        cursor: cursor ?? undefined,
        q: applied.q !== '' ? applied.q : undefined,
        status: applied.status !== '' ? (applied.status as CaseStatus) : undefined,
        tag: applied.tag !== '' ? applied.tag : undefined,
      }),
    [applied.q, applied.status, applied.tag],
  );

  const applyFilters = (): void => {
    setApplied({ q: q.trim(), status, tag: tag.trim() });
  };

  const resetFilters = (): void => {
    setQ('');
    setStatus('');
    setTag('');
    setApplied({ q: '', status: '', tag: '' });
  };

  const handleDelete = async (item: CaseListItem): Promise<void> => {
    setActionError(null);
    setNotice('');
    const result = await api.deleteCase(item.id);
    if (result.ok) {
      setNotice(`已删除用例「${item.name}」（软删除，历史运行仍可读）`);
      list.reload();
    } else {
      setActionError(result.error);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="测试用例"
        description="用中文创建结构化步骤，或用官方 Playwright Test 代码；保存后可绑定数据集运行并沉淀运行历史。"
        actions={
          <>
            <a className="button button-primary" href={buildHref('/cases/new')}>
              新建用例
            </a>
            <button type="button" className="button" onClick={list.reload} disabled={list.loading}>
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
          {actionError.requestId ? `（请求 ID：${actionError.requestId}）` : ''}
        </Notice>
      ) : null}

      <section className="card" aria-labelledby="case-filter-title">
        <h2 id="case-filter-title">搜索与筛选</h2>
        <form
          className="filter-form"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
          }}
        >
          <div className="field">
            <label htmlFor="case-q" className="field-label">
              关键字
            </label>
            <input
              id="case-q"
              className="input"
              value={q}
              maxLength={100}
              placeholder="按名称或描述搜索"
              onChange={(event) => setQ(event.target.value)}
            />
            <p className="field-hint">1~100 字符，后端按名称/描述模糊匹配</p>
          </div>
          <div className="field">
            <label htmlFor="case-status" className="field-label">
              状态
            </label>
            <select id="case-status" className="input" value={status} onChange={(event) => setStatus(event.target.value)}>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="case-tag" className="field-label">
              标签
            </label>
            <input
              id="case-tag"
              className="input"
              value={tag}
              maxLength={30}
              placeholder="@fast"
              onChange={(event) => setTag(event.target.value)}
            />
          </div>
          <div className="filter-actions">
            <button type="submit" className="button button-primary">
              查询
            </button>
            <button type="button" className="button" onClick={resetFilters}>
              重置
            </button>
          </div>
        </form>
      </section>

      <section className="card" aria-labelledby="case-list-title">
        <div className="card-head">
          <div>
            <h2 id="case-list-title">用例列表</h2>
            <p className="muted">共加载 {list.items.length} 个用例；删除为软删除，历史运行仍可读。</p>
          </div>
        </div>

        {list.loading && list.items.length === 0 ? <LoadingState label="正在加载用例…" /> : null}

        {list.error && list.items.length === 0 ? (
          <ErrorState error={list.error} title="用例列表加载失败" onRetry={list.reload} />
        ) : (
          <>
            {list.error && list.items.length > 0 ? (
              <Notice tone="warning" title="刷新失败，当前展示的是上次加载的数据">
                {list.error.message}
              </Notice>
            ) : null}

            {list.items.length === 0 && !list.loading ? (
              <EmptyState
                title="还没有测试用例"
                description="新建一个用例，添加「打开页面 → 断言可见 → 断言文本」三个步骤即可跑通第一条测试。"
                action={
                  <a className="button button-primary" href={buildHref('/cases/new')}>
                    新建用例
                  </a>
                }
              />
            ) : (
              <>
                <TableWrap label="测试用例列表">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">名称</th>
                        <th scope="col">模式</th>
                        <th scope="col">步骤数</th>
                        <th scope="col">标签</th>
                        <th scope="col">状态</th>
                        <th scope="col">版本</th>
                        <th scope="col">更新时间</th>
                        <th scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.items.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <a href={hrefForCase(item.id)} className="strong-link">
                              {item.name}
                            </a>
                            {item.description ? <div className="muted cell-sub">{item.description}</div> : null}
                          </td>
                          <td>{CASE_MODE_LABELS[item.mode] ?? item.mode}</td>
                          <td>{item.mode === 'steps' ? (item.stepsCount ?? 0) : '—'}</td>
                          <td>
                            <TagList tags={item.tags ?? []} />
                          </td>
                          <td>
                            <span className={`badge badge-${item.status === 'active' ? 'success' : 'neutral'}`}>
                              {item.status === 'active' ? '启用' : '归档'}
                            </span>
                          </td>
                          <td>{item.version ?? 1}</td>
                          <td>{formatDateTime(item.updatedAt)}</td>
                          <td>
                            <div className="row-actions">
                              <a className="button button-small" href={hrefForCase(item.id)}>
                                编辑
                              </a>
                              <button
                                type="button"
                                className="button button-small button-primary"
                                onClick={() => setRunCase({ caseId: item.id, caseName: item.name })}
                              >
                                运行
                              </button>
                              <ConfirmButton
                                label="删除"
                                question={`删除用例「${item.name}」？（软删除，可保留历史运行）`}
                                confirmLabel="确认删除"
                                onConfirm={() => handleDelete(item)}
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
                <LoadMore
                  hasMore={list.hasMore}
                  loading={list.loadingMore}
                  loadedCount={list.items.length}
                  onLoadMore={list.loadMore}
                />
              </>
            )}
          </>
        )}
      </section>

      {runCase ? (
        <RunDialog
          target={{ kind: 'case', caseId: runCase.caseId, caseName: runCase.caseName }}
          onClose={() => setRunCase(null)}
          onStarted={(run) => {
            setRunCase(null);
            navigate(`/runs/${encodeURIComponent(run.id)}`);
          }}
        />
      ) : null}
    </div>
  );
}