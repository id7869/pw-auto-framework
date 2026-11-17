#!/usr/bin/env node
/**
 * pw-auto-test · 零依赖 API 客户端（Node 18+ 内置 fetch）。
 *
 * 设计约束（SKILL.md §0/§1）：
 * - 只调用本机 pw-auto-framework HTTP API；不直连浏览器、不直接运行 `playwright test`、不调用任何模型端点。
 * - 成功信封 `{data}` 自动解包；错误信封 `{error:{code,message,details,requestId}}` 抛 ApiError。
 * - 默认 base URL：$PW_API_BASE 或 http://127.0.0.1:8787。
 *
 * 直接运行（调试用）：
 *   node api.mjs GET /api/v1/agents/harnesses
 *   node api.mjs POST /api/v1/cases '{"name":"demo","mode":"steps"}'
 */

import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = process.env.PW_API_BASE ?? 'http://127.0.0.1:8787';

export class ApiError extends Error {
  constructor(status, code, message, details, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.body = body;
  }
}

export class PwAutoApi {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.requestId = null;
  }

  async raw(method, path, body) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      this.requestId = response.headers.get('x-request-id');
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        const error = parsed?.error;
        throw new ApiError(
          response.status,
          error?.code ?? `HTTP_${response.status}`,
          error?.message ?? `${method} ${path} 失败（HTTP ${response.status}）`,
          error?.details,
          parsed ?? text,
        );
      }
      return { data: parsed?.data ?? null, meta: parsed?.meta ?? null, headers: response.headers };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.name === 'AbortError') {
        throw new ApiError(0, 'REQUEST_TIMEOUT', `${method} ${path} 超时（${this.timeoutMs}ms）`);
      }
      throw new ApiError(0, 'NETWORK_ERROR', `${method} ${path} 网络失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async request(method, path, body) {
    return (await this.raw(method, path, body)).data;
  }

  // ── 预检 ───────────────────────────────────────────────────────────────
  health() {
    return this.request('GET', '/api/health');
  }

  meta() {
    return this.request('GET', '/api/v1/meta');
  }

  harnesses() {
    return this.request('GET', '/api/v1/agents/harnesses');
  }

  // ── 用例 / NL ─────────────────────────────────────────────────────────
  createCase(payload) {
    return this.request('POST', '/api/v1/cases', payload);
  }

  getCase(caseId) {
    return this.request('GET', `/api/v1/cases/${encodeURIComponent(caseId)}`);
  }

  deleteCase(caseId) {
    return this.request('DELETE', `/api/v1/cases/${encodeURIComponent(caseId)}`);
  }

  putNl(caseId, text) {
    return this.request('PUT', `/api/v1/cases/${encodeURIComponent(caseId)}/nl`, { text });
  }

  getNl(caseId) {
    return this.request('GET', `/api/v1/cases/${encodeURIComponent(caseId)}/nl`);
  }

  validateCase(caseId, datasetId) {
    return this.request(
      'POST',
      `/api/v1/cases/${encodeURIComponent(caseId)}/validate`,
      datasetId === undefined ? {} : { datasetId },
    );
  }

  specPreview(caseId) {
    return this.request('GET', `/api/v1/cases/${encodeURIComponent(caseId)}/spec?preview=1`);
  }

  // ── 数据集 ─────────────────────────────────────────────────────────────
  createDataset(caseId, payload) {
    return this.request('POST', `/api/v1/cases/${encodeURIComponent(caseId)}/datasets`, payload);
  }

  getDataset(datasetId) {
    return this.request('GET', `/api/v1/datasets/${encodeURIComponent(datasetId)}`);
  }

  getDatasetRows(datasetId, query = {}) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) qs.set(key, String(value));
    return this.request('GET', `/api/v1/datasets/${encodeURIComponent(datasetId)}/rows${qs.size ? `?${qs}` : ''}`);
  }

  // ── 生成任务 ───────────────────────────────────────────────────────────
  createGeneration(caseId, payload = { generator: 'agent' }) {
    return this.request('POST', `/api/v1/cases/${encodeURIComponent(caseId)}/nl/generations`, payload);
  }

  listCaseGenerations(caseId, query = {}) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) qs.set(key, String(value));
    return this.request('GET', `/api/v1/cases/${encodeURIComponent(caseId)}/nl/generations${qs.size ? `?${qs}` : ''}`);
  }

  getGeneration(caseId, generationId) {
    return this.request(
      'GET',
      `/api/v1/cases/${encodeURIComponent(caseId)}/nl/generations/${encodeURIComponent(generationId)}`,
    );
  }

  queueGenerations(query = { status: 'queued', limit: 20 }) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) qs.set(key, String(value));
    return this.request('GET', `/api/v1/nl/generations?${qs}`);
  }

  claimGeneration(generationId, leaseSeconds = 120) {
    return this.request('POST', `/api/v1/nl/generations/${encodeURIComponent(generationId)}/claim`, { leaseSeconds });
  }

  submitGeneration(generationId, payload) {
    return this.request('POST', `/api/v1/nl/generations/${encodeURIComponent(generationId)}/submit`, payload);
  }

  acceptGeneration(caseId, generationId, force = false) {
    return this.request(
      'POST',
      `/api/v1/cases/${encodeURIComponent(caseId)}/nl/generations/${encodeURIComponent(generationId)}/accept`,
      { force },
    );
  }

  rejectGeneration(caseId, generationId, reason) {
    return this.request(
      'POST',
      `/api/v1/cases/${encodeURIComponent(caseId)}/nl/generations/${encodeURIComponent(generationId)}/reject`,
      { reason },
    );
  }

  cancelGeneration(caseId, generationId) {
    return this.request(
      'POST',
      `/api/v1/cases/${encodeURIComponent(caseId)}/nl/generations/${encodeURIComponent(generationId)}/cancel`,
    );
  }

  async waitForGeneration(caseId, generationId, options = {}) {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const intervalMs = options.intervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const generation = await this.getGeneration(caseId, generationId);
      const terminal = ['ready', 'accepted', 'rejected', 'failed', 'cancelled'].includes(generation.status);
      if (terminal || Date.now() >= deadline) return generation;
      await sleep(intervalMs);
    }
  }

  // ── 运行 ───────────────────────────────────────────────────────────────
  createRun(payload) {
    return this.request('POST', '/api/v1/runs', payload);
  }

  getRun(runId) {
    return this.request('GET', `/api/v1/runs/${encodeURIComponent(runId)}`);
  }

  cancelRun(runId) {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(runId)}/cancel`);
  }

  getRunItems(runId, query = {}) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) qs.set(key, String(value));
    return this.request('GET', `/api/v1/runs/${encodeURIComponent(runId)}/items${qs.size ? `?${qs}` : ''}`);
  }

  getRunArtifacts(runId, query = {}) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) qs.set(key, String(value));
    return this.request('GET', `/api/v1/runs/${encodeURIComponent(runId)}/artifacts${qs.size ? `?${qs}` : ''}`);
  }

  async waitForRun(runId, options = {}) {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const intervalMs = options.intervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await this.getRun(runId);
      const terminal = ['passed', 'failed', 'cancelled', 'error'].includes(run.status);
      if (terminal || Date.now() >= deadline) return run;
      await sleep(intervalMs);
    }
  }

  // ── 框架托管的 MCP（只允许白名单工具；不调用 unsafe）──────────────────
  createMcpSession(payload = {}) {
    return this.request('POST', '/api/v1/mcp/sessions', payload);
  }

  callMcpTool(sessionId, tool, args = {}, confirm = undefined) {
    return this.request('POST', `/api/v1/mcp/sessions/${encodeURIComponent(sessionId)}/calls`, {
      tool,
      arguments: args,
      ...(confirm === undefined ? {} : { confirm }),
    });
  }

  closeMcpSession(sessionId) {
    return this.request('DELETE', `/api/v1/mcp/sessions/${encodeURIComponent(sessionId)}`);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createApi(options = {}) {
  return new PwAutoApi(options);
}

/** CLI：node api.mjs METHOD PATH [JSON]；全局 --base-url=... / --timeout-ms=... */
async function main(argv) {
  const args = [...argv];
  let baseUrl = DEFAULT_BASE_URL;
  let timeoutMs = 30_000;
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith('--base-url=')) baseUrl = arg.slice('--base-url='.length);
    else if (arg.startsWith('--timeout-ms=')) timeoutMs = Number.parseInt(arg.slice('--timeout-ms='.length), 10);
    else positional.push(arg);
  }
  const [method = 'GET', path, body] = positional;
  if (path === undefined) {
    console.error('用法：node api.mjs METHOD PATH [JSON] [--base-url=URL] [--timeout-ms=毫秒]');
    process.exitCode = 2;
    return;
  }
  const api = new PwAutoApi({ baseUrl, timeoutMs });
  try {
    const parsedBody = body === undefined ? undefined : JSON.parse(body);
    const result = await api.raw(method.toUpperCase(), path, parsedBody);
    console.log(JSON.stringify(result.data, null, 2));
  } catch (error) {
    if (error instanceof ApiError) {
      console.error(JSON.stringify({ error: { code: error.code, message: error.message, details: error.details, status: error.status } }, null, 2));
    } else {
      console.error(error instanceof Error ? error.stack : String(error));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
