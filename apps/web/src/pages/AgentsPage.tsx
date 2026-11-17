/**
 * Agent 交接：官方三个 Agent（planner/generator/healer）、init-agents 脚手架、
 * 提示词、产物目录索引、MCP 会话、CLI 命令面板。
 *
 * 边界（PRD R2.0 / 研究 R-02 §4.5）：本框架不内置模型、不调用 LLM；
 * 规划/生成/修复由外部 coding agent 依据官方定义完成。
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { useApi } from '../api/context.tsx';
import { createIdempotencyKey } from '../api/http.ts';
import type { ApiErrorInfo } from '../api/http.ts';
import type { AgentEntry, AgentHarness, AgentPrompt, CliExecResult, McpSession, Scaffold } from '../api/types.ts';
import { AGENT_ENTRIES } from '../api/types.ts';
import { useApiResource } from '../hooks/use-api-resource.ts';
import { usePagedList } from '../hooks/use-paged-list.ts';
import { formatArgv, tokenizeArgv } from '../lib/argv.ts';
import {
  AGENT_BOUNDARY_NOTES,
  AGENT_HANDOFF_STEPS,
  OFFICIAL_COMMANDS,
  OFFICIAL_COMMAND_CATEGORY_LABELS,
  OFFICIAL_LINKS,
} from '../lib/agent-info.ts';
import { agentEntryLabel, HARNESS_SCOPE_LABELS } from '../lib/labels.ts';
import { formatBytes, formatDateTime, shortId } from '../lib/format.ts';
import { buildHref } from '../lib/hash-router.ts';
import {
  BROWSER_OPTIONS,
  firstError,
} from '../lib/validation.ts';
import type { FieldError } from '../lib/validation.ts';
import {
  Card,
  CheckboxField,
  CodeText,
  ConfirmButton,
  CopyButton,
  EmptyState,
  ErrorState,
  FormErrors,
  KeyValueList,
  LoadMore,
  LoadingState,
  Notice,
  NumberField,
  PageHeader,
  SelectField,
  TableWrap,
  TextField,
} from '../components/ui.tsx';

export function AgentsPage() {
  const api = useApi();

  const harnesses = useApiResource(() => api.agentHarnesses(), []);
  const harnessItems = harnesses.data?.items ?? [];
  const entryOptions =
    harnessItems.length > 0
      ? harnessItems.map((harness) => ({ value: harness.entry, label: `${harness.label}（${harness.entry}）` }))
      : AGENT_ENTRIES.map((entry) => ({ value: entry, label: agentEntryLabel(entry) }));

  const prompts = useApiResource(() => api.agentPrompts(), []);
  const promptByKey = new Map((prompts.data?.items ?? []).map((prompt) => [prompt.key, prompt]));

  const scaffolds = usePagedList<Scaffold>(
    (cursor) => api.listScaffolds({ limit: 20, cursor: cursor ?? undefined }),
    [],
  );
  const [selectedScaffold, setSelectedScaffold] = useState<Scaffold | null>(null);

  const [entry, setEntry] = useState<AgentEntry>('claude');
  const [withPrompts, setWithPrompts] = useState(true);
  const [confirmScaffold, setConfirmScaffold] = useState(false);
  const [scaffoldErrors, setScaffoldErrors] = useState<FieldError[]>([]);
  const [scaffoldError, setScaffoldError] = useState<ApiErrorInfo | null>(null);
  const [scaffoldNotice, setScaffoldNotice] = useState('');
  const [scaffoldSaving, setScaffoldSaving] = useState(false);

  const [workspacePath, setWorkspacePath] = useState('specs/');
  const [workspaceScaffoldId, setWorkspaceScaffoldId] = useState('');
  const [workspaceError, setWorkspaceError] = useState<ApiErrorInfo | null>(null);
  const [workspaceQuery, setWorkspaceQuery] = useState<{ path: string; scaffoldId?: string } | null>(null);
  const workspace = useApiResource(
    () =>
      workspaceQuery
        ? api.agentWorkspace({
            path: workspaceQuery.path,
            ...(workspaceQuery.scaffoldId ? { scaffoldId: workspaceQuery.scaffoldId } : {}),
          })
        : Promise.resolve({ ok: true as const, data: { items: [] } }),
    [workspaceQuery?.path, workspaceQuery?.scaffoldId],
  );

  const sessions = useApiResource(() => api.listMcpSessions(), []);
  const [mcpError, setMcpError] = useState<ApiErrorInfo | null>(null);
  const [mcpNotice, setMcpNotice] = useState('');
  const [mcpSaving, setMcpSaving] = useState(false);
  const [caps, setCaps] = useState<string[]>(['testing', 'storage', 'network']);
  const [mcpHeadless, setMcpHeadless] = useState(true);
  const [mcpIsolated, setMcpIsolated] = useState(true);
  const [mcpBrowser, setMcpBrowser] = useState('chromium');
  const [expandedSession, setExpandedSession] = useState<string | null>(null);

  const cliCommands = useApiResource(() => api.cliCommands(), []);
  const [cliCommand, setCliCommand] = useState('');
  const [cliArgs, setCliArgs] = useState('');
  const [cliSession, setCliSession] = useState('pw-ui');
  const [cliTimeout, setCliTimeout] = useState<number | ''>(30000);
  const [cliConfirm, setCliConfirm] = useState(false);
  const [cliErrors, setCliErrors] = useState<FieldError[]>([]);
  const [cliError, setCliError] = useState<ApiErrorInfo | null>(null);
  const [cliResult, setCliResult] = useState<CliExecResult | null>(null);
  const [cliSaving, setCliSaving] = useState(false);

  const commandCategories = (Object.keys(OFFICIAL_COMMAND_CATEGORY_LABELS) as (keyof typeof OFFICIAL_COMMAND_CATEGORY_LABELS)[]).filter(
    (category) => category !== 'agents',
  );

  const submitScaffold = async (): Promise<void> => {
    setScaffoldError(null);
    setScaffoldNotice('');
    const errors: FieldError[] = [];
    if (!AGENT_ENTRIES.includes(entry)) errors.push({ path: 'entry', message: '请选择 claude/codex/deepseek 之一' });
    if (!confirmScaffold) errors.push({ path: 'confirm', message: '请先勾选确认，再执行官方 init-agents（会写入文件）' });
    setScaffoldErrors(errors);
    if (errors.length > 0) return;
    setScaffoldSaving(true);
    const result = await api.createScaffold({ entry, prompts: withPrompts, confirm: true }, createIdempotencyKey());
    setScaffoldSaving(false);
    if (result.ok) {
      setSelectedScaffold(result.data);
      setScaffoldNotice(
        result.data.status === 'completed'
          ? `已生成脚手架（${agentEntryLabel(result.data.entry)}），共 ${String(result.data.files.length)} 个文件；请到「交接清单」查看产物索引。`
          : '脚手架生成失败，请查看错误详情与官方命令。',
      );
      if (result.data.missing.length > 0) {
        setScaffoldError({
          code: 'SUBPROCESS_ERROR',
          message: `官方产物不完整（缺失 ${String(result.data.missing.length)} 个文件），请核对 Playwright 版本后重新生成。`,
        });
      }
      scaffolds.reload();
    } else {
      setScaffoldError(result.error);
    }
  };

  const loadWorkspace = (): void => {
    setWorkspaceError(null);
    if (workspacePath.trim() === '') {
      setWorkspaceError({ code: 'VALIDATION_FAILED', message: '请输入相对目录，例如 specs/' });
      return;
    }
    if (workspacePath.includes('..') || workspacePath.startsWith('/') || workspacePath.startsWith('\\')) {
      setWorkspaceError({ code: 'PATH_FORBIDDEN', message: '路径必须位于脚手架目录内，不能包含 .. 或以 / 开头' });
      return;
    }
    setWorkspaceQuery({ path: workspacePath.trim(), ...(workspaceScaffoldId ? { scaffoldId: workspaceScaffoldId } : {}) });
  };

  const createSession = async (): Promise<void> => {
    setMcpError(null);
    setMcpNotice('');
    setMcpSaving(true);
    const result = await api.createMcpSession({
      caps,
      headless: mcpHeadless,
      isolated: mcpIsolated,
      browser: mcpBrowser,
    });
    setMcpSaving(false);
    if (result.ok) {
      setMcpNotice(`MCP 会话已创建（${result.data.id}），工具数：${String(result.data.tools.length)}`);
      sessions.reload();
    } else {
      setMcpError(result.error);
    }
  };

  const closeSession = async (session: McpSession): Promise<void> => {
    setMcpError(null);
    const result = await api.closeMcpSession(session.id);
    if (result.ok) {
      setMcpNotice(`已关闭 MCP 会话 ${session.id}`);
      sessions.reload();
    } else {
      setMcpError(result.error);
    }
  };

  const hasNeedsConfirm = (command: string): boolean => (cliCommands.data?.needsConfirm ?? []).includes(command);

  const execCli = async (): Promise<void> => {
    setCliError(null);
    setCliResult(null);
    const errors: FieldError[] = [];
    if (cliCommand === '') errors.push({ path: 'command', message: '请选择官方 CLI 命令' });
    if (hasNeedsConfirm(cliCommand) && !cliConfirm) {
      errors.push({ path: 'confirm', message: '该命令需要二次确认（等价于任意代码执行/受控操作），请勾选确认' });
    }
    const tokenized = tokenizeArgv(cliArgs);
    if (tokenized.error) errors.push({ path: 'args', message: tokenized.error });
    if (cliTimeout === '' || cliTimeout < 1000 || cliTimeout > 120000) {
      errors.push({ path: 'timeoutMs', message: '超时需为 1000~120000 毫秒' });
    }
    setCliErrors(errors);
    if (errors.length > 0) return;

    setCliSaving(true);
    const result = await api.cliExec({
      argv: [cliCommand, ...tokenized.tokens],
      ...(cliSession.trim() !== '' ? { session: cliSession.trim() } : {}),
      ...(cliTimeout === '' ? {} : { timeoutMs: cliTimeout }),
      confirm: cliConfirm,
    });
    setCliSaving(false);
    if (result.ok) setCliResult(result.data);
    else setCliError(result.error);
  };

  const promptCard = (key: AgentPrompt['key'], title: string): ReactElement | null => {
    const prompt = promptByKey.get(key);
    if (!prompt) return null;
    return (
      <div className="prompt-block" key={key}>
        <div className="prompt-head">
          <h4>{title}</h4>
          <span className={`badge badge-${prompt.source === 'official' ? 'success' : 'warning'}`}>
            {prompt.source === 'official' ? '官方产物提示词' : '框架模板（非官方产物）'}
          </span>
          <CopyButton text={prompt.body} label="复制提示词" />
        </div>
        <CodeText>{prompt.body}</CodeText>
      </div>
    );
  };

  return (
    <div className="page">
      <PageHeader
        title="Agent 交接"
        description="收敛为 claude/codex/deepseek 三个 harness 入口；展示推荐 skill 路径与官方产物索引。planner/generator/healer 由外部 coding agent 依据官方定义执行，本框架不内置模型。"
        actions={
          <>
            <a className="button" href={buildHref('/runs')}>
              去运行记录
            </a>
            <button type="button" className="button" onClick={() => scaffolds.reload()} disabled={scaffolds.loading}>
              刷新脚手架
            </button>
          </>
        }
      />

      <Notice tone="warning" title="边界声明：模型能力由外部 coding agent 提供">
        <ul className="tight-list">
          {AGENT_BOUNDARY_NOTES.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <p className="muted">
          官方依据：
          {OFFICIAL_LINKS.map((link, index) => (
            <span key={link.url}>
              {index > 0 ? ' · ' : ''}
              <a href={link.url} target="_blank" rel="noreferrer">
                {link.label}
              </a>
            </span>
          ))}
        </p>
      </Notice>

      <Card
        title="三 harness 入口（Claude Code / Codex / DeepSeek Harness）"
        description="仅展示 GET /agents/harnesses 返回的推荐入口与 skill 放置路径；本框架不安装 skill、不提供安装状态。"
      >
        {harnesses.loading ? <LoadingState label="正在读取 harness 入口…" /> : null}
        {harnesses.error ? <ErrorState error={harnesses.error} title="harness 入口加载失败" onRetry={harnesses.reload} /> : null}
        {!harnesses.loading && !harnesses.error && harnessItems.length === 0 ? (
          <EmptyState title="没有可用的 harness 入口" description="后端未返回 claude/codex/deepseek 三入口，请检查 /agents/harnesses。" />
        ) : null}
        <div className="agent-grid">
          {harnessItems.map((harness) => (
            <HarnessCard key={harness.entry} harness={harness} />
          ))}
        </div>
        {prompts.error ? (
          <Notice tone="warning" title="提示词接口不可用">
            {prompts.error.message}
          </Notice>
        ) : null}
      </Card>

      <Card
        title="Skill 使用（skills/pw-auto-test）"
        description="唯一通用 skill 包：只调用框架 HTTP API；用户自行放置到推荐路径。本框架没有安装 API/安装按钮/安装状态。"
      >
        <p>
          把仓库中的 <code>skills/pw-auto-test/</code> 复制到上方任一推荐的 <code>skillPaths</code>（项目级/用户级/共享级）；具体用法见该目录的{' '}
          <code>SKILL.md</code>。
        </p>
        <div className="row-actions">
          <CopyButton text="skills/pw-auto-test" label="复制 skill 路径" />
          <CopyButton text="node skills/pw-auto-test/scripts/verify.mjs" label="复制只读自检命令" />
        </div>
        <p className="muted">
          只读自检：<code>node skills/pw-auto-test/scripts/verify.mjs</code>（检查框架 health/meta/harnesses 与文件是否就位，不做安装）。
        </p>
        <p className="muted">
          NL 生成任务由外部 harness 通过框架 HTTP API 领取/提交（api-contract §12.3）；本框架不内置模型、不伪造生成结果。
        </p>
      </Card>

      <Card
        title="生成 harness 脚手架（init-agents）"
        description="按三入口调用官方 init-agents：只写文件，不调用任何模型；deepseek 无官方 loop，不执行 init-agents。"
      >
        {scaffoldNotice !== '' ? (
          <Notice tone="success" title="脚手架结果">
            {scaffoldNotice}
          </Notice>
        ) : null}
        {scaffoldError ? (
          <Notice tone="danger" title={`脚手架失败（${scaffoldError.code}）`}>
            {scaffoldError.message}
          </Notice>
        ) : null}
        {scaffoldErrors.length > 0 ? <FormErrors errors={scaffoldErrors} /> : null}

        {harnesses.loading ? (
          <LoadingState label="正在读取 harness 入口…" />
        ) : harnesses.error ? (
          <Notice tone="warning" title="harness 入口不可用">
            {harnesses.error.message}
            <div>
              自检命令：<code>npx playwright init-agents --help</code>
            </div>
          </Notice>
        ) : null}

        <div className="form-grid">
          <SelectField
            id="scaffold-entry"
            label="Harness 入口"
            value={entry}
            options={entryOptions}
            onChange={(value) => setEntry(value as AgentEntry)}
            hint="仅 claude | codex | deepseek；deepseek 无官方 loop（officialLoop=null）"
            required
            error={firstError(scaffoldErrors.filter((error) => error.path === 'entry'))?.message}
          />
          <CheckboxField
            id="scaffold-prompts"
            label="包含提示词模板（--prompts）"
            checked={withPrompts}
            onChange={setWithPrompts}
            hint="会额外产出 plan / generate / heal / coverage 提示词"
          />
          <CheckboxField
            id="scaffold-confirm"
            label="我已确认：生成会在受控目录写入官方定义、.mcp.json、seed.spec.ts 与 specs/README.md"
            checked={confirmScaffold}
            onChange={setConfirmScaffold}
            hint="缺 confirm 时后端返回 428 CONFIRM_REQUIRED"
            error={firstError(scaffoldErrors.filter((error) => error.path === 'confirm'))?.message}
          />
        </div>
        <button type="button" className="button button-primary" onClick={() => void submitScaffold()} disabled={scaffoldSaving}>
          {scaffoldSaving ? '生成中…' : '生成 harness 脚手架'}
        </button>
        <p className="muted">
          生成命令由后端执行并回显完整 argv；前端不拼接命令。官方要求 Playwright 升级后重新生成定义，并人工比对工具白名单变化。
        </p>

        {selectedScaffold ? <ScaffoldDetail scaffold={selectedScaffold} onClose={() => setSelectedScaffold(null)} /> : null}
      </Card>

      <Card title="脚手架历史" description="每次生成的文件清单、缺失项与官方命令回显；点击可查看详情。">
        {scaffolds.loading && scaffolds.items.length === 0 ? <LoadingState label="正在加载脚手架历史…" /> : null}
        {scaffolds.error && scaffolds.items.length === 0 ? (
          <ErrorState error={scaffolds.error} title="脚手架历史加载失败" onRetry={scaffolds.reload} />
        ) : scaffolds.items.length === 0 && !scaffolds.loading ? (
          <EmptyState title="还没有生成过脚手架" description="选择三个 harness 入口之一并确认后生成官方脚手架。" />
        ) : (
          <>
            <TableWrap label="脚手架历史列表">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">脚手架</th>
                    <th scope="col">入口 / 官方 loop</th>
                    <th scope="col">状态</th>
                    <th scope="col">文件 / 缺失</th>
                    <th scope="col">创建时间</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {scaffolds.items.map((scaffold) => (
                    <tr key={scaffold.id}>
                      <td className="mono break-all">{scaffold.id}</td>
                      <td>
                        {agentEntryLabel(scaffold.entry)}
                        <div className="muted mono cell-sub">
                          {scaffold.officialLoop === null ? '无官方 loop' : `--loop=${scaffold.officialLoop}`}
                        </div>
                      </td>
                      <td>
                        <span className={`badge badge-${scaffold.status === 'completed' ? 'success' : 'danger'}`}>
                          {scaffold.status === 'completed' ? '完成' : '失败'}
                        </span>
                        {scaffold.prompts ? <span className="badge badge-info">含提示词</span> : null}
                      </td>
                      <td>
                        {scaffold.files.length} / {scaffold.missing.length}
                        {scaffold.missing.length > 0 ? <div className="field-warning">产物不完整</div> : null}
                      </td>
                      <td>{formatDateTime(scaffold.createdAt)}</td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="button button-small" onClick={() => setSelectedScaffold(scaffold)}>
                            查看详情
                          </button>
                          <button
                            type="button"
                            className="button button-small"
                            onClick={() => {
                              setWorkspaceScaffoldId(scaffold.id);
                              setWorkspacePath('specs/');
                            }}
                          >
                              用于产物索引
                          </button>
                          <CopyButton text={formatArgv(scaffold.command)} label="复制命令" />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <LoadMore
              hasMore={scaffolds.hasMore}
              loading={scaffolds.loadingMore}
              loadedCount={scaffolds.items.length}
              onLoadMore={scaffolds.loadMore}
            />
          </>
        )}
      </Card>

      <Card title="2. 交接清单与产物索引" description="官方约定：specs/ 存测试计划，tests/ 存生成的 Playwright 测试，seed.spec.ts 提供 page 上下文。">
        <ol className="handoff-list">
          {AGENT_HANDOFF_STEPS.map((step) => (
            <li key={step.title}>
              <span className="strong">{step.title}</span>
              <p className="muted">{step.detail}</p>
            </li>
          ))}
        </ol>

        <div className="form-grid">
          <p className="muted">
            提示词来自最近一次带 <code>--prompts</code> 的脚手架产物；优先官方产物，否则为框架模板。
          </p>
        </div>

        {prompts.loading ? <LoadingState label="正在加载提示词…" /> : null}
        {prompts.data && prompts.data.items.length > 0 ? (
          <div className="prompt-list">
            {(['plan', 'generate', 'heal', 'coverage'] as const).map((key) =>
              promptCard(
                key,
                {
                  plan: 'plan（规划）',
                  generate: 'generate（生成）',
                  heal: 'heal（修复）',
                  coverage: 'coverage（覆盖度）',
                }[key],
              ),
            )}
          </div>
        ) : null}
        {!prompts.loading && prompts.data && prompts.data.items.length === 0 ? (
          <EmptyState
            title="暂无提示词"
            description="生成脚手架时勾选「包含提示词模板」，或等后端返回框架模板后重试。"
          />
        ) : null}

        <div className="workspace-box">
          <h3>产物目录索引（只读）</h3>
          {workspaceError ? (
            <Notice tone="danger" title={`路径不可用（${workspaceError.code}）`}>
              {workspaceError.message}
            </Notice>
          ) : null}
          <div className="inline-form">
            <TextField
              id="workspace-path"
              label="相对目录"
              value={workspacePath}
              onChange={setWorkspacePath}
              placeholder="specs/"
              hint="相对脚手架 targetDir；禁止 ..、绝对路径（后端会返回 403 PATH_FORBIDDEN）"
            />
            <SelectField
              id="workspace-scaffold"
              label="脚手架（可选）"
              value={workspaceScaffoldId}
              options={scaffolds.items.map((scaffold) => ({
                value: scaffold.id,
                label: `${agentEntryLabel(scaffold.entry)} · ${formatDateTime(scaffold.createdAt)}`,
              }))}
              onChange={setWorkspaceScaffoldId}
              emptyLabel="使用最新一次"
            />
            <button type="button" className="button" onClick={loadWorkspace} disabled={workspace.loading}>
              {workspace.loading ? '加载中…' : '加载目录'}
            </button>
          </div>
          {workspaceQuery === null ? (
            <p className="muted">点击「加载目录」后读取官方产物；页面不修改任何文件。</p>
          ) : workspace.error ? (
            <ErrorState error={workspace.error} title="目录读取失败" onRetry={loadWorkspace} />
          ) : (workspace.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="目录为空或没有文件" description="确认脚手架已生成，且路径为 specs/ 或 tests/。" />
          ) : (
            <TableWrap label="脚手架产物索引">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">相对路径</th>
                    <th scope="col">大小</th>
                    <th scope="col">修改时间</th>
                  </tr>
                </thead>
                <tbody>
                  {(workspace.data?.items ?? []).map((entry) => (
                    <tr key={entry.path}>
                      <td className="mono break-all">{entry.path}</td>
                      <td>{formatBytes(entry.sizeBytes)}</td>
                      <td>{formatDateTime(entry.mtime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </div>
      </Card>

      <Card
        title="3. MCP 会话（官方 playwright mcp）"
        description="以子进程 + 官方 MCP 协议启动；用于探索、取证与快照，不是回归执行器。工具清单来自官方 tools/list。"
      >
        {mcpNotice !== '' ? (
          <Notice tone="success" title="MCP 操作成功">
            {mcpNotice}
          </Notice>
        ) : null}
        {mcpError ? (
          <Notice tone="danger" title={`MCP 操作失败（${mcpError.code}）`}>
            {mcpError.message}
            {mcpError.code === 'NOT_IMPLEMENTED' || mcpError.code === 'SUBPROCESS_ERROR' ? (
              <div>
                自检命令：<code>npx playwright mcp --help</code>
              </div>
            ) : null}
          </Notice>
        ) : null}

        <div className="form-grid">
          <div className="field">
            <span className="field-label">能力（--caps）</span>
            <div className="check-list-inline">
              {['testing', 'storage', 'network'].map((cap) => (
                <label className="checkbox" key={cap} htmlFor={`mcp-cap-${cap}`}>
                  <input
                    id={`mcp-cap-${cap}`}
                    type="checkbox"
                    checked={caps.includes(cap)}
                    onChange={(event) =>
                      setCaps((prev) => (event.target.checked ? [...prev, cap] : prev.filter((item) => item !== cap)))
                    }
                  />
                  <span>{cap}</span>
                </label>
              ))}
            </div>
            <p className="field-hint">默认 testing/storage/network；危险工具（browser_run_code_unsafe、browser_evaluate 等）默认禁用。</p>
          </div>
          <CheckboxField id="mcp-headless" label="无头模式（headless）" checked={mcpHeadless} onChange={setMcpHeadless} />
          <CheckboxField id="mcp-isolated" label="隔离会话（isolated）" checked={mcpIsolated} onChange={setMcpIsolated} />
          <SelectField
            id="mcp-browser"
            label="浏览器"
            value={mcpBrowser}
            options={BROWSER_OPTIONS}
            onChange={setMcpBrowser}
          />
        </div>
        <button type="button" className="button button-primary" onClick={() => void createSession()} disabled={mcpSaving}>
          {mcpSaving ? '启动中…' : '创建 MCP 会话'}
        </button>
        <p className="muted">最多同时 2 个会话（超过返回 429 TOO_MANY_MCP_SESSIONS）；关闭时会强杀子进程。</p>

        {sessions.loading && (sessions.data?.items.length ?? 0) === 0 ? <LoadingState label="正在加载 MCP 会话…" /> : null}
        {sessions.error ? <ErrorState error={sessions.error} title="MCP 会话列表加载失败" onRetry={sessions.reload} /> : null}
        {(sessions.data?.items.length ?? 0) > 0 ? (
          <div className="session-list">
            {(sessions.data?.items ?? []).map((session) => (
              <article className="session-card" key={session.id}>
                <header className="session-head">
                  <div>
                    <h4 className="mono break-all">{session.id}</h4>
                    <p className="muted">
                      状态：<span className={`badge badge-${session.status === 'ready' ? 'success' : session.status === 'error' ? 'danger' : 'neutral'}`}>{session.status}</span>
                      {session.serverInfo ? ` · ${session.serverInfo.name} ${session.serverInfo.version}` : ''}
                      {session.protocolVersion ? ` · 协议 ${session.protocolVersion}` : ''}
                    </p>
                    <p className="muted">
                      工具数：{session.tools.length} · caps：{session.caps.join('、') || '默认'} · headless：{session.headless ? '是' : '否'} · PID：{session.pid ?? '—'}
                    </p>
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="button button-small"
                      aria-expanded={expandedSession === session.id}
                      onClick={() => setExpandedSession(expandedSession === session.id ? null : session.id)}
                    >
                      {expandedSession === session.id ? '收起工具清单' : '查看工具清单'}
                    </button>
                    <ConfirmButton
                      label="关闭会话"
                      question={`关闭 MCP 会话 ${session.id}？会强杀子进程。`}
                      confirmLabel="确认关闭"
                      onConfirm={() => closeSession(session)}
                    />
                  </div>
                </header>
                {session.error ? <Notice tone="danger" title={`会话错误（${session.error.code}）`}>{session.error.message}</Notice> : null}
                {expandedSession === session.id ? (
                  session.tools.length === 0 ? (
                    <p className="muted">该会话尚未返回工具清单。</p>
                  ) : (
                    <TableWrap label="MCP 工具清单">
                      <table className="table">
                        <thead>
                          <tr>
                            <th scope="col">工具</th>
                            <th scope="col">描述</th>
                          </tr>
                        </thead>
                        <tbody>
                          {session.tools.map((tool) => (
                            <tr key={tool.name}>
                              <td className="mono">{tool.name}</td>
                              <td>{tool.description ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                  )
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
      </Card>

      <Card
        title="4. CLI 命令面板（官方 playwright cli）"
        description="受控执行官方 CLI 命令：argv[0] 必须在白名单内；install / attach 等副作用或未证实命令一律拒绝。"
      >
        {cliCommands.loading ? <LoadingState label="正在加载命令白名单…" /> : null}
        {cliCommands.error ? (
          <Notice tone="warning" title="命令白名单不可用">
            {cliCommands.error.message}
          </Notice>
        ) : null}
        {cliCommands.data ? (
          <div className="cli-catalog">
            <p>
              <span className="label">允许命令：</span>
              <span className="mono">{cliCommands.data.allow.join('、') || '—'}</span>
            </p>
            <p>
              <span className="label">需二次确认：</span>
              <span className="mono">{cliCommands.data.needsConfirm.join('、') || '—'}</span>
            </p>
            <p>
              <span className="label">禁止命令：</span>
              <span className="mono">{cliCommands.data.deny.join('、') || '—'}</span>
            </p>
          </div>
        ) : null}

        <CliResultNotice result={cliResult} />
        {cliError ? (
          <Notice tone="danger" title={`CLI 执行失败（${cliError.code}）`}>
            {cliError.message}
          </Notice>
        ) : null}
        {cliErrors.length > 0 ? <FormErrors errors={cliErrors} /> : null}
        <div className="form-grid">
          <SelectField
            id="cli-command"
            label="命令"
            value={cliCommand}
            options={[...(cliCommands.data?.allow ?? []), ...(cliCommands.data?.needsConfirm ?? [])].map((command) => ({
              value: command,
              label: command + ((cliCommands.data?.needsConfirm ?? []).includes(command) ? '（需确认）' : ''),
            }))}
            onChange={(value) => {
              setCliCommand(value);
              setCliConfirm(false);
            }}
            emptyLabel="请选择命令"
            hint="来自后端白名单；未在名单内的命令不会出现在这里"
            required
            error={firstError(cliErrors.filter((error) => error.path === 'command'))?.message}
          />
          <TextField
            id="cli-args"
            label="参数（空格分隔，可用引号）"
            value={cliArgs}
            onChange={setCliArgs}
            placeholder="--json 或 http://127.0.0.1:4174/"
            hint="提交前由前端分词为 argv 数组，后端以 spawn(argv) 执行（不经 shell）"
            error={firstError(cliErrors.filter((error) => error.path === 'args'))?.message}
          />
          <TextField
            id="cli-session"
            label="会话名（-s）"
            value={cliSession}
            onChange={setCliSession}
            hint="对应 --session；留空则由后端使用默认会话"
          />
          <NumberField
            id="cli-timeout"
            label="超时（毫秒）"
            value={cliTimeout}
            onChange={setCliTimeout}
            min={1000}
            max={120000}
            hint="1000~120000"
            error={firstError(cliErrors.filter((error) => error.path === 'timeoutMs'))?.message}
          />
          <CheckboxField
            id="cli-confirm"
            label="二次确认（run-code / eval 等危险命令必填）"
            checked={cliConfirm}
            onChange={setCliConfirm}
            hint="还需要后端启用 PW_ENABLE_UNSAFE_TOOLS=1，否则返回 403 CAPABILITY_DISABLED"
            error={firstError(cliErrors.filter((error) => error.path === 'confirm'))?.message}
          />
        </div>
        <button
          type="button"
          className="button button-primary"
          onClick={() => void execCli()}
          disabled={cliSaving || cliCommand === '' || cliCommands.data === undefined}
        >
          {cliSaving ? '执行中…' : '执行命令'}
        </button>

        {cliResult ? (
          <div className="cli-result">
            <h3>执行结果</h3>
            <KeyValueList
              items={[
                { label: '退出码', value: cliResult.exitCode },
                { label: '耗时', value: `${String(cliResult.durationMs)} 毫秒` },
                { label: '产物', value: cliResult.artifacts.length === 0 ? '无' : cliResult.artifacts.map((artifact) => `${artifact.kind}: ${artifact.path}`).join('；') },
              ]}
            />
            {cliResult.stdout !== '' ? (
              <>
                <p className="label">stdout</p>
                <CodeText>{cliResult.stdout}</CodeText>
              </>
            ) : null}
            {cliResult.stderr !== '' ? (
              <>
                <p className="label">stderr</p>
                <CodeText>{cliResult.stderr}</CodeText>
              </>
            ) : null}
            {cliResult.json !== null && cliResult.json !== undefined ? (
              <>
                <p className="label">--json 解析结果</p>
                <CodeText>{JSON.stringify(cliResult.json, null, 2)}</CodeText>
              </>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card title="官方命令速查（可复制）" description="全部命令来自 @playwright/test 1.65.0 内置入口；可直接在仓库外终端核对。">
        {commandCategories.map((category) => {
          const commands = OFFICIAL_COMMANDS.filter((command) => command.category === category);
          if (commands.length === 0) return null;
          return (
            <div className="command-group" key={category}>
              <h3>{OFFICIAL_COMMAND_CATEGORY_LABELS[category]}</h3>
              <ul className="command-list">
                {commands.map((command) => (
                  <li key={command.id}>
                    <div className="command-info">
                      <span className="strong">{command.label}</span>
                      <code className="mono break-all">{command.command}</code>
                      <p className="muted">{command.description}</p>
                      {command.caution ? <p className="field-warning">{command.caution}</p> : null}
                    </div>
                    <CopyButton text={command.command} label="复制" />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        <p className="muted">
          注意：本页所有命令均需本机已安装 @playwright/test 1.65.0；框架不执行任何对外发布或安装类命令（install / attach 已被后端白名单禁止）。
        </p>
      </Card>
    </div>
  );
}

export function HarnessCard({ harness }: { harness: AgentHarness }) {
  return (
    <article className="agent-card harness-card">
      <h3>
        {harness.label} <span className="mono muted">({harness.entry})</span>
      </h3>
      <p>
        officialLoop：
        {harness.officialLoop === null ? (
          <span className="muted">无（DeepSeek 无官方 loop，不伪造）</span>
        ) : (
          <code className="mono">{harness.officialLoop}</code>
        )}
      </p>
      <p>
        <span className="badge badge-success">requiresMcp: false</span>{' '}
        <span className="muted">skill 只调框架 HTTP API，无需 MCP 配置</span>
      </p>
      <p className="label">推荐 skill 放置路径（用户自行复制，框架不安装）</p>
      <ul className="tight-list">
        {harness.skillPaths.map((item) => (
          <li key={`${item.scope}:${item.path}`}>
            <span className="muted">{HARNESS_SCOPE_LABELS[item.scope] ?? item.scope}：</span>
            <code className="mono break-all">{item.path}</code>{' '}
            <CopyButton text={item.path} label="复制路径" />
          </li>
        ))}
      </ul>
      {harness.notes ? <p className="muted">{harness.notes}</p> : null}
      <p className="muted">
        请把 <code>skills/pw-auto-test/</code> 复制到上述路径之一；框架没有安装按钮/安装状态。
      </p>
    </article>
  );
}

function ScaffoldDetail({ scaffold, onClose }: { scaffold: Scaffold; onClose: () => void }) {
  return (
    <div className="scaffold-detail">
      <h3>脚手架详情</h3>
      <KeyValueList
        items={[
          { label: 'ID', value: <span className="mono break-all">{scaffold.id}</span> },
          { label: '入口', value: `${agentEntryLabel(scaffold.entry)}（${scaffold.entry}）` },
          {
            label: '官方 loop',
            value: scaffold.officialLoop === null ? '无（不伪造）' : <span className="mono">--loop={scaffold.officialLoop}</span>,
          },
          { label: '目标目录', value: <span className="mono break-all">{scaffold.targetDir}</span> },
          { label: '状态', value: scaffold.status === 'completed' ? '完成' : '失败' },
          {
            label: '官方命令',
            value:
              scaffold.command.length === 0 ? (
                <span className="muted">未执行 init-agents（deepseek 无官方 loop）</span>
              ) : (
                <span className="command-line">
                  <code className="mono break-all">{scaffold.command.join(' ')}</code>
                  <CopyButton text={formatArgv(scaffold.command)} label="复制命令" />
                </span>
              ),
          },
          { label: '说明', value: scaffold.notes ?? '—' },
          { label: '创建 / 完成时间', value: `${formatDateTime(scaffold.createdAt)} / ${formatDateTime(scaffold.finishedAt)}` },
        ]}
      />
      {scaffold.error ? (
        <Notice tone="danger" title={`脚手架错误（${scaffold.error.code}）`}>
          {scaffold.error.message}
        </Notice>
      ) : null}
      {scaffold.missing.length > 0 ? (
        <Notice tone="warning" title="官方产物不完整">
          <p>缺失文件（相对 targetDir）：</p>
          <ul className="tight-list">
            {scaffold.missing.map((path) => (
              <li key={path} className="mono">
                {path}
              </li>
            ))}
          </ul>
          <p className="muted">请核对 Playwright 版本（官方要求升级后重新生成），不要假设缺失文件一定存在。</p>
        </Notice>
      ) : null}
      <TableWrap label="脚手架文件清单">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">相对路径</th>
              <th scope="col">大小</th>
              <th scope="col">SHA-256（前 12 位）</th>
            </tr>
          </thead>
          <tbody>
            {scaffold.files.map((file) => (
              <tr key={file.path}>
                <td className="mono break-all">{file.path}</td>
                <td>{formatBytes(file.sizeBytes)}</td>
                <td className="mono">{shortId(file.sha256, 12)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <button type="button" className="button" onClick={onClose}>
        收起详情
      </button>
    </div>
  );
}

function CliResultNotice({ result }: { result: CliExecResult | null }): ReactElement | null {
  if (!result) return null;
  return (
    <Notice
      tone={result.exitCode === 0 ? 'success' : 'warning'}
      title={result.exitCode === 0 ? 'CLI 命令执行成功' : `CLI 命令退出码为 ${String(result.exitCode)}`}
    >
      官方 CLI 的 stdout/stderr 与 --json 结果见下方；产物路径由后端登记。
    </Notice>
  );
}