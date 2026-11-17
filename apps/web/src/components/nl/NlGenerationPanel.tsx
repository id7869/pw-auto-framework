/**
 * NL 生成结果面板：状态、告警、生成步骤卡片（来源 NL 行/动作/定位器/值/依据）、Accept/Reject。
 * 仅展示服务端返回的生成结果，不伪造状态。
 */
import type { ApiErrorInfo } from '../../api/http.ts';
import type { NlGeneration, NlSource } from '../../api/types.ts';
import {
  NL_EXTERNAL_AGENT_NOTE,
  NL_GENERATION_STATUS_LABELS,
  NL_GENERATION_STATUS_TONES,
  NL_WARNING_CODE_LABELS,
} from '../../lib/labels.ts';
import { formatDateTime } from '../../lib/format.ts';
import {
  STEP_ACTION_META,
  summarizeTarget,
} from '../../lib/steps.ts';
import { generatedStepSources, isGenerationActive, isGenerationStale } from '../../lib/nl.ts';
import {
  Badge,
  CheckboxField,
  EmptyState,
  Notice,
  PlainText,
  TextField,
} from '../ui.tsx';

export interface NlGenerationPanelProps {
  generation: NlGeneration;
  nlSource: NlSource | null;
  busy: boolean;
  error: ApiErrorInfo | null;
  rejectReason: string;
  acceptForce: boolean;
  onRejectReasonChange: (value: string) => void;
  onAcceptForceChange: (value: boolean) => void;
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
  onRegenerate: () => void;
}

export function NlGenerationPanel({
  generation,
  nlSource,
  busy,
  error,
  rejectReason,
  acceptForce,
  onRejectReasonChange,
  onAcceptForceChange,
  onAccept,
  onReject,
  onCancel,
  onRegenerate,
}: NlGenerationPanelProps) {
  const stale = isGenerationStale(generation, nlSource);
  const steps = generatedStepSources(generation);
  const active = isGenerationActive(generation.status);

  return (
    <section className="nl-generation" aria-labelledby="nl-generation-title">
      <header className="nl-generation-head">
        <div>
          <h3 id="nl-generation-title">生成任务</h3>
          <p className="muted mono break-all">{generation.id}</p>
        </div>
        <Badge tone={NL_GENERATION_STATUS_TONES[generation.status]}>
          {NL_GENERATION_STATUS_LABELS[generation.status] ?? generation.status}
        </Badge>
      </header>

      <p className="muted">
        生成器：{generation.generator} · 来源哈希：<code>{generation.sourceHash}</code> · 更新于{' '}
        {formatDateTime(generation.updatedAt)}
      </p>

      {active ? (
        <Notice tone="info" title="等待外部 coding agent 领取并提交生成结果">
          <p>{NL_EXTERNAL_AGENT_NOTE}</p>
          <p className="muted">生成任务当前状态：{NL_GENERATION_STATUS_LABELS[generation.status]}；页面会自动轮询。</p>
          <button type="button" className="button button-small" onClick={onCancel} disabled={busy}>
            取消生成
          </button>
        </Notice>
      ) : null}

      {generation.status === 'ready' && stale ? (
        <Notice tone="warning" title="生成结果已过期（stale）">
          NL 文本在生成后又被修改；请重新生成并验收。若确认要接受旧结果，可勾选下方“强制接受过期结果”。
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="danger" title={`NL 生成操作失败（${error.code}）`}>
          {error.message}
        </Notice>
      ) : null}

      {generation.warnings.length > 0 ? (
        <div className="nl-warnings" role="alert">
          <h4>服务端告警</h4>
          <ul className="tight-list">
            {generation.warnings.map((warning) => (
              <li key={`${warning.code}:${String(warning.line)}:${warning.message}`}>
                <Badge tone="warning">{NL_WARNING_CODE_LABELS[warning.code] ?? warning.code}</Badge>{' '}
                {warning.line > 0 ? <span className="muted">NL 第 {warning.line} 行：</span> : null}
                <PlainText text={warning.message} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {generation.status === 'ready' || generation.status === 'accepted' ? (
        <>
          {steps.length === 0 ? (
            <EmptyState title="生成结果没有步骤" description="服务端返回空结果；请拒绝并重新生成。" />
          ) : (
            <div className="nl-step-cards">
              {steps.map(({ step, line, text }, index) => (
                <article className="nl-step-card" key={step.id}>
                  <header>
                    <h4>
                      第 {index + 1} 步 · {STEP_ACTION_META[step.action]?.label ?? step.action}
                    </h4>
                    <Badge tone="neutral">{step.action}</Badge>
                  </header>
                  <dl className="kv">
                    <div className="kv-row">
                      <dt>来源 NL 行</dt>
                      <dd>
                        {line === null ? (
                          <span className="field-warning">未绑定 NL 行（需人工确认）</span>
                        ) : (
                          <>
                            第 {line} 行
                            {text ? <div className="muted">「{text}」</div> : null}
                          </>
                        )}
                      </dd>
                    </div>
                    <div className="kv-row">
                      <dt>定位器</dt>
                      <dd>{summarizeTarget(step.target)}</dd>
                    </div>
                    <div className="kv-row">
                      <dt>值 / 参数</dt>
                      <dd>
                        <span className="mono break-all">
                          {step.value ?? step.url ?? step.key ?? (step.width !== undefined ? `${String(step.width)}×${String(step.height)}` : '—')}
                        </span>
                      </dd>
                    </div>
                    <div className="kv-row">
                      <dt>依据</dt>
                      <dd>
                        {line === null
                          ? '生成结果未提供来源行'
                          : `NL 第 ${line} 行：${text ?? '（原文已变更）'}`}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          )}

          {generation.status === 'ready' ? (
            <>
              <div className="nl-accept">
                {stale ? (
                  <CheckboxField
                    id="nl-accept-force"
                    label="强制接受过期结果（force）"
                    checked={acceptForce}
                    onChange={onAcceptForceChange}
                    hint="仅在确认文本变更不影响该生成结果时使用"
                  />
                ) : null}
                <button
                  type="button"
                  className="button button-primary"
                  onClick={onAccept}
                  disabled={busy || (stale && !acceptForce)}
                >
                  {busy ? '处理中…' : '接受（Accept）并写入 steps'}
                </button>
                <button type="button" className="button" onClick={onRegenerate} disabled={busy}>
                  重新生成
                </button>
              </div>
              <div className="nl-reject">
                <TextField
                  id="nl-reject-reason"
                  label="拒绝原因（Reject 必填）"
                  value={rejectReason}
                  onChange={onRejectReasonChange}
                  maxLength={1000}
                  placeholder="例如：第 2 行定位不明确，需要重新生成"
                  disabled={busy}
                />
                <button
                  type="button"
                  className="button button-danger"
                  onClick={onReject}
                  disabled={busy || rejectReason.trim() === ''}
                >
                  拒绝（Reject）
                </button>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {generation.status === 'accepted' ? (
        <Notice tone="success" title="已接受生成结果">
          执行真相是以本次生成写入的 steps；可在「步骤」与「代码」视图查看。
        </Notice>
      ) : null}

      {generation.status === 'rejected' || generation.status === 'failed' || generation.status === 'cancelled' ? (
        <div className="row-actions">
          <button type="button" className="button" onClick={onRegenerate} disabled={busy}>
            重新生成
          </button>
        </div>
      ) : null}

      {generation.error ? (
        <Notice tone="danger" title={`生成失败（${generation.error.code}）`}>
          <PlainText text={generation.error.message} />
        </Notice>
      ) : null}

      {generation.status === 'ready' ? (
        <p className="muted">接受后写入 steps；这一步是唯一落库路径，不会自动执行。</p>
      ) : null}
    </section>
  );
}