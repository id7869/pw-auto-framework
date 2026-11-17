/**
 * 运行详情：实时状态（轮询 + 可选 SSE）、统计、逐项结果、产物、诊断、基线与对比入口。
 * 接口：GET /runs/{id}、/items、/artifacts、/baselines、/comparisons（api-contract §5/§6）。
 */
import { useState } from 'react';
import { useApi } from '../api/context.tsx';
import type { ApiErrorInfo } from '../api/http.ts';
import type { Artifact, Baseline, Case, Comparison, PageResult, RunItem } from '../api/types.ts';
import { useApiResource } from '../hooks/use-api-resource.ts';
import { usePagedList } from '../hooks/use-paged-list.ts';
import { navigate, useRoute } from '../hooks/use-route.ts';
import { useRunMonitor } from '../hooks/use-run-monitor.ts';
import { formatDateTime, formatDuration, runDurationMs, shortId } from '../lib/format.ts';
import { BASELINE_CREATOR_LABELS, BASELINE_SCOPE_LABELS, VERDICT_BASIS_NOTE } from '../lib/labels.ts';
import { buildHref } from '../lib/hash-router.ts';
import { isTerminalStatus } from '../lib/polling.ts';
import { nlLinesFromStepOrigin } from '../lib/nl.ts';
import type { FieldError } from '../lib/validation.ts';
import { firstError, toFieldErrors, validateBaselineForm } from '../lib/validation.ts';
import {
  ArtifactsTable,
  DiagnosticsPanel,
  FlakyNotice,
  RunEnvironmentPanel,
  RunErrorNotice,
  RunItemsTable,
  RunMetaPanel,
  RunStatsGrid,
  RunTargetLinks,
} from '../components/RunPanels.tsx';
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
  PlainText,
  SelectField,
  StatusPill,
  TableWrap,
  TextField,
  VerdictPill,
} from '../components/ui.tsx';

const EMPTY_ITEMS: PageResult<RunItem> = { items: [], nextCursor: null, hasMore: false };
const EMPTY_ARTIFACTS: PageResult<Artifact> = { items: [], nextCursor: null, hasMore: false };
const EMPTY_BASELINES: PageResult<Baseline> = { items: [], nextCursor: null, hasMore: false };
const EMPTY_COMPARISONS: PageResult<Comparison> = { items: [], nextCursor: null, hasMore: false };

export function RunDetailPage() {
  const api = useApi();
  const route = useRoute();
  const runId = route.name === 'run-detail' ? route.runId : null;
  const monitor = useRunMonitor(runId);
  const run = monitor.run;
  const terminal = run !== null && isTerminalStatus(run.status);
  const scope = run?.kind === 'suite' ? 'suite' : 'case';
  const scopeId = run?.kind === 'suite' ? (run.suiteId ?? '') : (run?.caseId ?? '');

  const items = usePagedList<RunItem>(
    (cursor) =>
      runId
        ? api.listRunItems(runId, { limit: 50, cursor: cursor ?? undefined })
        : Promise.resolve({ ok: true as const, data: EMPTY_ITEMS }),
    [runId, terminal],
  );
  const artifacts = useApiResource<PageResult<Artifact>>(
    () =>
      runId
        ? api.listArtifacts(runId, { limit: 100 })
        : Promise.resolve({ ok: true as const, data: EMPTY_ARTIFACTS }),
    [runId, terminal],
  );
  // NL → 逐行结果回标：仅用例运行的 stepOrigin 可映射到 NL 行（套件运行暂不展示）
  const runCase = useApiResource<Case | null>(
    () =>
      run && run.kind === 'case' && run.caseId
        ? api.getCase(run.caseId)
        : Promise.resolve({ ok: true as const, data: null }),
    [run?.kind, run?.caseId],
  );
  const nlLines = run?.kind === 'case' ? nlLinesFromStepOrigin(runCase.data?.stepOrigin) : [];
  const baselines = useApiResource<PageResult<Baseline>>(
    () =>
      run && scopeId !== ''
        ? api.listBaselines({ scope, scopeId, limit: 20 })
        : Promise.resolve({ ok: true as const, data: EMPTY_BASELINES }),
    [scope, scopeId, run !== null],
  );
  const [comparisonsTick, setComparisonsTick] = useState(0);
  const comparisons = useApiResource<PageResult<Comparison>>(
    () =>
      runId
        ? api.listComparisons({ runId, limit: 10 })
        : Promise.resolve({ ok: true as const, data: EMPTY_COMPARISONS }),
    [runId, comparisonsTick],
  );

  const [runOpen, setRunOpen] = useState(false);
  const [cancelNotice, setCancelNotice] = useState('');
  const [cancelError, setCancelError] = useState<ApiErrorInfo | null>(null);
  const [baselineName, setBaselineName] = useState('');
  const [baselineNote, setBaselineNote] = useState('');
  const [baselineErrors, setBaselineErrors] = useState<FieldError[]>([]);
  const [baselineError, setBaselineError] = useState<ApiErrorInfo | null>(null);
  const [baselineNotice, setBaselineNotice] = useState('');
  const [baselineSaving, setBaselineSaving] = useState(false);
  const [selectedBaselineId, setSelectedBaselineId] = useState('');
  const [compareError, setCompareError] = useState<ApiErrorInfo | null>(null);
  const [compareSaving, setCompareSaving] = useState(false);

  const baselineItems = baselines.data?.items ?? [];

  const refreshAll = (): void => {
    monitor.refresh();
    items.reload();
    artifacts.reload();
    baselines.reload();
  };

  const cancelRun = async (): Promise<void> => {
    if (!run) return;
    setCancelError(null);
    setCancelNotice('');
    const result = await api.cancelRun(run.id);
    if (result.ok) {
      setCancelNotice(`已请求取消（当前状态：${result.data.status}）；已产出的结果与产物会保留。`);
      monitor.refresh();
    } else {
      setCancelError(result.error);
    }
  };

  const createBaseline = async (): Promise<void> => {
    if (!run) return;
    setBaselineNotice('');
    setBaselineError(null);
    const clientErrors = validateBaselineForm({
      scope,
      scopeId,
      runId: run.id,
      name: baselineName,
      note: baselineNote,
      createdBy: 'user',
    });
    setBaselineErrors(clientErrors);
    if (clientErrors.length > 0) return;
    setBaselineSaving(true);
    const result = await api.createBaseline({
      scope,
      scopeId,
      runId: run.id,
      name: baselineName.trim(),
      note: baselineNote.trim() === '' ? undefined : baselineNote.trim(),
      createdBy: 'user',
    });
    setBaselineSaving(false);
    if (result.ok) {
      setBaselineName('');
      setBaselineNote('');
      setBaselineNotice(`已创建基线「${result.data.name}」`);
      baselines.reload();
      setSelectedBaselineId(result.data.id);
    } else {
      setBaselineError(result.error);
      setBaselineErrors(toFieldErrors(result.error.details));
    }
  };

  const setDefaultBaseline = async (baseline: Baseline): Promise<void> => {
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
    if (!run) return;
    setCompareError(null);
    if (selectedBaselineId === '') {
      setCompareError({ code: 'VALIDATION_FAILED', message: '请选择要对比的基线' });
      return;
    }
    setCompareSaving(true);
    const result = await api.createComparison({ baselineId: selectedBaselineId, runId: run.id });
    setCompareSaving(false);
    if (result.ok) {
      navigate('/regression', { comparisonId: result.data.id });
    } else {
      setCompareError(result.error);
    }
  };

  if (!runId) {
    return (
      <div className="page">
        <PageHeader title="运行详情" actions={<a className="button" href={buildHref('/runs')}>返回运行列表</a>} />
        <EmptyState title="缺少运行 ID" description="请从运行记录列表进入详情页。" />
      </div>
    );
  }

  if (monitor.loading && !run) {
    return (
      <div className="page">
        <PageHeader title="运行详情" actions={<a className="button" href={buildHref('/runs')}>返回运行列表</a>} />
        <LoadingState label="正在加载运行状态…" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="page">
        <PageHeader title="运行详情" actions={<a className="button" href={buildHref('/runs')}>返回运行列表</a>} />
        {monitor.error ? (
          <ErrorState
            error={monitor.error}
            title={monitor.error.code === 'NOT_FOUND' ? '运行不存在' : '运行状态加载失败'}
            onRetry={monitor.refresh}
          />
        ) : (
          <EmptyState title="暂无运行数据" description="请稍后重试或返回运行列表。" />
        )}
      </div>
    );
  }

  const cancellable = run.status === 'queued' || run.status === 'running';
  const artifactsList = artifacts.data?.items ?? [];

  return (
    <div className="page">
      <PageHeader
        title={`运行详情 · ${shortId(run.id, 16)}`}
        description={`${run.kind === 'case' ? '用例运行' : '套件运行'} · 请求于 ${formatDateTime(run.requestedAt)} · 耗时 ${formatDuration(
          runDurationMs(run),
        )}`}
        actions={
          <>
            <a className="button" href={buildHref('/runs')}>
              返回运行列表
            </a>
            <button type="button" className="button" onClick={refreshAll} disabled={monitor.loading || items.loading}>
              刷新
            </button>
            <button type="button" className="button" onClick={() => setRunOpen(true)}>
              重新运行
            </button>
            {cancellable && !run.cancelRequestedAt ? (
              <ConfirmButton
                label="取消运行"
                question="确认取消该运行？已产出的结果与产物会保留。"
                confirmLabel="确认取消"
                onConfirm={cancelRun}
              />
            ) : null}
          </>
        }
      />

      {monitor.error ? (
        <Notice tone="warning" title="运行状态未知，正在自动重试">
          {monitor.error.message}
          {monitor.error.code ? `（错误码：${monitor.error.code}）` : ''}
          <div>
            <button type="button" className="button button-small" onClick={monitor.refresh}>
              立即刷新
            </button>
          </div>
        </Notice>
      ) : null}
      {cancelNotice !== '' ? (
        <Notice tone="info" title="取消请求">
          {cancelNotice}
        </Notice>
      ) : null}
      {cancelError ? (
        <Notice tone="danger" title={`取消失败（${cancelError.code}）`}>
          {cancelError.message}
        </Notice>
      ) : null}
      {run.cancelRequestedAt && cancellable ? (
        <Notice tone="warning" title="已请求取消，等待引擎收尾">
          取消请求时间：{formatDateTime(run.cancelRequestedAt)}；已有结果项与产物会保留。
        </Notice>
      ) : null}

      <Card
        title="运行状态"
        description={`实时状态通过轮询获取（api-contract §0.4）；当前 ${terminal ? '已到终态，停止轮询' : '未到终态，继续轮询'}。`}
        actions={<StatusPill status={run.status} />}
      >
        <RunStatsGrid stats={run.stats} exitCode={run.exitCode} />
        <RunErrorNotice run={run} />
        <FlakyNotice run={run} />
        <p className="muted">
          状态口径：passed ⇔ 官方 JSON 报告 stats.unexpected=0 且 stats.flaky=0（未开启 failOnFlaky 时 flaky 不影响）且退出码为 0；
          前端不重算状态。
          {monitor.sse === 'open' ? ' 本次运行已建立 SSE 连接，事件仅用于触发刷新。' : ''}
          {monitor.sse === 'failed' ? ' SSE 连接失败，已退回轮询。' : ''}
          {monitor.sse === 'off' ? ' 后端未声明 SSE 可用，使用轮询。' : ''}
        </p>
        <p className="muted">
          运行链接：<a href={buildHref(`/runs/${encodeURIComponent(run.id)}`)}>{run.id}</a> · 对象：<RunTargetLinks run={run} /> ·{' '}
          {run.itemsCount} 个结果项 / {run.artifactsCount} 个产物
        </p>
      </Card>

      <div className="two-col-cards">
        <Card title="运行元信息" description="运行写入后不可变；重跑会创建新的运行记录。">
          <RunMetaPanel run={run} />
        </Card>
        <RunEnvironmentPanel run={run} />
      </div>

      <Card title="逐项结果" description="逐行结果来自官方 JSON 报告 tests[].status 与标题中的 [row:N] 标记；attempt 从 0 开始。">
        {!terminal ? <p className="muted">运行尚未结束，结果项可能持续增加；终态后可点「刷新结果」获取最终值。</p> : null}
        <div className="card-actions-inline">
          <button type="button" className="button button-small" onClick={items.reload} disabled={items.loading}>
            {items.loading ? '加载中…' : '刷新结果'}
          </button>
          {items.error ? (
            <span className="field-error">
              <PlainText text={items.error.message} />
            </span>
          ) : null}
        </div>
        {items.loading && items.items.length === 0 ? <LoadingState label="正在加载逐项结果…" /> : null}
        {items.error && items.items.length === 0 ? (
          <ErrorState error={items.error} title="逐项结果加载失败" onRetry={items.reload} />
        ) : (
          <>
            <RunItemsTable
              items={items.items}
              artifacts={artifactsList}
              nlLines={nlLines}
              contentUrl={(artifact) => api.artifactContentUrl(run.id, artifact.id)}
            />
            <LoadMore hasMore={items.hasMore} loading={items.loadingMore} loadedCount={items.items.length} onLoadMore={items.loadMore} />
          </>
        )}
      </Card>

      <Card
        title="产物"
        description="官方产物按运行隔离；内容通过后端受控端点读取（禁止按路径拼接）。"
        actions={
          <button type="button" className="button button-small" onClick={artifacts.reload} disabled={artifacts.loading}>
            {artifacts.loading ? '加载中…' : '刷新产物'}
          </button>
        }
      >
        {artifacts.loading && artifactsList.length === 0 ? <LoadingState label="正在加载产物…" /> : null}
        {artifacts.error && artifactsList.length === 0 ? (
          <ErrorState error={artifacts.error} title="产物加载失败" onRetry={artifacts.reload} />
        ) : (
          <ArtifactsTable artifacts={artifactsList} contentUrl={(artifact) => api.artifactContentUrl(run.id, artifact.id)} />
        )}
      </Card>

      <Card
        title="回归基线与对比"
        description={`归属：${BASELINE_SCOPE_LABELS[scope]} ${scopeId === '' ? '（缺少归属 ID）' : scopeId}。仅通过的运行可作为基线（合同 §6.1）。`}
      >
        {!terminal ? (
          <Notice tone="info" title="运行尚未结束">
            运行结束后才能创建基线或发起对比（否则后端返回 422 RUN_NOT_TERMINAL）。
          </Notice>
        ) : null}
        {terminal && run.status !== 'passed' ? (
          <Notice tone="warning" title="本次运行未通过">
            只有 passed 的运行可设为基线；对未通过的运行仍可与既有基线对比，查看差异归因。
          </Notice>
        ) : null}
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

        {baselines.loading && baselineItems.length === 0 ? <LoadingState label="正在加载基线…" /> : null}
        {baselines.error ? <ErrorState error={baselines.error} title="基线加载失败" onRetry={baselines.reload} /> : null}
        {!baselines.loading && !baselines.error && baselineItems.length === 0 ? (
          <EmptyState title="该归属还没有基线" description="通过一次运行后，将其设为基线即可用于后续回归对比。" />
        ) : null}

        {baselineItems.length > 0 ? (
          <TableWrap label="基线列表">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">基线</th>
                  <th scope="col">来源运行</th>
                  <th scope="col">默认</th>
                  <th scope="col">创建人</th>
                  <th scope="col">创建时间</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {baselineItems.map((baseline) => (
                  <tr key={baseline.id}>
                    <td>
                      <span className="strong">{baseline.name}</span>
                      {baseline.note ? <div className="muted cell-sub">{baseline.note}</div> : null}
                      {baseline.archivedAt ? <div className="field-warning">已归档</div> : null}
                    </td>
                    <td className="mono break-all">
                      <a href={buildHref(`/runs/${encodeURIComponent(baseline.runId)}`)}>{shortId(baseline.runId, 14)}</a>
                    </td>
                    <td>{baseline.isDefault ? <span className="badge badge-info">默认</span> : <span className="muted">—</span>}</td>
                    <td>{BASELINE_CREATOR_LABELS[baseline.createdBy] ?? baseline.createdBy}</td>
                    <td>{formatDateTime(baseline.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        {!baseline.isDefault && !baseline.archivedAt ? (
                          <button type="button" className="button button-small" onClick={() => void setDefaultBaseline(baseline)}>
                            设为默认
                          </button>
                        ) : null}
                        {!baseline.archivedAt ? (
                          <ConfirmButton
                            label="归档"
                            question={`归档基线「${baseline.name}」？归档后不可再用于新对比。`}
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
        ) : null}

        {terminal && run.status === 'passed' ? (
          <div className="baseline-form">
            <h3>把本次运行设为基线</h3>
            {baselineErrors.length > 0 ? <FormErrors errors={baselineErrors} /> : null}
            <div className="form-grid">
              <TextField
                id="baseline-name"
                label="基线名称"
                value={baselineName}
                onChange={setBaselineName}
                required
                maxLength={200}
                placeholder="例如：改版前基线"
                error={firstError(baselineErrors.filter((error) => error.path === 'name'))?.message}
                disabled={baselineSaving}
              />
              <TextField
                id="baseline-note"
                label="备注（可选）"
                value={baselineNote}
                onChange={setBaselineNote}
                maxLength={2000}
                disabled={baselineSaving}
              />
            </div>
            <button type="button" className="button button-primary" onClick={() => void createBaseline()} disabled={baselineSaving}>
              {baselineSaving ? '创建中…' : '创建基线'}
            </button>
          </div>
        ) : null}

        <div className="compare-box">
          <h3>与基线对比</h3>
          <p className="muted">
            对比由后端按固定 10 类差异枚举归一化；结论中的 verdict 属胶水层计算。{VERDICT_BASIS_NOTE}
          </p>
          {compareError ? (
            <Notice tone="danger" title={`创建对比失败（${compareError.code}）`}>
              {compareError.message}
            </Notice>
          ) : null}
          <div className="inline-form">
            <SelectField
              id="baseline-select"
              label="选择基线"
              value={selectedBaselineId}
              options={baselineItems
                .filter((baseline) => !baseline.archivedAt)
                .map((baseline) => ({
                  value: baseline.id,
                  label: `${baseline.name}${baseline.isDefault ? '（默认）' : ''} · 运行 ${shortId(baseline.runId, 12)}`,
                }))}
              onChange={setSelectedBaselineId}
              emptyLabel="请选择基线"
              disabled={compareSaving || !terminal}
            />
            <button
              type="button"
              className="button button-primary"
              onClick={() => void createComparison()}
              disabled={compareSaving || !terminal || selectedBaselineId === ''}
            >
              {compareSaving ? '创建中…' : '创建对比'}
            </button>
          </div>
        </div>

        {comparisons.loading && (comparisons.data?.items.length ?? 0) === 0 ? <LoadingState label="正在加载相关对比…" /> : null}
        {comparisons.error ? (
          <ErrorState error={comparisons.error} title="相关对比加载失败" onRetry={() => setComparisonsTick((value) => value + 1)} />
        ) : null}
        {(comparisons.data?.items.length ?? 0) > 0 ? (
          <TableWrap label="该运行的相关对比">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">对比</th>
                  <th scope="col">基线运行</th>
                  <th scope="col">结论</th>
                  <th scope="col">新增失败 / 仍通过</th>
                  <th scope="col">创建时间</th>
                </tr>
              </thead>
              <tbody>
                {(comparisons.data?.items ?? []).map((comparison) => (
                  <tr key={comparison.id}>
                    <td>
                      <a href={buildHref('/regression', { comparisonId: comparison.id })} className="mono">
                        {shortId(comparison.id, 14)}
                      </a>
                    </td>
                    <td className="mono break-all">{shortId(comparison.baselineRunId, 14)}</td>
                    <td>
                      <VerdictPill verdict={comparison.summary.verdict} />
                    </td>
                    <td>
                      新增失败 {comparison.summary.newly_failed} · 仍通过 {comparison.summary.still_passed}
                    </td>
                    <td>{formatDateTime(comparison.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        ) : null}
      </Card>

      <DiagnosticsPanel run={run} />

      {runOpen ? (
        <RunDialog
          target={
            run.kind === 'case' && run.caseId
              ? { kind: 'case', caseId: run.caseId, datasetId: run.datasetId ?? undefined }
              : run.suiteId
                ? { kind: 'suite', suiteId: run.suiteId }
                : { kind: 'choose' }
          }
          onClose={() => setRunOpen(false)}
          onStarted={(created) => {
            setRunOpen(false);
            navigate(`/runs/${encodeURIComponent(created.id)}`);
          }}
        />
      ) : null}
    </div>
  );
}