/**
 * 官方入口（@playwright/test@1.65.0 内置 cli.js）的**独立**调用封装。
 *
 * 与产品实现无关：本文件只用于验收时绕开后端，直接验证官方能力本身
 * （MCP stdio 握手、CLI 命令、init-agents 产物），对应验收要求「官方版本 + 官方输出」。
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePlaywrightCli } from './env.ts';
import { killTree, runProcess, type ProcessResult } from './process.ts';

export interface OfficialCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** 直接执行官方 CLI：node <cli.js> <args...> */
export function runOfficialCli(args: readonly string[], options: OfficialCliOptions = {}): Promise<ProcessResult> {
  return runProcess(process.execPath, [resolvePlaywrightCli(), ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    timeoutMs: options.timeoutMs ?? 120_000,
  });
}

export interface McpProbeResult {
  serverInfo: { name: string; version: string } | null;
  protocolVersion: string | null;
  tools: { name: string; description?: string }[];
  navigateIsError: boolean | null;
  navigateText: string;
  snapshotText: string;
  stderr: string;
  durationMs: number;
  cwd: string;
}

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * 独立 MCP stdio 探针：initialize → tools/list → browser_navigate → browser_snapshot。
 *
 * 官方 `playwright mcp` 采用 stdio 传输（换行分隔的 JSON-RPC 2.0 消息），
 * 与 @modelcontextprotocol/sdk 的 StdioClientTransport 同构；此处手写最小客户端以避免
 * 在验收包里引入第二份 SDK 依赖。
 *
 * cwd 必须指向受控临时目录：官方 MCP 会在 cwd 下写 `.playwright-mcp/`（页面快照/控制台日志），
 * 不允许污染仓库根。
 */
export async function mcpProbe(input: { url: string; caps?: string[]; timeoutMs?: number; cwd?: string }): Promise<McpProbeResult> {
  const startedAt = Date.now();
  const caps = input.caps ?? ['testing', 'storage', 'network'];
  const cwd = input.cwd ?? resolve(process.cwd(), '.mcp-probe');
  mkdirSync(cwd, { recursive: true });
  const args = [resolvePlaywrightCli(), 'mcp', '--headless', '--isolated', `--caps=${caps.join(',')}`];
  const child = spawn(process.execPath, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map<number, (message: JsonRpcResponse) => void>();
  let closed = false;

  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 16_384) stderr += chunk.toString('utf8');
  });

  const onLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return; // 非 JSON 行（日志）忽略
    }
    if (message.id === undefined) return;
    const resolver = pending.get(message.id);
    if (resolver !== undefined) {
      pending.delete(message.id);
      resolver(message);
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });

  const stop = (): void => {
    if (closed) return;
    closed = true;
    if (child.pid !== undefined) killTree(child.pid);
    else child.kill('SIGKILL');
  };

  const send = (method: string, params: Record<string, unknown> | undefined): Promise<JsonRpcResponse> => {
    const id = nextId;
    nextId += 1;
    const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    child.stdin?.write(`${JSON.stringify(payload)}\n`);
    return new Promise<JsonRpcResponse>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`MCP 请求超时：${method}（${input.timeoutMs ?? 120_000}ms）`));
      }, input.timeoutMs ?? 120_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
    });
  };

  try {
    const init = await send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pw-e2e-verifier', version: '0.1.0' },
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await send('tools/list', {});
    const navigate = await send('tools/call', { name: 'browser_navigate', arguments: { url: input.url } });
    const snapshot = await send('tools/call', { name: 'browser_snapshot', arguments: {} });

    const initResult = init.result ?? {};
    const listResult = list.result ?? {};
    const tools = Array.isArray(listResult['tools']) ? (listResult['tools'] as { name: string; description?: string }[]) : [];
    const navigateResult = (navigate.result ?? {}) as { isError?: boolean; content?: unknown };
    const snapshotResult = (snapshot.result ?? {}) as { isError?: boolean; content?: unknown };
    return {
      serverInfo: (initResult['serverInfo'] as { name: string; version: string } | undefined) ?? null,
      protocolVersion: (initResult['protocolVersion'] as string | undefined) ?? null,
      tools,
      navigateIsError: navigateResult.isError ?? null,
      navigateText: JSON.stringify(navigateResult.content ?? navigate.error ?? '').slice(0, 4000),
      snapshotText: JSON.stringify(snapshotResult.content ?? snapshot.error ?? '').slice(0, 20_000),
      stderr,
      durationMs: Date.now() - startedAt,
      cwd,
    };
  } finally {
    stop();
  }
}

export interface InitAgentsResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cwd: string;
  command: string[];
}

/** 在指定目录独立执行官方 `init-agents`（用于核对官方脚手架产物，不经过后端） */
export async function initAgentsDirect(cwd: string, loop = 'claude', prompts = true): Promise<InitAgentsResult> {
  mkdirSync(cwd, { recursive: true });
  const args = ['init-agents', `--loop=${loop}`, ...(prompts ? ['--prompts'] : [])];
  const result = await runOfficialCli(args, { cwd, timeoutMs: 120_000 });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    cwd,
    command: [process.execPath, resolvePlaywrightCli(), ...args],
  };
}