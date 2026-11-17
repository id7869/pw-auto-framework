/**
 * 运行相关的展示组件：统计、产物、逐项结果与 attempt 详情、诊断信息。
 * 只展示后端返回的官方 JSON 报告派生字段，不在前端重算状态。
 */
import { useState } from 'react';
import type { Artifact, Run, RunItem, RunItemAttempt, RunStats } from '../api/types.ts';
import { ARTIFACT_KIND_LABELS, BASELINE_SCOPE_LABELS, ATTEMPT_STATUS_LABELS } from '../lib/labels.ts';
import { formatArgv } from '../lib/argv.ts';
import { stripAnsi } from '../lib/ansi.ts';
import { findAttachmentArtifact } from '../lib/artifacts.ts';
import { formatNlLines } from '../lib/nl.ts';
import { formatBytes, formatDateTime, formatDeltaMs, formatDuration, shortId, truncateText } from '../lib/format.ts';
import { buildHref, hrefForRun } from '../lib/hash-router.ts';
import { Card, CodeText, CopyButton, EmptyState, KeyValueList, Notice, OutcomePill, PlainText, TableWrap } from './ui.tsx';

export function RunStatsGrid({ stats, exitCode }: { stats: RunStats | undefined; exitCode?: number | null }) {
  const safe = stats ?? { expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 };
  return (
    <dl className="stat-grid" aria-label="运行统计">
      <div className="stat stat-success">
        <dt>通过（expected）</dt>
        <dd>{safe.expected}</dd>
      </div>
      <div className="stat stat-danger">
        <dt>失败（unexpected）</dt>
        <dd>{safe.unexpected}</dd>
      </div>
      <div className="stat stat-warning">
        <dt>偶发（flaky）</dt>
        <dd>{safe.flaky}</dd>
      </div>
      <div className="stat">
        <dt>跳过（skipped）</dt>
        <dd>{safe.skipped}</dd>
      </div>
      <div className="stat">
        <dt>耗时</dt>
        <dd>{formatDuration(safe.durationMs)}</dd>
      </div>
      <div className="stat">
        <dt>退出码</dt>
        <dd>{exitCode === null || exitCode === undefined ? '—' : exitCode}</dd>
      </div>
    </dl>
  );
}

export function RunTargetLinks({ run }: { run: Run }) {
  return (
    <span className="inline-links">
      {run.caseId ? <a href={buildHref(`/cases/${encodeURIComponent(run.caseId)}/edit`)}>打开用例</a> : null}
      {run.suiteId ? <a href={buildHref('/suites', { suiteId: run.suiteId })}>打开套件</a> : null}
      {run.datasetId ? <a href={buildHref('/datasets', { caseId: run.caseId ?? undefined, datasetId: run.datasetId })}>打开数据集</a> : null}
    </span>
  );
}

export function ArtifactsTable({
  artifacts,
  contentUrl,
  emptyHint = '本次运行没有登记产物。',
}: {
  artifacts: Artifact[];
  contentUrl: (artifact: Artifact) => string;
  emptyHint?: string;
}) {
  if (artifacts.length === 0) {
    return <EmptyState title="暂无产物" description={emptyHint} />;
  }
  return (
    <TableWrap label="运行产物列表">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">类型</th>
            <th scope="col">文件</th>
            <th scope="col">大小</th>
            <th scope="col">内容类型</th>
            <th scope="col">SHA-256（前 12 位）</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {artifacts.map((artifact) => (
            <tr key={artifact.id}>
              <td>{ARTIFACT_KIND_LABELS[artifact.kind] ?? artifact.kind}</td>
              <td className="mono break-all">{artifact.fileName}</td>
              <td>{formatBytes(artifact.sizeBytes)}</td>
              <td className="mono">{artifact.contentType}</td>
              <td className="mono">{shortId(artifact.sha256, 12)}</td>
              <td>
                <a href={contentUrl(artifact)} target="_blank" rel="noreferrer">
                  打开 / 下载
                </a>
                {artifact.itemKey ? <span className="muted"> · {shortId(artifact.itemKey, 24)}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export function RunItemsTable({
  items,
  artifacts,
  contentUrl,
  nlLines,
  emptyHint = '运行尚未产生逐项结果；终态后仍未出现请检查后端与官方 JSON 报告。',
}: {
  items: RunItem[];
  artifacts: Artifact[];
  contentUrl: (artifact: Artifact) => string;
  /** 用例 NL 生成步骤覆盖的 NL 行（用于逐行结果回标） */
  nlLines?: readonly number[];
  emptyHint?: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (items.length === 0) {
    return <EmptyState title="暂无逐项结果" description={emptyHint} />;
  }

  return (
    <TableWrap label="运行逐项结果">
      <table className="table table-items">
        <thead>
          <tr>
            <th scope="col">结果项（itemKey）</th>
            <th scope="col">标题</th>
            <th scope="col">数据行</th>
            <th scope="col">NL 行</th>
            <th scope="col">状态</th>
            <th scope="col">尝试</th>
            <th scope="col">耗时</th>
            <th scope="col">错误摘要</th>
            <th scope="col">证据</th>
            <th scope="col">详情</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const failedAttempt = item.attempts.find((attempt) => attempt.error !== null) ?? item.attempts[item.attempts.length - 1];
            const errorMessage = failedAttempt?.error?.message;
            const isOpen = expanded === item.itemKey;
            return (
              <ItemRows
                key={item.itemKey}
                item={item}
                isOpen={isOpen}
                errorMessage={errorMessage}
                artifacts={artifacts}
                nlLines={nlLines}
                contentUrl={contentUrl}
                onToggle={() => setExpanded(isOpen ? null : item.itemKey)}
              />
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

function ItemRows({
  item,
  isOpen,
  errorMessage,
  artifacts,
  nlLines,
  contentUrl,
  onToggle,
}: {
  item: RunItem;
  isOpen: boolean;
  errorMessage: string | undefined;
  artifacts: Artifact[];
  nlLines?: readonly number[];
  contentUrl: (artifact: Artifact) => string;
  onToggle: () => void;
}) {
  const evidence = artifacts.filter(
    (artifact) => artifact.itemKey === item.itemKey && (artifact.kind === 'trace' || artifact.kind === 'screenshot'),
  );
  return (
    <>
      <tr className={isOpen ? 'is-open' : undefined}>
        <td className="mono break-all">{item.itemKey}</td>
        <td>
          <PlainText text={item.title} />
        </td>
        <td>{item.rowIndex === null || item.rowIndex === undefined ? '—' : `第 ${String(item.rowIndex)} 行`}</td>
        <td>{nlLines && nlLines.length > 0 ? formatNlLines(nlLines) : <span className="muted">—</span>}</td>
        <td>
          <OutcomePill outcome={item.outcome} />
        </td>
        <td>{item.attempts.length}</td>
        <td>{formatDuration(item.durationMs)}</td>
        <td className="wrap">
          {errorMessage ? truncateText(stripAnsi(errorMessage), 120) : <span className="muted">—</span>}
        </td>
        <td>
          {evidence.length === 0 ? (
            <span className="muted">—</span>
          ) : (
            <span className="row-actions">
              {evidence.map((artifact) => (
                <a key={artifact.id} href={contentUrl(artifact)} target="_blank" rel="noreferrer" title={artifact.fileName}>
                  {artifact.kind === 'trace' ? 'trace' : '截图'}
                </a>
              ))}
            </span>
          )}
        </td>
        <td>
          <button type="button" className="button button-small" aria-expanded={isOpen} onClick={onToggle}>
            {isOpen ? '收起' : '展开'}
          </button>
        </td>
      </tr>
      {isOpen ? (
        <tr className="detail-row">
          <td colSpan={10}>
            <div className="attempt-list">
              {item.attempts.length === 0 ? <p className="muted">该结果项没有 attempt 记录。</p> : null}
              {item.attempts.map((attempt) => (
                <AttemptCard
                  key={`${item.itemKey}#${String(attempt.attempt)}`}
                  attempt={attempt}
                  itemKey={item.itemKey}
                  artifacts={artifacts}
                  contentUrl={contentUrl}
                />
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function AttemptCard({
  attempt,
  itemKey,
  artifacts,
  contentUrl,
}: {
  attempt: RunItemAttempt;
  itemKey: string | null;
  artifacts: Artifact[];
  contentUrl: (artifact: Artifact) => string;
}) {
  return (
    <article className="attempt-card" aria-label={`第 ${String(attempt.attempt + 1)} 次尝试`}>
      <header className="attempt-head">
        <strong>第 {attempt.attempt + 1} 次尝试</strong>
        <span className="muted">
          状态：{ATTEMPT_STATUS_LABELS[attempt.status] ?? attempt.status} · 耗时 {formatDuration(attempt.durationMs)} · 开始于{' '}
          {formatDateTime(attempt.startTime)}
        </span>
      </header>
      {attempt.error ? (
        <div className="attempt-error">
          <p className="error-message">
            <PlainText text={attempt.error.message} />
          </p>
          <div className="error-actions">
            <CopyButton text={attempt.error.message} label="复制原始错误（含控制符）" />
          </div>
          <p className="muted">
            原始 message 仍保存在接口与产物中，此处只在展示时剥离 ANSI 控制序列（颜色/光标等）。
          </p>
          {attempt.error.location ? (
            <p className="muted">
              位置：<code>{attempt.error.location.file}</code>:{attempt.error.location.line}:{attempt.error.location.column}
            </p>
          ) : null}
          {attempt.error.snippet ? <CodeText>{attempt.error.snippet}</CodeText> : null}
          {attempt.error.stack ? (
            <details>
              <summary>官方调用栈</summary>
              <CodeText>{attempt.error.stack}</CodeText>
            </details>
          ) : null}
        </div>
      ) : (
        <p className="muted">本次尝试没有错误信息。</p>
      )}
      {attempt.steps.length > 0 ? (
        <div className="attempt-steps">
          <p className="label">步骤（官方 test.step）</p>
          <ol>
            {attempt.steps.map((step, index) => (
              <li key={`${step.title}:${String(index)}`}>
                <span className={step.error ? 'step-failed' : undefined}>
                  <PlainText text={step.title} />
                </span>
                <span className="muted"> · {formatDuration(step.durationMs)}</span>
                {step.error ? (
                  <div className="step-error">
                    <PlainText text={step.error} />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {attempt.attachments.length > 0 ? (
        <div className="attempt-attachments">
          <p className="label">附件</p>
          <ul>
            {attempt.attachments.map((attachment) => {
              const artifact = findAttachmentArtifact(attachment, itemKey, artifacts);
              const matchedByName = artifact !== undefined && (attachment.artifactId === null || attachment.artifactId === '');
              return (
                <li key={`${attachment.name}:${attachment.contentType}`}>
                  {artifact ? (
                    <a href={contentUrl(artifact)} target="_blank" rel="noreferrer">
                      {attachment.name}
                    </a>
                  ) : (
                    <span>{attachment.name}</span>
                  )}
                  <span className="muted"> · {attachment.contentType}</span>
                  {matchedByName ? <span className="muted"> · 按附件名/类型匹配到产物</span> : null}
                  {!artifact ? <span className="muted"> · 产物未登记或已被清理</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {attempt.stdout || attempt.stderr ? (
        <details className="attempt-logs">
          <summary>标准输出 / 标准错误（官方捕获）{attempt.truncated ? '（已截断）' : ''}</summary>
          {attempt.stdout ? (
            <>
              <div className="log-actions">
                <p className="label">stdout</p>
                <CopyButton text={attempt.stdout} label="复制原始 stdout" />
              </div>
              <CodeText>{attempt.stdout}</CodeText>
            </>
          ) : null}
          {attempt.stderr ? (
            <>
              <div className="log-actions">
                <p className="label">stderr</p>
                <CopyButton text={attempt.stderr} label="复制原始 stderr" />
              </div>
              <CodeText>{attempt.stderr}</CodeText>
            </>
          ) : null}
        </details>
      ) : null}
    </article>
  );
}

export function DiagnosticsPanel({ run }: { run: Run }) {
  const diagnostics = run.diagnostics;
  const commandLine = diagnostics.command.length > 0 ? formatArgv(diagnostics.command) : '（后端未回显命令）';
  return (
    <Card title="诊断与复现" description="后端回显的官方 CLI 命令、编译产物与工作目录；不包含任何密钥。">
      <KeyValueList
        items={[
          { label: '官方 CLI 路径', value: <span className="mono break-all">{diagnostics.playwrightCliPath}</span> },
          {
            label: '官方命令',
            value: (
              <span className="command-line">
                <code className="mono break-all">{commandLine}</code>
                {diagnostics.command.length > 0 ? <CopyButton text={commandLine} label="复制命令" /> : null}
              </span>
            ),
          },
          { label: '编译产物（spec）', value: <span className="mono break-all">{diagnostics.specPath ?? '—'}</span> },
          { label: '官方 JSON 报告', value: <span className="mono break-all">{diagnostics.reportPath ?? '—'}</span> },
          { label: '工作目录', value: <span className="mono break-all">{diagnostics.workspaceDir}</span> },
          {
            label: '警告',
            value:
              diagnostics.warnings.length === 0 ? (
                <span className="muted">无</span>
              ) : (
                <ul className="tight-list">
                  {diagnostics.warnings.map((warning) => (
                    <li key={warning}>
                      <PlainText text={warning} />
                    </li>
                  ))}
                </ul>
              ),
          },
        ]}
      />
      <p className="muted">
        复现提示：在仓库根执行上面的官方命令即可复现本次运行（路径与参数均来自后端回显，前端不拼接命令）。
      </p>
    </Card>
  );
}

export function RunEnvironmentPanel({ run }: { run: Run }) {
  const environment = run.environment;
  const options = run.options;
  return (
    <Card title="执行环境与参数" description="环境指纹用于跨运行对比；参数为后端实际生效值。">
      <div className="two-col">
        <KeyValueList
          ariaLabel="执行环境"
          items={[
            { label: 'Node', value: environment.node ?? '—' },
            { label: 'Playwright', value: environment.playwright ?? '—' },
            { label: '浏览器', value: environment.browser ?? '—' },
            { label: '操作系统', value: environment.os ?? '—' },
            { label: '时区', value: environment.timezone ?? '—' },
          ]}
        />
        <KeyValueList
          ariaLabel="运行参数"
          items={[
            { label: '重试', value: options.retries ?? '—' },
            { label: '并行数', value: options.workers ?? '—' },
            { label: '超时（毫秒）', value: options.timeoutMs ?? '—' },
            { label: 'Trace', value: options.trace ?? '—' },
            { label: '截图', value: options.screenshot ?? '—' },
            { label: '录屏', value: options.video ?? '—' },
            { label: '浏览器', value: options.browser ?? '—' },
            { label: 'headed', value: options.headed ? '是' : '否' },
            { label: 'flaky 判失败', value: options.failOnFlaky ? '是' : '否' },
          ]}
        />
      </div>
    </Card>
  );
}

export function RunErrorNotice({ run }: { run: Run }) {
  if (!run.error) return null;
  return (
    <Notice tone="danger" title={`运行级错误：${run.error.code}`}>
      <p>
        <PlainText text={run.error.message} />
      </p>
      <CopyButton text={run.error.message} label="复制原始运行错误（含控制符）" />
      {run.error.detail !== undefined ? <CodeText>{JSON.stringify(run.error.detail, null, 2)}</CodeText> : null}
    </Notice>
  );
}

export function FlakyNotice({ run }: { run: Run }) {
  if (!run.stats || run.stats.flaky <= 0) return null;
  return (
    <Notice tone="warning" title={`存在 ${String(run.stats.flaky)} 个 flaky 结果`}>
      flaky 表示首次失败、重试通过（官方判定）。请展开对应结果项查看首次失败原因；若开启 failOnFlaky，本次运行会被判为失败。
    </Notice>
  );
}

export function RunMetaPanel({ run }: { run: Run }) {
  return (
    <KeyValueList
      ariaLabel="运行信息"
      items={[
        { label: '运行 ID', value: <span className="mono break-all">{run.id}</span> },
        {
          label: '类型',
          value:
            run.kind === 'case'
              ? `用例（${BASELINE_SCOPE_LABELS.case}）`
              : `套件（${BASELINE_SCOPE_LABELS.suite}）`,
        },
        { label: '用例 / 套件 ID', value: <span className="mono break-all">{run.caseId ?? run.suiteId ?? '—'}</span> },
        { label: '数据集 ID', value: <span className="mono break-all">{run.datasetId ?? '未使用'}</span> },
        { label: '排队位次', value: run.queuePosition === null ? '—' : run.queuePosition },
        { label: '请求时间', value: formatDateTime(run.requestedAt) },
        { label: '开始时间', value: formatDateTime(run.startedAt) },
        { label: '结束时间', value: formatDateTime(run.finishedAt) },
        {
          label: '取消请求时间',
          value: run.cancelRequestedAt ? formatDateTime(run.cancelRequestedAt) : '—',
        },
        { label: '结果项 / 产物数', value: `${String(run.itemsCount)} / ${String(run.artifactsCount)}` },
        {
          label: '回归对比',
          value: <a href={buildHref('/regression', { runId: run.id })}>查看与该运行相关的对比</a>,
        },
        { label: '运行链接', value: <a href={hrefForRun(run.id)}>固定链接</a> },
      ]}
    />
  );
}

/** attempt 耗时变化文案（对比页也会用到） */
export function durationDeltaText(delta: number | null | undefined): string {
  return formatDeltaMs(delta);
}