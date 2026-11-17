/**
 * 官方 `playwright cli` 适配器。
 *
 * 官方入口：`node <resolved @playwright/test/cli.js> cli [-s=<session>] <command> [args] [--json]`
 * - spawn(argv, {shell:false})，不拼命令字符串；
 * - Windows 路径不作为位置参数（官方 CLI 会把位置参数当目标/正则解析）；
 * - `run-code`/`eval` 需 PW_ENABLE_UNSAFE_TOOLS=1 + confirm:true；
 * - 捕获 stdout/stderr/exitCode/json/parsed/durationMs 与 workDir 内新增产物。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { AutomationError } from '../errors.ts';
import { ProcessRegistry, runProcess } from '../process/process-tree.ts';
import { resolvePlaywrightCli } from '../playwrightCli.ts';
import {
  CLI_CONFIRM_COMMANDS,
  CLI_DENIED_COMMANDS,
  describeCliCommands,
  isAllowedCliCommand,
  isDeniedCliCommand,
  needsConfirmCliCommand,
} from './whitelist.ts';

export interface CliAdapterOptions {
  playwrightCliPath?: string;
  registry?: ProcessRegistry;
  defaultWorkDir?: string;
  /** 配置后强制 workDir 位于这些目录之下（防穿越）。 */
  allowedWorkDirRoots?: string[];
  /** 默认读取 PW_ENABLE_UNSAFE_TOOLS=1。 */
  unsafeToolsEnabled?: boolean;
  defaultTimeoutMs?: number;
}

export interface CliExecRequest {
  argv: string[];
  session?: string;
  workDir?: string;
  timeoutMs?: number;
  confirm?: boolean;
  /** 可选取消（非合同字段，供后端 shutdown 使用）。 */
  signal?: AbortSignal;
}

export interface CliExecArtifact {
  kind: 'trace' | 'screenshot' | 'video' | 'snapshot' | 'console' | 'other';
  /** 相对 workDir 的 POSIX 路径。 */
  path: string;
  absPath: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
}

export interface CliExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  json: unknown | null;
  parsed: unknown | null;
  durationMs: number;
  artifacts: CliExecArtifact[];
  timedOut: boolean;
  isError: boolean;
  error: string | null;
  /** 官方命令回显（含 node 可执行文件与 -s=...，不含密钥）。 */
  command: string[];
  session: string | null;
}

interface FileSnapshot {
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;
const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const SESSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const URL_PATTERN = /^(?:https?|data):/i;

function isInside(rootDir: string, targetPath: string): boolean {
  const relative = path.relative(rootDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathKey(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function toPosixRelative(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join('/');
}

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.webm':
      return 'video/webm';
    case '.pdf':
      return 'application/pdf';
    case '.zip':
      return 'application/zip';
    case '.json':
      return 'application/json';
    case '.yml':
    case '.yaml':
      return 'application/yaml';
    case '.md':
      return 'text/markdown';
    case '.html':
      return 'text/html';
    default:
      return 'text/plain';
  }
}

function classifyArtifact(relativePath: string): CliExecArtifact['kind'] {
  const lower = relativePath.toLowerCase();
  const baseName = path.basename(lower);
  const ext = path.extname(baseName);
  if (lower.startsWith('.playwright-cli/')) {
    if (baseName.startsWith('page-') && (ext === '.yml' || ext === '.yaml')) return 'snapshot';
    if (baseName.startsWith('console-')) return 'console';
  }
  if (ext === '.zip' && lower.includes('trace')) return 'trace';
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'screenshot';
  if (['.webm', '.mp4'].includes(ext)) return 'video';
  if (ext === '.log') return 'console';
  if (ext === '.yml' || ext === '.yaml') return 'snapshot';
  return 'other';
}

async function hashFile(absolutePath: string): Promise<string> {
  const buffer = await fs.readFile(absolutePath);
  return createHash('sha256').update(buffer).digest('hex');
}

async function snapshotFiles(rootDir: string): Promise<Map<string, FileSnapshot>> {
  const snapshot = new Map<string, FileSnapshot>();
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.cache') continue;
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(absolutePath);
        snapshot.set(pathKey(absolutePath), { absolutePath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // 文件在扫描过程中消失，忽略。
      }
    }
  }
  return snapshot;
}

function extractJson(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (trimmed === '' || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function extractParsed(command: string, json: unknown): unknown | null {
  if (json === null || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  if (command === 'snapshot' || command === 'find') {
    return record['snapshot'] ?? record['found'] ?? null;
  }
  if (command === 'generate-locator') {
    return record['result'] ?? null;
  }
  return null;
}

function assertSafeArgument(argument: string): void {
  if (argument.includes('\u0000')) {
    throw new AutomationError('VALIDATION_FAILED', 'argv 参数不能包含 NUL 字符');
  }
  if (URL_PATTERN.test(argument)) return;
  // 选项值（--filename=... 等）同样不允许绝对 Windows 路径与 .. 穿越。
  const optionValue = argument.startsWith('--') && argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : null;
  const candidates = optionValue === null ? [argument] : [optionValue];
  for (const candidate of candidates) {
    if (WINDOWS_ABSOLUTE_PATH.test(candidate)) {
      throw new AutomationError(
        'INVALID_PATH',
        `Windows 绝对路径不得作为 CLI 参数：${candidate}（官方 CLI 会把位置参数按目标/正则解析；请使用 workDir 内的相对路径）`,
      );
    }
    if (PARENT_SEGMENT.test(candidate)) {
      throw new AutomationError('INVALID_PATH', `CLI 参数不得包含 .. 路径穿越：${candidate}`);
    }
    if (candidate.startsWith('file://')) {
      throw new AutomationError('INVALID_PATH', 'CLI 参数不允许 file:// 地址');
    }
  }
}

export class CliAdapter {
  private readonly options: CliAdapterOptions;
  private readonly registry: ProcessRegistry;
  private readonly unsafeToolsEnabled: boolean;

  constructor(options: CliAdapterOptions = {}) {
    this.options = options;
    this.registry = options.registry ?? new ProcessRegistry();
    this.unsafeToolsEnabled = options.unsafeToolsEnabled ?? process.env['PW_ENABLE_UNSAFE_TOOLS'] === '1';
  }

  isUnsafeToolsEnabled(): boolean {
    return this.unsafeToolsEnabled;
  }

  listCommands(): { allow: string[]; needsConfirm: string[]; deny: string[] } {
    return describeCliCommands();
  }

  /**
   * 执行一条官方 CLI 命令。
   * @throws AutomationError CAPABILITY_DISABLED / INVALID_PATH / VALIDATION_FAILED / NOT_FOUND / NOT_IMPLEMENTED
   */
  async exec(request: CliExecRequest): Promise<CliExecResult> {
    const cliPath = resolvePlaywrightCli(this.options.playwrightCliPath);
    const argv = this.validateArgv(request.argv);
    const command = argv[0] as string;

    if (needsConfirmCliCommand(command)) {
      if (!this.unsafeToolsEnabled) {
        throw new AutomationError(
          'CAPABILITY_DISABLED',
          `CLI 命令「${command}」等价于任意代码执行；需设置 PW_ENABLE_UNSAFE_TOOLS=1 后重启服务`,
        );
      }
      if (request.confirm !== true) {
        throw new AutomationError('CAPABILITY_DISABLED', `CLI 命令「${command}」需要请求体 confirm:true`);
      }
    }

    let session: string | null = null;
    if (request.session !== undefined && request.session !== null && request.session !== '') {
      if (!SESSION_PATTERN.test(request.session)) {
        throw new AutomationError('VALIDATION_FAILED', `session 只允许字母/数字/._-（≤64）：${request.session}`);
      }
      session = request.session;
    }

    const workDir = this.validateWorkDir(request.workDir);
    await fs.mkdir(workDir, { recursive: true });

    const timeoutMs = this.validateTimeout(request.timeoutMs);
    const argvHasJson = argv.some((arg) => arg === '--json' || arg.startsWith('--json='));
    const argvHasRaw = argv.some((arg) => arg === '--raw' || arg.startsWith('--raw='));
    const cliArgv = [cliPath, 'cli', ...(session === null ? [] : [`-s=${session}`]), ...argv];
    if (!argvHasJson && !argvHasRaw) cliArgv.push('--json');
    const echo = [process.execPath, ...cliArgv];

    const before = await snapshotFiles(workDir);
    const processResult = await runProcess(process.execPath, cliArgv, {
      cwd: workDir,
      timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      registry: this.registry,
      label: `playwright-cli:${session ?? 'default'}:${command}`,
      maxBufferBytes: 4 * 1024 * 1024,
    });

    const after = await snapshotFiles(workDir);
    const artifacts: CliExecArtifact[] = [];
    for (const [key, snapshot] of after.entries()) {
      const previous = before.get(key);
      const changed = previous === undefined || previous.sizeBytes !== snapshot.sizeBytes || previous.mtimeMs !== snapshot.mtimeMs;
      if (!changed) continue;
      artifacts.push(await this.buildArtifact(workDir, snapshot.absolutePath, snapshot));
    }

    const json = extractJson(processResult.stdout);
    const parsed = extractParsed(command, json);
    const jsonError =
      json !== null && typeof json === 'object' && typeof (json as Record<string, unknown>)['error'] === 'string'
        ? String((json as Record<string, unknown>)['error'])
        : null;
    const timedOut = processResult.timedOut;
    const exitCode = processResult.exitCode;
    const isError = timedOut || exitCode !== 0 || (json !== null && typeof json === 'object' && (json as Record<string, unknown>)['isError'] === true);
    const error =
      timedOut
        ? `CLI 命令超时（${timeoutMs}ms），已强杀进程树`
        : jsonError ?? (isError ? (processResult.stderr.trim() || processResult.stdout.trim() || `退出码 ${String(exitCode)}`) : null);

    return {
      exitCode,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      json,
      parsed,
      durationMs: processResult.durationMs,
      artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)),
      timedOut,
      isError,
      error,
      command: echo,
      session,
    };
  }

  /** 官方 kill-all：清理僵尸浏览器会话（可能影响同机其它 CLI 会话，后端只在收尾调用）。 */
  async killAll(): Promise<void> {
    try {
      await this.exec({ argv: ['kill-all', '--json'], timeoutMs: 15_000 });
    } catch {
      // 收尾清理失败不阻塞主流程。
    }
  }

  /** 关闭指定 CLI 会话。 */
  async closeSession(session: string): Promise<void> {
    try {
      await this.exec({ argv: ['close', '--json'], session, timeoutMs: 15_000 });
    } catch {
      // 会话可能已因空闲自动关闭。
    }
  }

  /** 供诊断：注册表快照。 */
  listProcesses(): { pid: number; label: string; startedAt: string }[] {
    return this.registry.list();
  }

  private buildArtifact = async (workDir: string, absolutePath: string, snapshot: FileSnapshot): Promise<CliExecArtifact> => {
    let sha256 = '';
    try {
      sha256 = await hashFile(absolutePath);
    } catch {
      sha256 = '';
    }
    const relativePath = toPosixRelative(workDir, absolutePath);
    return {
      kind: classifyArtifact(relativePath),
      path: relativePath,
      absPath: absolutePath,
      sizeBytes: snapshot.sizeBytes,
      sha256,
      contentType: contentTypeForExt(path.extname(relativePath).toLowerCase()),
    };
  };

  private validateArgv(argvInput: unknown): string[] {
    if (!Array.isArray(argvInput) || argvInput.length === 0) {
      throw new AutomationError('VALIDATION_FAILED', 'argv 必须是非空字符串数组');
    }
    if (argvInput.length > 64) {
      throw new AutomationError('VALIDATION_FAILED', 'argv 参数过多（上限 64）');
    }
    const argv: string[] = [];
    for (const argument of argvInput) {
      if (typeof argument !== 'string' || argument === '') {
        throw new AutomationError('VALIDATION_FAILED', 'argv 每个元素必须是非空字符串');
      }
      if (argument.length > 4096) {
        throw new AutomationError('VALIDATION_FAILED', `argv 参数过长（>4096）：${argument.slice(0, 64)}…`);
      }
      argv.push(argument);
    }
    const command = argv[0] as string;
    if (isDeniedCliCommand(command)) {
      throw new AutomationError(
        'CAPABILITY_DISABLED',
        `CLI 命令「${command}」被禁止（安装类副作用 / 连接本机真实浏览器 / 未证实）`,
      );
    }
    if (!isAllowedCliCommand(command)) {
      throw new AutomationError(
        'CAPABILITY_DISABLED',
        `CLI 命令「${command}」不在白名单内；允许命令见 GET /api/v1/cli/commands`,
      );
    }
    for (const argument of argv) assertSafeArgument(argument);
    return argv;
  }

  private validateTimeout(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined) return this.options.defaultTimeoutMs ?? 30_000;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new AutomationError('VALIDATION_FAILED', 'timeoutMs 必须是 1000..120000 的整数');
    }
    return timeoutMs;
  }

  private validateWorkDir(workDirInput: string | undefined): string {
    const workDir = workDirInput ?? this.options.defaultWorkDir;
    if (workDir === undefined || workDir === '') {
      throw new AutomationError('VALIDATION_FAILED', 'CLI 执行需要 workDir（或配置 defaultWorkDir）');
    }
    if (!path.isAbsolute(workDir)) {
      throw new AutomationError('VALIDATION_FAILED', `CLI workDir 必须是绝对路径：${workDir}`);
    }
    const resolved = path.resolve(workDir);
    const roots = this.options.allowedWorkDirRoots;
    if (roots !== undefined && roots.length > 0) {
      const allowed = roots.some((root) => isInside(path.resolve(root), resolved));
      if (!allowed) throw new AutomationError('PATH_FORBIDDEN', `CLI workDir 越出受控根：${workDir}`);
    }
    return resolved;
  }
}

export { CLI_CONFIRM_COMMANDS, CLI_DENIED_COMMANDS };

export function createCliAdapter(options: CliAdapterOptions = {}): CliAdapter {
  return new CliAdapter(options);
}