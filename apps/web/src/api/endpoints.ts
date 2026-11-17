/**
 * 端点封装：只暴露 docs/api-contract.md 已冻结的路径与方法。
 * 每个方法返回 ApiResult（成功已解包 data，失败带结构化中文错误）。
 */
import { ApiClient } from './http.ts';
import type { ApiRequestOptions, ApiResult } from './http.ts';
import type {
  AgentEntryInfo,
  AgentHarness,
  AgentLoopInfo,
  AgentPrompt,
  Artifact,
  ArtifactKind,
  Baseline,
  BaselineCreateInput,
  BaselineScope,
  Case,
  CaseInput,
  CaseListItem,
  CaseStatus,
  CaseValidateResult,
  CellValue,
  CliCommands,
  CliExecInput,
  CliExecResult,
  Comparison,
  ComparisonDetail,
  Dataset,
  DatasetCreateInput,
  DatasetRow,
  DatasetRowInput,
  Health,
  ItemOutcomeValue,
  McpCallResult,
  McpSession,
  McpSessionCreateInput,
  Meta,
  NlGeneration,
  NlGenerationStatus,
  NlSource,
  NlSpecPreview,
  PageResult,
  Run,
  RunCreateRequest,
  RunItem,
  RunStatus,
  Scaffold,
  ScaffoldCreateInput,
  Suite,
  SuiteCreateInput,
  WorkspaceEntry,
} from './types.ts';

export interface ListCasesQuery {
  limit?: number;
  cursor?: string;
  q?: string;
  status?: CaseStatus;
  tag?: string;
}

export interface ListDatasetsQuery {
  limit?: number;
  cursor?: string;
}

export interface ListRowsQuery {
  limit?: number;
  cursor?: string;
  enabled?: boolean;
}

export interface ListSuitesQuery {
  limit?: number;
  cursor?: string;
  q?: string;
}

export interface ListRunsQuery {
  limit?: number;
  cursor?: string;
  status?: RunStatus;
  caseId?: string;
  suiteId?: string;
  order?: 'asc' | 'desc';
}

export interface ListRunItemsQuery {
  limit?: number;
  cursor?: string;
  /** 合同 §5.4：按结果状态过滤（对应 outcome） */
  status?: ItemOutcomeValue;
  rowIndex?: number;
}

export interface ListArtifactsQuery {
  limit?: number;
  cursor?: string;
  kind?: ArtifactKind;
}

export interface ListBaselinesQuery {
  scope?: BaselineScope;
  scopeId?: string;
  archived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ListComparisonsQuery {
  runId?: string;
  baselineId?: string;
  limit?: number;
  cursor?: string;
}

export interface AgentWorkspaceQuery {
  path: string;
  scaffoldId?: string;
}

/** GET /api/v1/agents/workspace 的 data 形态（§7.2） */
export interface AgentWorkspaceResponse {
  items: WorkspaceEntry[];
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

export class Api {
  constructor(readonly client: ApiClient) {}

  // ── §1 健康与元信息 ────────────────────────────────────────────────
  health(): Promise<ApiResult<Health>> {
    return this.client.get<Health>('/api/health');
  }

  meta(): Promise<ApiResult<Meta>> {
    return this.client.get<Meta>('/api/v1/meta');
  }

  // ── §2 用例 ────────────────────────────────────────────────────────
  listCases(query: ListCasesQuery = {}): Promise<ApiResult<PageResult<CaseListItem>>> {
    return this.client.get<PageResult<CaseListItem>>('/api/v1/cases', { query: { ...query } });
  }

  createCase(input: CaseInput): Promise<ApiResult<Case>> {
    return this.client.post<Case>('/api/v1/cases', input);
  }

  getCase(caseId: string): Promise<ApiResult<Case>> {
    return this.client.get<Case>(`/api/v1/cases/${seg(caseId)}`);
  }

  /** PATCH 必须带 If-Match: "<version>"（§2.6，含引号） */
  patchCase(caseId: string, version: number, patch: CaseInput): Promise<ApiResult<Case>> {
    return this.client.patch<Case>(`/api/v1/cases/${seg(caseId)}`, patch, {
      headers: { 'If-Match': `"${String(version)}"` },
    });
  }

  deleteCase(caseId: string): Promise<ApiResult<void>> {
    return this.client.delete<void>(`/api/v1/cases/${seg(caseId)}`);
  }

  validateCase(caseId: string, body: { datasetId?: string } = {}): Promise<ApiResult<CaseValidateResult>> {
    return this.client.post<CaseValidateResult>(`/api/v1/cases/${seg(caseId)}/validate`, body);
  }

  // ── §12 NL-first ───────────────────────────────────────────────────
  getCaseNl(caseId: string): Promise<ApiResult<NlSource>> {
    return this.client.get<NlSource>(`/api/v1/cases/${seg(caseId)}/nl`);
  }

  putCaseNl(caseId: string, text: string): Promise<ApiResult<NlSource>> {
    return this.client.put<NlSource>(`/api/v1/cases/${seg(caseId)}/nl`, { text });
  }

  deleteCaseNl(caseId: string): Promise<ApiResult<void>> {
    return this.client.delete<void>(`/api/v1/cases/${seg(caseId)}/nl`);
  }

  createNlGeneration(
    caseId: string,
    input: { generator?: 'agent' | 'rule'; hints?: Record<string, string>; force?: boolean } = {},
  ): Promise<ApiResult<NlGeneration>> {
    return this.client.post<NlGeneration>(`/api/v1/cases/${seg(caseId)}/nl/generations`, {
      generator: 'agent',
      ...input,
    });
  }

  listNlGenerations(
    caseId: string,
    query: { limit?: number; cursor?: string; status?: string } = {},
  ): Promise<ApiResult<PageResult<NlGeneration>>> {
    return this.client.get<PageResult<NlGeneration>>(`/api/v1/cases/${seg(caseId)}/nl/generations`, {
      query: { ...query },
    });
  }

  getNlGeneration(caseId: string, generationId: string): Promise<ApiResult<NlGeneration>> {
    return this.client.get<NlGeneration>(`/api/v1/cases/${seg(caseId)}/nl/generations/${seg(generationId)}`);
  }

  acceptNlGeneration(
    caseId: string,
    generationId: string,
    input: { force?: boolean; code?: boolean } = {},
  ): Promise<ApiResult<{ case: Case; generation: NlGeneration }>> {
    return this.client.post<{ case: Case; generation: NlGeneration }>(
      `/api/v1/cases/${seg(caseId)}/nl/generations/${seg(generationId)}/accept`,
      { force: false, code: false, ...input },
    );
  }

  rejectNlGeneration(caseId: string, generationId: string, reason: string): Promise<ApiResult<NlGeneration>> {
    return this.client.post<NlGeneration>(`/api/v1/cases/${seg(caseId)}/nl/generations/${seg(generationId)}/reject`, {
      reason,
    });
  }

  cancelNlGeneration(caseId: string, generationId: string): Promise<ApiResult<NlGeneration>> {
    return this.client.post<NlGeneration>(`/api/v1/cases/${seg(caseId)}/nl/generations/${seg(generationId)}/cancel`);
  }

  /** 只读编译预览（§12.5；必须带 preview=1） */
  previewCaseSpec(caseId: string): Promise<ApiResult<NlSpecPreview>> {
    return this.client.get<NlSpecPreview>(`/api/v1/cases/${seg(caseId)}/spec`, { query: { preview: 1 } });
  }

  // ── §3 数据集 ──────────────────────────────────────────────────────
  listDatasets(caseId: string, query: ListDatasetsQuery = {}): Promise<ApiResult<PageResult<Dataset>>> {
    return this.client.get<PageResult<Dataset>>(`/api/v1/cases/${seg(caseId)}/datasets`, { query: { ...query } });
  }

  createDataset(caseId: string, input: DatasetCreateInput): Promise<ApiResult<Dataset>> {
    return this.client.post<Dataset>(`/api/v1/cases/${seg(caseId)}/datasets`, input);
  }

  getDataset(datasetId: string): Promise<ApiResult<Dataset>> {
    return this.client.get<Dataset>(`/api/v1/datasets/${seg(datasetId)}`);
  }

  patchDataset(datasetId: string, patch: { name?: string }): Promise<ApiResult<Dataset>> {
    return this.client.patch<Dataset>(`/api/v1/datasets/${seg(datasetId)}`, patch);
  }

  deleteDataset(datasetId: string): Promise<ApiResult<void>> {
    return this.client.delete<void>(`/api/v1/datasets/${seg(datasetId)}`);
  }

  listDatasetRows(datasetId: string, query: ListRowsQuery = {}): Promise<ApiResult<PageResult<DatasetRow>>> {
    return this.client.get<PageResult<DatasetRow>>(`/api/v1/datasets/${seg(datasetId)}/rows`, { query: { ...query } });
  }

  /** PUT rows 全量替换（行号重排为 0..n-1，§3.2） */
  replaceDatasetRows(datasetId: string, rows: DatasetRowInput[]): Promise<ApiResult<Dataset>> {
    return this.client.put<Dataset>(`/api/v1/datasets/${seg(datasetId)}/rows`, { rows });
  }

  // ── §4 套件 ────────────────────────────────────────────────────────
  listSuites(query: ListSuitesQuery = {}): Promise<ApiResult<PageResult<Suite>>> {
    return this.client.get<PageResult<Suite>>('/api/v1/suites', { query: { ...query } });
  }

  createSuite(input: SuiteCreateInput): Promise<ApiResult<Suite>> {
    return this.client.post<Suite>('/api/v1/suites', input);
  }

  getSuite(suiteId: string): Promise<ApiResult<Suite>> {
    return this.client.get<Suite>(`/api/v1/suites/${seg(suiteId)}`);
  }

  patchSuite(suiteId: string, patch: { name?: string; description?: string }): Promise<ApiResult<Suite>> {
    return this.client.patch<Suite>(`/api/v1/suites/${seg(suiteId)}`, patch);
  }

  replaceSuiteCases(suiteId: string, caseIds: string[]): Promise<ApiResult<Suite>> {
    return this.client.put<Suite>(`/api/v1/suites/${seg(suiteId)}/cases`, { caseIds });
  }

  deleteSuite(suiteId: string): Promise<ApiResult<void>> {
    return this.client.delete<void>(`/api/v1/suites/${seg(suiteId)}`);
  }

  // ── §5 运行与结果 ──────────────────────────────────────────────────
  createRun(input: RunCreateRequest, idempotencyKey?: string): Promise<ApiResult<Run>> {
    const options: Omit<ApiRequestOptions, 'method' | 'body'> = idempotencyKey
      ? { headers: { 'Idempotency-Key': idempotencyKey } }
      : {};
    return this.client.post<Run>('/api/v1/runs', input, options);
  }

  listRuns(query: ListRunsQuery = {}): Promise<ApiResult<PageResult<Run>>> {
    return this.client.get<PageResult<Run>>('/api/v1/runs', { query: { ...query } });
  }

  getRun(runId: string): Promise<ApiResult<Run>> {
    return this.client.get<Run>(`/api/v1/runs/${seg(runId)}`);
  }

  cancelRun(runId: string): Promise<ApiResult<Run>> {
    return this.client.post<Run>(`/api/v1/runs/${seg(runId)}/cancel`);
  }

  listRunItems(runId: string, query: ListRunItemsQuery = {}): Promise<ApiResult<PageResult<RunItem>>> {
    return this.client.get<PageResult<RunItem>>(`/api/v1/runs/${seg(runId)}/items`, { query: { ...query } });
  }

  getRunItem(runId: string, itemKey: string): Promise<ApiResult<RunItem>> {
    return this.client.get<RunItem>(`/api/v1/runs/${seg(runId)}/items/${seg(itemKey)}`);
  }

  listArtifacts(runId: string, query: ListArtifactsQuery = {}): Promise<ApiResult<PageResult<Artifact>>> {
    return this.client.get<PageResult<Artifact>>(`/api/v1/runs/${seg(runId)}/artifacts`, { query: { ...query } });
  }

  /** 产物内容地址：只能按已登记产物 id 访问（§5.5），禁止拼路径 */
  artifactContentUrl(runId: string, artifactId: string): string {
    return this.client.buildUrl(`/api/v1/runs/${seg(runId)}/artifacts/${seg(artifactId)}/content`);
  }

  /** SSE 可选端点；未实现时后端返回 501，前端退回轮询（§0.4） */
  runEventsUrl(runId: string): string {
    return this.client.buildUrl(`/api/v1/runs/${seg(runId)}/events`);
  }

  // ── §6 回归 ────────────────────────────────────────────────────────
  listBaselines(query: ListBaselinesQuery = {}): Promise<ApiResult<PageResult<Baseline>>> {
    return this.client.get<PageResult<Baseline>>('/api/v1/baselines', { query: { ...query } });
  }

  createBaseline(input: BaselineCreateInput): Promise<ApiResult<Baseline>> {
    return this.client.post<Baseline>('/api/v1/baselines', input);
  }

  getBaseline(baselineId: string): Promise<ApiResult<Baseline>> {
    return this.client.get<Baseline>(`/api/v1/baselines/${seg(baselineId)}`);
  }

  /** 切换默认基线（§6.1） */
  setDefaultBaseline(baselineId: string): Promise<ApiResult<Baseline>> {
    return this.client.post<Baseline>(`/api/v1/baselines/${seg(baselineId)}/default`);
  }

  /** 归档必须带 { confirm: true }，否则 428 CONFIRM_REQUIRED（§6.1） */
  archiveBaseline(baselineId: string): Promise<ApiResult<Baseline>> {
    return this.client.post<Baseline>(`/api/v1/baselines/${seg(baselineId)}/archive`, { confirm: true });
  }

  createComparison(input: { baselineId: string; runId: string }): Promise<ApiResult<Comparison>> {
    return this.client.post<Comparison>('/api/v1/comparisons', input);
  }

  getComparison(
    comparisonId: string,
    query: { itemsLimit?: number; itemsCursor?: string } = {},
  ): Promise<ApiResult<ComparisonDetail>> {
    return this.client.get<ComparisonDetail>(`/api/v1/comparisons/${seg(comparisonId)}`, {
      query: { ...query },
    });
  }

  listComparisons(query: ListComparisonsQuery = {}): Promise<ApiResult<PageResult<Comparison>>> {
    return this.client.get<PageResult<Comparison>>('/api/v1/comparisons', { query: { ...query } });
  }

  // ── §7 Agent 交接 ──────────────────────────────────────────────────
  agentLoops(): Promise<ApiResult<{ items: AgentLoopInfo[] }>> {
    return this.client.get<{ items: AgentLoopInfo[] }>('/api/v1/agents/loops');
  }

  /** 三 harness 推荐入口（唯一公开 agent 入口；无安装态） */
  agentHarnesses(): Promise<ApiResult<{ items: AgentHarness[] }>> {
    return this.client.get<{ items: AgentHarness[] }>('/api/v1/agents/harnesses');
  }

  createScaffold(input: ScaffoldCreateInput, idempotencyKey?: string): Promise<ApiResult<Scaffold>> {
    const options: Omit<ApiRequestOptions, 'method' | 'body'> = idempotencyKey
      ? { headers: { 'Idempotency-Key': idempotencyKey } }
      : {};
    return this.client.post<Scaffold>('/api/v1/agents/scaffolds', input, options);
  }

  listScaffolds(query: { limit?: number; cursor?: string } = {}): Promise<ApiResult<PageResult<Scaffold>>> {
    return this.client.get<PageResult<Scaffold>>('/api/v1/agents/scaffolds', { query: { ...query } });
  }

  getScaffold(scaffoldId: string): Promise<ApiResult<Scaffold>> {
    return this.client.get<Scaffold>(`/api/v1/agents/scaffolds/${seg(scaffoldId)}`);
  }

  agentPrompts(loop?: string): Promise<ApiResult<{ items: AgentPrompt[] }>> {
    return this.client.get<{ items: AgentPrompt[] }>('/api/v1/agents/prompts', {
      query: loop ? { loop } : undefined,
    });
  }

  agentWorkspace(query: AgentWorkspaceQuery): Promise<ApiResult<AgentWorkspaceResponse>> {
    return this.client.get<AgentWorkspaceResponse>('/api/v1/agents/workspace', { query: { ...query } });
  }

  // ── §8 MCP 会话 ────────────────────────────────────────────────────
  listMcpSessions(): Promise<ApiResult<{ items: McpSession[] }>> {
    return this.client.get<{ items: McpSession[] }>('/api/v1/mcp/sessions');
  }

  createMcpSession(input: McpSessionCreateInput): Promise<ApiResult<McpSession>> {
    return this.client.post<McpSession>('/api/v1/mcp/sessions', input);
  }

  getMcpSession(sessionId: string): Promise<ApiResult<McpSession>> {
    return this.client.get<McpSession>(`/api/v1/mcp/sessions/${seg(sessionId)}`);
  }

  callMcpTool(sessionId: string, input: { tool: string; arguments: Record<string, unknown> }): Promise<ApiResult<McpCallResult>> {
    return this.client.post<McpCallResult>(`/api/v1/mcp/sessions/${seg(sessionId)}/calls`, input);
  }

  closeMcpSession(sessionId: string): Promise<ApiResult<void>> {
    return this.client.delete<void>(`/api/v1/mcp/sessions/${seg(sessionId)}`);
  }

  // ── §9 CLI 执行 ────────────────────────────────────────────────────
  cliCommands(): Promise<ApiResult<CliCommands>> {
    return this.client.get<CliCommands>('/api/v1/cli/commands');
  }

  cliExec(input: CliExecInput): Promise<ApiResult<CliExecResult>> {
    return this.client.post<CliExecResult>('/api/v1/cli/exec', input);
  }
}

/** 默认实例：同源请求 + 开发态 Vite 代理；不在前端保存任何密钥 */
export const defaultApi = new Api(new ApiClient());

export function createApi(client: ApiClient): Api {
  return new Api(client);
}

/** 拉取数据集全部行（≤500 行，分页上限 100） */
export async function loadAllDatasetRows(
  api: Api,
  datasetId: string,
  maxRows = 500,
): Promise<{ ok: true; rows: DatasetRow[] } | { ok: false; error: { code: string; message: string } }> {
  const rows: DatasetRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await api.listDatasetRows(datasetId, { limit: 100, cursor });
    if (!result.ok) return { ok: false, error: result.error };
    rows.push(...result.data.items);
    if (!result.data.hasMore || result.data.nextCursor === null) break;
    cursor = result.data.nextCursor;
    if (rows.length > maxRows) break;
  }
  return { ok: true, rows: rows.slice(0, maxRows) };
}

/** 把任意单元格值转成可编辑文本 */
export function cellToText(value: CellValue): string {
  if (value === null) return '';
  return String(value);
}

/** 列名合法性（合同 §3.1：1..60 字符、不含 {{ }}） */
export function isValidColumnName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 60 && !trimmed.includes('{{') && !trimmed.includes('}}');
}
