/**
 * 回归对比：基线管理（列表/创建/默认/归档）+ 对比创建 + 对比详情（固定 10 类差异）。
 * 接口：/api/v1/baselines、/api/v1/comparisons（api-contract §6）。
 */
import { useEffect, useState } from 'react';
import { useApi } from '../api/context.tsx';
import type { ApiErrorInfo } from '../api/http.ts';
import type { Baseline, BaselineScope, Comparison, ComparisonDetail, ComparisonItem } from '../api/types.ts';
import { usePagedList } from '../hooks/use-paged-list.ts';
import { navigate, useRoute } from '../hooks/use-route.ts';
import { formatDateTime, formatDeltaMs, shortId } from '../lib/format.ts';
import {
  ATTRIBUTION_CONFIDENCE_LABELS,
  ATTRIBUTION_DISCLAIMER,
  BASELINE_CREATOR_LABELS,
  BASELINE_SCOPE_LABELS,
  COMPARISON_CHANGE_LABELS,
  COMPARISON_CHANGE_TONES,
  failureCategoryLabel,
  VERDICT_BASIS_NOTE,
} from '../lib/labels.ts';
import { buildHref } from '../lib/hash-router.ts';
import type { FieldError } from '../lib/validation.ts';
import {
  firstError,
  toFieldErrors,
  validateBaselineForm,
  validateComparisonForm,
} from '../lib/validation.ts';
import {
  Card,
  ChangePill,
  ConfirmButton,
  EmptyState,
  ErrorState,
  FormErrors,
  LoadMore,
  LoadingState,
  Notice,
  OutcomePill,
  PageHeader,
  PlainText,
  SelectField,
  TableWrap,
  TextField,
  VerdictPill,
} from '../components/ui.tsx';

const COMPARISON_SUMMARY_KEYS = [
  'newly_failed',
  'newly_passed',
  'still_failed',
  'still_passed',
  'flaky',
  'became_flaky',
  'skipped',
  'new_item',
  'missing_item',
  'unknown',
] as const;

export function RegressionPage() {
  const route = useRoute();
  const comparisonId = route.name === 'regression' ? route.query['comparisonId'] : undefined;
  if (comparisonId) return <ComparisonDetailView comparisonId={comparisonId} />;
  return <RegressionOverview />;
}

function RegressionOverview() {
  const api = useApi();
  const route = useRoute();
  const initialRunId = route.name === 'regression' ? (route.query['runId'] ?? '') : '';
  const initialBaselineId = route.name === 'regression' ? (route.query['baselineId'] ?? '') : '';

  const [scope, setScope] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [archiveFilter, setArchiveFilter] = useState('');
  const [applied, setApplied] = useState({ scope: '', scopeId: '', archiveFilter: '' });
  const [baselineNotice, setBaselineNotice] = useState('');
  const [baselineError, setBaselineError] = useState<ApiErrorInfo | null>(null);
  const [baselineForm, setBaselineForm] = useState({
    scope: 'case' as BaselineScope,
    scopeId: '',
    runId: initialRunId,
    name: '',
    note: '',
  });
  const [baselineErrors, setBaselineErrors] = useState<FieldError[]>([]);
  const [baselineSaving, setBaselineSaving] = useState(false);

  const [comparisonForm, setComparisonForm] = useState({ baselineId: initialBaselineId, runId: initialRunId });
  const [comparisonErrors, setComparisonErrors] = useState<FieldError[]>([]);
  const [comparisonError, setComparisonError] = useState<ApiErrorInfo | null>(null);
  const [comparisonSaving, setComparisonSaving] = useState(false);

  const baselines = usePagedList<Baseline>(
    (cursor) =>
      api.listBaselines({
        limit: 20,
        cursor: cursor ?? undefined,
        scope: applied.scope !== '' ? (applied.scope as BaselineScope) : undefined,
        scopeId: applied.scopeId !== '' ? applied.scopeId : undefined,
        archived: applied.archiveFilter === '' ? undefined : applied.archiveFilter === 'true',
      }),
    [applied.scope, applied.scopeId, applied.archiveFilter],
  );

  const comparisons = usePagedList<Comparison>(
    (cursor) =>
      api.listComparisons({
        limit: 20,
        cursor: cursor ?? undefined,
        runId: comparisonForm.runId.trim() !== '' ? comparisonForm.runId.trim() : undefined,
        baselineId: comparisonForm.baselineId !== '' ? comparisonForm.baselineId : undefined,
      }),
    [comparisonForm.runId, comparisonForm.baselineId],
  );

  const createBaseline = async (): Promise<void> => {
    setBaselineNotice('');
    setBaselineError(null);
    const clientErrors = validateBaselineForm({
      scope: baselineForm.scope,
      scopeId: baselineForm.scopeId,
      runId: baselineForm.runId,
      name: baselineForm.name,
      note: baselineForm.note,
      createdBy: 'user',
    });
    setBaselineErrors(clientErrors);
    if (clientErrors.length > 0) return;
    setBaselineSaving(true);
    const result = await api.createBaseline({
      scope: baselineForm.scope,
      scopeId: baselineForm.scopeId.trim(),
      runId: baselineForm.runId.trim(),
      name: baselineForm.name.trim(),
      note: baselineForm.note.trim() === '' ? undefined : baselineForm.note.trim(),
      createdBy: 'user',
    });
    setBaselineSaving(false);
    if (result.ok) {
      setBaselineNotice(
        `已创建基线「${result.data.name}」${result.data.isDefault ? '（已自动设为默认）' : ''}`,
      );
      setBaselineForm((prev) => ({ ...prev, name: '', note: '' }));
      baselines.reload();
    } else {
      setBaselineError(result.error);
      setBaselineErrors(toFieldErrors(result.error.details));
    }
  };

  const setDefaultBaseline = async (baseline: Baseline): Promise<void> => {
    setBaselineNotice('');
    setBaselineError(null);
    const result = await api.setDefaultBaseline(baseline.id);
    if (result.ok) {
      setBaselineNotice(`已将「${baseline.name}」设为默认基线`);
      baselines.reload();
    } else {
      setBaselineError(result.error);
    }
  };

  const archiveBaseline = async (baseline: Baseline): Promise<void> => {
    setBaselineNotice('');
    setBaselineError(null);
    const result = await api.archiveBaseline(baseline.id);
    if (result.ok) {
      setBaselineNotice(`已归档基线「${baseline.name}」`);
      baselines.reload();
    } else {
      setBaselineError(result.error);
    }
  };

  const createComparison = async (): Promise<void> => {
    setComparisonError(null);
    const clientErrors = validateComparisonForm(comparisonForm);
    setComparisonErrors(clientErrors);
    if (clientErrors.length > 0) return;
    setComparisonSaving(true);
    const result = await api.createComparison({
      baselineId: comparisonForm.baselineId.trim(),
      runId: comparisonForm.runId.trim(),
    });
    setComparisonSaving(false);
    if (result.ok) {
      navigate('/regression', { comparisonId: result.data.id });
    } else {
      setComparisonError(result.error);
      setComparisonErrors(toFieldErrors(result.error.details));
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="回归对比"
        description="基线只能来自通过（passed）的运行；对比按固定 10 类差异归一化，结论由胶水层计算并在页面标注。"
        actions={
          <>
            <button type="button" className="button" onClick={baselines.reload} disabled={baselines.loading}>
              刷新基线
            </button>
            <button type="button" className="button" onClick={comparisons.reload} disabled={comparisons.loading}>
              刷新对比
            </button>
          </>
        }
      />

      <div className="two-col-cards">
        <Card title="基线" description="同一归属至多一条默认基线；归档不删除其引用运行。">
          <form
            className="filter-form"
            onSubmit={(event) => {
              event.preventDefault();
              setApplied({ scope, scopeId: scopeId.trim(), archiveFilter });
            }}
          >
            <SelectField
              id="baseline-filter-scope"
              label="归属类型"
              value={scope}
              options={[
                { value: 'case', label: '用例' },
                { value: 'suite', label: '套件' },
              ]}
              onChange={setScope}
              emptyLabel="全部"
            />
            <TextField
              id="baseline-filter-scope-id"
              label="归属 ID"
              value={scopeId}
              onChange={setScopeId}
              placeholder="case_… 或 suite_…"
              hint="留空表示不按归属过滤"
            />
            <SelectField
              id="baseline-filter-archived"
              label="归档状态"
              value={archiveFilter}
              options={[
                { value: 'false', label: '未归档（archived=false）' },
                { value: 'true', label: '已归档（archived=true）' },
              ]}
              onChange={setArchiveFilter}
              emptyLabel="不传该过滤条件"
            />
            <div className="filter-actions">
              <button type="submit" className="button button-primary">
                查询
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setScope('');
                  setScopeId('');
                  setArchiveFilter('');
                  setApplied({ scope: '', scopeId: '', archiveFilter: '' });
                }}
              >
                重置
              </button>
            </div>
          </form>

          {baselines.loading && baselines.items.length === 0 ? <LoadingState label="正在加载基线…" /> : null}
          {baselines.error && baselines.items.length === 0 ? (
            <ErrorState error={baselines.error} title="基线加载失败" onRetry={baselines.reload} />
          ) : baselines.items.length === 0 && !baselines.loading ? (
            <EmptyState title="没有匹配的基线" description="在运行详情页把一次通过的运行设为基线，或使用下方表单创建。" />
          ) : (
            <>
              <TableWrap label="基线列表">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">基线</th>
                      <th scope="col">归属</th>
                      <th scope="col">来源运行</th>
                      <th scope="col">默认 / 创建人</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {baselines.items.map((baseline) => (
                      <tr key={baseline.id}>
                        <td>
                          <span className="strong">{baseline.name}</span>
                          {baseline.note ? <div className="muted cell-sub">{baseline.note}</div> : null}
                          {baseline.archivedAt ? <div className="field-warning">已归档（{formatDateTime(baseline.archivedAt)}）</div> : null}
                        </td>
                        <td>
                          {BASELINE_SCOPE_LABELS[baseline.scope] ?? baseline.scope}
                          <div className="muted mono break-all cell-sub">{baseline.scopeId}</div>
                        </td>
                        <td className="mono break-all">
                          <a href={buildHref(`/runs/${encodeURIComponent(baseline.runId)}`)}>{shortId(baseline.runId, 14)}</a>
                        </td>
                        <td>
                          {baseline.isDefault ? <span className="badge badge-info">默认</span> : <span className="muted">—</span>}
                          <div className="muted cell-sub">{BASELINE_CREATOR_LABELS[baseline.createdBy] ?? baseline.createdBy}</div>
                        </td>
                        <td>
                          <div className="row-actions">
                            {!baseline.isDefault && !baseline.archivedAt ? (
                              <button type="button" className="button button-small" onClick={() => void setDefaultBaseline(baseline)}>
                                设为默认
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="button button-small"
                              onClick={() => setComparisonForm((prev) => ({ ...prev, baselineId: baseline.id }))}
                            >
                              用于对比
                            </button>
                            {!baseline.archivedAt ? (
                              <ConfirmButton
                                label="归档"
                                question={`归档基线「${baseline.name}」？`}
                                confirmLabel="确认归档"
                                onConfirm={() => archiveBaseline(baseline)}
                              />
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <LoadMore
                hasMore={baselines.hasMore}
                loading={baselines.loadingMore}
                loadedCount={baselines.items.length}
                onLoadMore={baselines.loadMore}
              />
            </>
          )}
        </Card>

        <Card title="创建对比" description="基线与目标运行必须同归属，且目标运行已到终态（422 RUN_NOT_TERMINAL）。">
          {comparisonError ? (
            <Notice tone="danger" title={`创建对比失败（${comparisonError.code}）`}>
              {comparisonError.message}
            </Notice>
          ) : null}
          <FormErrors errors={comparisonErrors} />
          <div className="form-grid">
            <TextField
              id="comparison-run-id"
              label="目标运行 ID"
              value={comparisonForm.runId}
              onChange={(value) => setComparisonForm((prev) => ({ ...prev, runId: value }))}
              required
              placeholder="run_…"
              hint="可从运行详情页复制；必须是终态运行"
              error={firstError(comparisonErrors.filter((error) => error.path === 'runId'))?.message}
            />
            <TextField
              id="comparison-baseline-id"
              label="基线 ID"
              value={comparisonForm.baselineId}
              onChange={(value) => setComparisonForm((prev) => ({ ...prev, baselineId: value }))}
              required
              placeholder="base_…"
              hint="也可在左侧基线列表点「用于对比」自动填入"
              error={firstError(comparisonErrors.filter((error) => error.path === 'baselineId'))?.message}
            />
          </div>
          <button type="button" className="button button-primary" onClick={() => void createComparison()} disabled={comparisonSaving}>
            {comparisonSaving ? '创建中…' : '创建对比'}
          </button>
          <p className="muted">{VERDICT_BASIS_NOTE}</p>

          <h3>对比记录</h3>
          {comparisons.loading && comparisons.items.length === 0 ? <LoadingState label="正在加载对比记录…" /> : null}
          {comparisons.error && comparisons.items.length === 0 ? (
            <ErrorState error={comparisons.error} title="对比列表加载失败" onRetry={comparisons.reload} />
          ) : comparisons.items.length === 0 && !comparisons.loading ? (
            <EmptyState title="没有对比记录" description="用基线 ID + 目标运行 ID 创建对比，或从运行详情页发起。" />
          ) : (
            <>
              <TableWrap label="对比记录列表">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">对比</th>
                      <th scope="col">结论</th>
                      <th scope="col">新增失败 / 由失败转通过</th>
                      <th scope="col">创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparisons.items.map((comparison) => (
                      <tr key={comparison.id}>
                        <td>
                          <a href={buildHref('/regression', { comparisonId: comparison.id })} className="mono">
                            {shortId(comparison.id, 14)}
                          </a>
                          <div className="muted cell-sub">
                            目标运行 {shortId(comparison.runId, 12)} · 基线运行 {shortId(comparison.baselineRunId, 12)}
                          </div>
                        </td>
                        <td>
                          <VerdictPill verdict={comparison.summary.verdict} />
                        </td>
                        <td>
                          {comparison.summary.newly_failed} / {comparison.summary.newly_passed}
                        </td>
                        <td>{formatDateTime(comparison.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <LoadMore
                hasMore={comparisons.hasMore}
                loading={comparisons.loadingMore}
                loadedCount={comparisons.items.length}
                onLoadMore={comparisons.loadMore}
              />
            </>
          )}
        </Card>
      </div>

      <Card title="手工创建基线" description="仅当运行 status=passed 时后端允许创建（409 BASELINE_SCOPE_MISMATCH 表示未通过）。">
        {baselineNotice !== '' ? (
          <Notice tone="success" title="基线操作成功">
            {baselineNotice}
          </Notice>
        ) : null}
        {baselineError ? (
          <Notice tone="danger" title={`基线操作失败（${baselineError.code}）`}>
            {baselineError.message}
          </Notice>
        ) : null}
        {baselineErrors.length > 0 ? <FormErrors errors={baselineErrors} /> : null}
        <div className="form-grid">
          <SelectField
            id="baseline-form-scope"
            label="归属类型"
            value={baselineForm.scope}
            options={[
              { value: 'case', label: '用例（case）' },
              { value: 'suite', label: '套件（suite）' },
            ]}
            onChange={(value) => setBaselineForm((prev) => ({ ...prev, scope: value === 'suite' ? 'suite' : 'case' }))}
            required
          />
          <TextField
            id="baseline-form-scope-id"
            label="归属对象 ID"
            value={baselineForm.scopeId}
            onChange={(value) => setBaselineForm((prev) => ({ ...prev, scopeId: value }))}
            required
            placeholder="case_… 或 suite_…"
            error={firstError(baselineErrors.filter((error) => error.path === 'scopeId'))?.message}
          />
          <TextField
            id="baseline-form-run-id"
            label="作为基线的运行 ID"
            value={baselineForm.runId}
            onChange={(value) => setBaselineForm((prev) => ({ ...prev, runId: value }))}
            required
            placeholder="run_…"
            hint="该运行必须 status=passed"
            error={firstError(baselineErrors.filter((error) => error.path === 'runId'))?.message}
          />
          <TextField
            id="baseline-form-name"
            label="基线名称"
            value={baselineForm.name}
            onChange={(value) => setBaselineForm((prev) => ({ ...prev, name: value }))}
            required
            maxLength={200}
            placeholder="例如：改版前基线"
            error={firstError(baselineErrors.filter((error) => error.path === 'name'))?.message}
          />
          <TextField
            id="baseline-form-note"
            label="备注（可选）"
            value={baselineForm.note}
            onChange={(value) => setBaselineForm((prev) => ({ ...prev, note: value }))}
            maxLength={2000}
          />
        </div>
        <button type="button" className="button button-primary" onClick={() => void createBaseline()} disabled={baselineSaving}>
          {baselineSaving ? '创建中…' : '创建基线'}
        </button>
      </Card>
    </div>
  );
}

function ComparisonDetailView({ comparisonId }: { comparisonId: string }) {
  const api = useApi();
  const [detail, setDetail] = useState<ComparisonDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiErrorInfo | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void api.getComparison(comparisonId, { itemsLimit: 50 }).then((result) => {
      if (!alive) return;
      setLoading(false);
      if (result.ok) setDetail(result.data);
      else setError(result.error);
    });
    return () => {
      alive = false;
    };
  }, [api, comparisonId]);

  const loadMore = async (): Promise<void> => {
    if (!detail || !detail.hasMore || detail.nextCursor === null) return;
    setLoadingMore(true);
    const result = await api.getComparison(comparisonId, { itemsLimit: 50, itemsCursor: detail.nextCursor });
    setLoadingMore(false);
    if (result.ok) {
      setDetail({
        ...detail,
        items: [...detail.items, ...result.data.items],
        nextCursor: result.data.nextCursor,
        hasMore: result.data.hasMore,
      });
    } else {
      setError(result.error);
    }
  };

  const summary = detail?.comparison.summary;

  return (
    <div className="page">
      <PageHeader
        title={`回归对比 · ${shortId(comparisonId, 16)}`}
        description="逐项差异来自胶水层对官方 JSON 报告的归一化；flaky 与重试以官方 tests[].status 为准。"
        actions={
          <>
            <a className="button" href={buildHref('/regression')}>
              返回对比列表
            </a>
            <button
              type="button"
              className="button"
              onClick={() => {
                setLoading(true);
                setError(null);
                void api.getComparison(comparisonId, { itemsLimit: 50 }).then((result) => {
                  setLoading(false);
                  if (result.ok) setDetail(result.data);
                  else setError(result.error);
                });
              }}
              disabled={loading}
            >
              刷新
            </button>
          </>
        }
      />

      {loading && !detail ? <LoadingState label="正在加载对比…" /> : null}
      {error && !detail ? <ErrorState error={error} title="对比加载失败" /> : null}

      {detail && summary ? (
        <>
          <Card
            title="对比结论"
            description={`归属：${BASELINE_SCOPE_LABELS[detail.comparison.scope]} ${detail.comparison.scopeId} · 创建于 ${formatDateTime(
              detail.comparison.createdAt,
            )}`}
            actions={<VerdictPill verdict={summary.verdict} />}
          >
            <p className="muted">
              {VERDICT_BASIS_NOTE}（接口回显 verdictBasis={summary.verdictBasis}）
            </p>
            <dl className="summary-grid" aria-label="对比差异计数">
              {COMPARISON_SUMMARY_KEYS.map((key) => (
                <div className="summary-cell" key={key}>
                  <dt>{COMPARISON_CHANGE_LABELS[key]}</dt>
                  <dd className={`summary-value summary-${COMPARISON_CHANGE_TONES[key]}`}>{summary[key]}</dd>
                </div>
              ))}
              <div className="summary-cell">
                <dt>差异项总数</dt>
                <dd className="summary-value">{summary.total}</dd>
              </div>
            </dl>
            <p className="muted">
              基线运行：<a href={buildHref(`/runs/${encodeURIComponent(detail.comparison.baselineRunId)}`)}>{detail.comparison.baselineRunId}</a>
              {' · '}目标运行：
              <a href={buildHref(`/runs/${encodeURIComponent(detail.comparison.runId)}`)}>{detail.comparison.runId}</a>
            </p>
          </Card>

          <Card
            title="逐项差异"
            description={`已加载 ${detail.items.length} 项；flaky / became_flaky 表示依赖官方重试的结果，需要人工关注。`}
            actions={
              <span className="muted">
                {detail.hasMore ? '还有更多差异项' : '已全部加载'}
              </span>
            }
          >
            {detail.items.length === 0 ? (
              <EmptyState title="没有差异项" description="两次运行的 itemKey 集合与结果完全一致。" />
            ) : (
              <>
                <TableWrap label="逐项差异表">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">结果项</th>
                        <th scope="col">数据行</th>
                        <th scope="col">差异</th>
                        <th scope="col">基线 → 本次</th>
                        <th scope="col">错误</th>
                        <th scope="col">耗时变化</th>
                        <th scope="col">产物变化</th>
                        <th scope="col">归因（推断）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.items.map((item) => (
                        <ComparisonRow key={item.itemKey} item={item} />
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
                <div className="load-more">
                  <span className="muted">已加载 {detail.items.length} 项</span>
                  {detail.hasMore ? (
                    <button type="button" className="button" onClick={() => void loadMore()} disabled={loadingMore}>
                      {loadingMore ? '加载中…' : '加载更多差异'}
                    </button>
                  ) : (
                    <span className="muted">没有更多了</span>
                  )}
                </div>
              </>
            )}
            {error && detail ? (
              <Notice tone="warning" title="加载更多失败">
                {error.message}
              </Notice>
            ) : null}
            <p className="muted">{ATTRIBUTION_DISCLAIMER}</p>
          </Card>
        </>
      ) : null}
    </div>
  );
}

export function ComparisonRow({ item }: { item: ComparisonItem }) {
  const flaky = item.change === 'flaky' || item.change === 'became_flaky';
  const failureCategory = item.attribution?.failureCategory ?? null;
  const failureLabel = failureCategory === null ? null : failureCategoryLabel(failureCategory);
  return (
    <tr className={flaky ? 'row-flaky' : undefined}>
      <td className="mono break-all">{item.itemKey}</td>
      <td>{item.rowIndex === null || item.rowIndex === undefined ? '—' : `第 ${String(item.rowIndex)} 行`}</td>
      <td>
        <ChangePill change={item.change} />
        {flaky ? <div className="field-warning">依赖重试，需关注</div> : null}
      </td>
      <td>
        <OutcomePill outcome={item.baseOutcome} /> → <OutcomePill outcome={item.targetOutcome} />
      </td>
      <td>
        {item.errorChanged ? (
          <span className="field-warning">
            错误已变化
            <div className="muted mono break-all cell-sub">
              {item.baseErrorHash ? shortId(item.baseErrorHash, 10) : '无'} → {item.targetErrorHash ? shortId(item.targetErrorHash, 10) : '无'}
            </div>
          </span>
        ) : (
          <span className="muted">未变化</span>
        )}
      </td>
      <td>{formatDeltaMs(item.durationDeltaMs)}</td>
      <td>
        {item.artifactDelta.added.length === 0 && item.artifactDelta.removed.length === 0 ? (
          <span className="muted">无</span>
        ) : (
          <span>
            {item.artifactDelta.added.length > 0 ? <div>新增：{item.artifactDelta.added.join('、')}</div> : null}
            {item.artifactDelta.removed.length > 0 ? <div>消失：{item.artifactDelta.removed.join('、')}</div> : null}
          </span>
        )}
      </td>
      <td>
        {item.attribution ? (
          <div>
            <span className="badge badge-warning">推断</span>{' '}
            {failureLabel ? (
              <span className="failure-category">{failureLabel}</span>
            ) : (
              <span className="muted">无失败分类</span>
            )}
            <div className="muted">
              {failureLabel
                ? '失败原因分类（规则推断，非官方结论）'
                : `变化类型：${COMPARISON_CHANGE_LABELS[item.change] ?? item.change}`}
            </div>
            <div className="muted">
              {ATTRIBUTION_CONFIDENCE_LABELS[item.attribution.confidence] ?? item.attribution.confidence}
            </div>
            {!failureLabel && item.attribution.failureCategory === null ? (
              <div className="muted">该项不是失败类变化；change 只描述回归差异，不代表失败原因。</div>
            ) : null}
            {item.attribution.evidence.length > 0 ? (
              <ul className="tight-list">
                {item.attribution.evidence.map((evidence) => (
                  <li key={evidence}>
                    <PlainText text={evidence} />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <span className="muted">无归因（需人工判断）</span>
        )}
      </td>
    </tr>
  );
}