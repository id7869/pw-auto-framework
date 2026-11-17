/**
 * Agent 交接服务：官方 `init-agents` 脚手架 + prompt 产物索引 + 受控目录浏览。
 * 契约：docs/api-contract.md §7。
 *
 * 纪律：
 * - 执行只调用官方 `init-agents`（由 packages/automation 适配面提供），命令 argv 全量回显；
 * - 目标目录必须位于 `<repo>/agents/` 之下（防穿越）；
 * - `missing` 只做结构存在性结论；不声称「已生成测试」「已修复」。
 */

import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  PROMPT_KEYS,
  SCAFFOLD_EXPECTED_PATHS,
  SCAFFOLD_PROMPT_FILENAMES,
  type AgentEntry,
  type AgentLoop,
  type AgentPrompt,
  type AgentWorkspaceEntry,
  type CreateScaffoldRequest,
  type HarnessInfo,
  type Page,
  type Scaffold,
  type ScaffoldFile,
} from '@pw-auto/contracts';
import { AppError, fromAdapterError } from '../errors.ts';
import { newId } from '../ids.ts';
import { assertWithinRoot, ensureDir, isWithinRoot, resolveRelative, scaffoldTargetDir, toRelativePosix } from '../paths.ts';
import { writeAudit } from '../repositories/audit.ts';
import { getIdempotency, saveIdempotency } from '../repositories/idempotency.ts';
import * as scaffoldRepo from '../repositories/scaffolds.ts';
import type { SurfaceBundle } from '@pw-auto/contracts';
import { isoNow, sha256Hex } from '../utils.ts';
import { DEEPSEEK_SCAFFOLD_NOTES, HARNESSES } from './harnesses.ts';

/** 入口 → 官方 loop（deepseek 无官方 loop → null，不伪造） */
function officialLoopOf(entry: AgentEntry): 'claude' | 'codex' | null {
  return entry === 'deepseek' ? null : entry;
}

function resolveEntry(input: CreateScaffoldRequest): AgentEntry {
  if (input.loop !== undefined) {
    throw new AppError(
      'HARNESS_NOT_SUPPORTED',
      `不再接受 loop 入口（${input.loop}）：后端只有 claude/codex/deepseek 三入口，请改用 entry`,
    );
  }
  const entry = input.entry;
  if (entry === 'claude' || entry === 'codex' || entry === 'deepseek') return entry;
  throw new AppError(
    'HARNESS_NOT_SUPPORTED',
    `entry 只接受 claude / codex / deepseek 三入口（当前：${entry ?? '缺失'}）`,
  );
}

/** 框架模板（无官方产物时的回退，UI 必须标注 source="framework"） */
const FRAMEWORK_PROMPTS: AgentPrompt[] = [
  {
    key: 'plan',
    title: '规划（planner 交接模板 · 框架提供）',
    body: [
      '目标：与官方 playwright-test planner 对齐的规划输入。',
      '1) 先由外部 coding agent 加载官方 planner 定义（init-agents 产物），不要在本框架内伪造 AI 规划。',
      '2) 提供被测页面入口 URL、期望业务路径、边界与错误场景。',
      '3) 要求输出 Markdown 计划：每个场景含标题、步骤、期望结果、初始状态假设。',
      '4) 计划落盘到受控目录（specs/），由本框架的只读浏览接口展示。',
    ].join('\n'),
    source: 'framework',
  },
  {
    key: 'generate',
    title: '生成（generator 交接模板 · 框架提供）',
    body: [
      '目标：与官方 playwright-test generator 对齐的生成输入。',
      '1) 逐条把 plan 中的场景交给 generator，一次只做一个场景，不并行。',
      '2) generator 需在真实浏览器中逐步执行并写入 tests/<group>/<scenario>.spec.ts（官方 generator_write_test）。',
      '3) 生成后用本框架「运行」功能以官方 @playwright/test 复核，禁止用本框架自研断言。',
    ].join('\n'),
    source: 'framework',
  },
  {
    key: 'heal',
    title: '修复（healer 交接模板 · 框架提供）',
    body: [
      '目标：与官方 playwright-test healer 对齐的失败修复输入。',
      '1) 先在本框架创建运行，取失败项的官方错误、trace、截图（GET /runs/{id}/items、/artifacts）。',
      '2) 把失败明细交给外部 coding agent 的 healer，由其 test_run/test_debug 取证并修改测试代码。',
      '3) 修不好且确认测试正确时，官方约定用 test.fixme() 并写注释；本框架不承诺「一键修复成功」。',
    ].join('\n'),
    source: 'framework',
  },
  {
    key: 'coverage',
    title: '覆盖（coverage 交接模板 · 框架提供）',
    body: [
      '目标：补齐覆盖缺口。',
      '1) 以本框架用例/数据集/运行历史为清单，找出未覆盖的业务路径。',
      '2) 交回 planner → generator 流程；一个场景一个测试文件。',
      '3) 覆盖结论由人工与外部 coding agent 判定，本框架只提供清单与运行证据。',
    ].join('\n'),
    source: 'framework',
  },
];

const MAX_INDEXED_FILES = 2000;
const MAX_PROMPT_BYTES = 256 * 1024;

function safeReaddir(dir: string): import('node:fs').Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 递归索引目录下的普通文件（跳过 node_modules，限制数量，防符号链接越界） */
function indexFiles(root: string, relative = '', depth = 0, acc: ScaffoldFile[] = []): ScaffoldFile[] {
  if (depth > 6 || acc.length >= MAX_INDEXED_FILES) return acc;
  const dir = relative === '' ? root : join(root, relative);
  for (const entry of safeReaddir(dir)) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
    const absolute = join(root, childRelative);
    if (!isWithinRoot(root, absolute)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      indexFiles(root, childRelative, depth + 1, acc);
      if (acc.length >= MAX_INDEXED_FILES) return acc;
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = statSync(absolute);
      acc.push({ path: childRelative, sizeBytes: stat.size, sha256: sha256Hex(readFileSync(absolute)) });
    } catch {
      // 读失败的文件不进入索引（不伪造 sha256）
    }
    if (acc.length >= MAX_INDEXED_FILES) return acc;
  }
  return acc;
}

export interface AgentServiceDeps {
  db: DatabaseSync;
  repoRoot: string;
  surfaces: SurfaceBundle;
  log: (message: string) => void;
}

export class AgentService {
  private readonly db: DatabaseSync;
  private readonly repoRoot: string;
  private readonly surfaces: SurfaceBundle;
  private readonly log: (message: string) => void;

  constructor(deps: AgentServiceDeps) {
    this.db = deps.db;
    this.repoRoot = deps.repoRoot;
    this.surfaces = deps.surfaces;
    this.log = deps.log;
  }

  get agentsRoot(): string {
    return join(this.repoRoot, 'agents');
  }

  /** 三 harness 推荐入口（唯一与 skill 相关的只读数据；无安装态） */
  harnesses(): HarnessInfo[] {
    return HARNESSES.map((item) => ({
      ...item,
      skillPaths: item.skillPaths.map((skillPath) => ({ ...skillPath })),
    }));
  }

  listScaffolds(query: { limit: number; cursor?: string | undefined; order: 'asc' | 'desc' }): Page<Scaffold> {
    return scaffoldRepo.listScaffolds(this.db, query);
  }

  getScaffold(id: string): Scaffold {
    return scaffoldRepo.assertScaffoldExists(this.db, id);
  }

  async createScaffold(
    input: CreateScaffoldRequest,
    idempotencyKey: string | null,
    actor: string,
  ): Promise<{ scaffold: Scaffold; replayed: boolean }> {
    if (input.confirm !== true) {
      throw new AppError('CONFIRM_REQUIRED', '生成 Agent 脚手架会在磁盘写入文件，请显式确认：{"confirm": true}');
    }
    const entry = resolveEntry(input);
    const officialLoop = officialLoopOf(entry);
    const requestHash = sha256Hex(JSON.stringify({ entry, prompts: input.prompts }));
    if (idempotencyKey !== null) {
      const existing = getIdempotency(this.db, idempotencyKey);
      if (existing) {
        if (existing.scope !== 'scaffold' || existing.requestHash !== requestHash) {
          throw new AppError('IDEMPOTENCY_CONFLICT', '同一 Idempotency-Key 已被不同请求体使用，拒绝复用');
        }
        const found = scaffoldRepo.getScaffoldById(this.db, existing.resourceId);
        if (found) return { scaffold: found, replayed: true };
      }
    }

    const scaffoldId = newId('scaffold');
    const agentsRoot = ensureDir(this.agentsRoot);
    const targetDir = scaffoldTargetDir(this.repoRoot, scaffoldId);
    assertWithinRoot(agentsRoot, targetDir, '脚手架目标目录越出受控根 agents/');
    ensureDir(targetDir);

    const createdAt = isoNow();
    let status: Scaffold['status'] = 'completed';
    let command: string[] = [];
    let error: Scaffold['error'] = null;
    let files: ScaffoldFile[] = [];
    let missing: string[] = [];

    let notes: string | undefined;
    if (entry === 'deepseek') {
      // deepseek 无官方 loop：不执行 init-agents，写入与官方 --prompts 同构的 4 个交接模板
      const promptsDir = ensureDir(join(targetDir, 'prompts'));
      for (const prompt of FRAMEWORK_PROMPTS) {
        writeFileSync(join(promptsDir, `${prompt.key}.md`), prompt.body, 'utf8');
      }
      notes = DEEPSEEK_SCAFFOLD_NOTES;
      command = [];
      status = 'completed';
      files = indexFiles(targetDir);
      missing = [];
    } else {
      const surface = this.surfaces.agents;
      if (!surface) {
        throw new AppError('NOT_IMPLEMENTED', this.surfaces.reasons['agents'] ?? '官方 init-agents 适配不可用');
      }
      try {
        const result = await surface.runScaffold({
          scaffoldId,
          loop: entry,
          prompts: input.prompts,
          targetDir,
          repoRoot: this.repoRoot,
        });
        command = result.command;
        status = result.status;
        error = result.error;
        files = result.files
          .filter((file) => {
            try {
              resolveRelative(targetDir, file.path, '脚手架产物路径越界');
              return true;
            } catch {
              return false;
            }
          })
          .map((file) => ({ path: file.path, sizeBytes: file.sizeBytes, sha256: file.sha256 }));
        missing = result.missing;
      } catch (err) {
        this.log(`[agents] init-agents 执行失败：${err instanceof Error ? err.message : String(err)}`);
        throw fromAdapterError(err, '官方 init-agents 执行失败');
      }
    }

    // 结构存在性校验（独立于适配面结论，按磁盘实际状态复核）
    const expected = entry === 'deepseek' ? [] : (SCAFFOLD_EXPECTED_PATHS[entry as AgentLoop] ?? []);
    const diskMissing = expected.filter((relativePath) => !existsSync(join(targetDir, relativePath)));
    missing = [...new Set([...missing, ...diskMissing])].sort((a, b) => a.localeCompare(b));
    if (files.length === 0) files = indexFiles(targetDir);

    const scaffold: Scaffold = {
      id: scaffoldId,
      loop: entry === 'deepseek' ? null : entry,
      entry,
      officialLoop,
      prompts: input.prompts,
      targetDir,
      status,
      command,
      files,
      missing,
      ...(notes === undefined ? {} : { notes }),
      error,
      createdAt,
      finishedAt: isoNow(),
    };

    scaffoldRepo.insertScaffold(this.db, scaffold);
    if (idempotencyKey !== null) {
      saveIdempotency(this.db, {
        key: idempotencyKey,
        scope: 'scaffold',
        requestHash,
        resourceId: scaffoldId,
        responseStatus: 201,
        createdAt,
      });
    }
    writeAudit(this.db, {
      actor,
      action: 'scaffold.create',
      target: scaffoldId,
      detail: { entry, prompts: input.prompts, status: scaffold.status, files: scaffold.files.length },
    });
    return { scaffold, replayed: false };
  }

  /** 官方 --prompts 产物优先；无产物时回退框架模板（source 明确标注） */
  prompts(entry: AgentEntry | undefined): AgentPrompt[] {
    const scaffolds = scaffoldRepo
      .listScaffolds(this.db, { limit: 20, order: 'desc' })
      .items.filter((item) => item.prompts && item.status === 'completed' && (entry === undefined || item.entry === entry));

    for (const scaffold of scaffolds) {
      const official = this.readOfficialPrompts(scaffold.targetDir);
      if (official.length > 0) return official;
    }
    return FRAMEWORK_PROMPTS.map((prompt) => ({ ...prompt }));
  }

  private readOfficialPrompts(targetDir: string): AgentPrompt[] {
    const found = new Map<string, AgentPrompt>();
    const walk = (relative: string, depth: number): void => {
      if (depth > 4) return;
      for (const entry of safeReaddir(relative === '' ? targetDir : join(targetDir, relative))) {
        if (entry.isSymbolicLink()) continue;
        const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
        const absolute = join(targetDir, childRelative);
        if (!isWithinRoot(targetDir, absolute)) continue;
        if (entry.isDirectory()) {
          walk(childRelative, depth + 1);
          continue;
        }
        const key = SCAFFOLD_PROMPT_FILENAMES[basename(entry.name)];
        if (!key || found.has(key)) continue;
        try {
          const stat = statSync(absolute);
          if (stat.size > MAX_PROMPT_BYTES) continue;
          const body = readFileSync(absolute, 'utf8');
          found.set(key, {
            key: key as AgentPrompt['key'],
            title: `${basename(entry.name)}（官方 --prompts 产物）`,
            body,
            source: 'official',
          });
        } catch {
          // 读取失败则跳过
        }
      }
    };
    walk('', 0);
    return PROMPT_KEYS.filter((key) => found.has(key)).map((key) => found.get(key) as AgentPrompt);
  }

  /** 受控目录浏览（path 相对 targetDir；越界 → 403/400） */
  workspace(query: { path?: string | undefined; scaffoldId?: string | undefined }): AgentWorkspaceEntry[] {
    let scaffold: Scaffold | null = null;
    if (query.scaffoldId !== undefined) {
      scaffold = scaffoldRepo.getScaffoldById(this.db, query.scaffoldId);
      if (!scaffold) throw new AppError('NOT_FOUND', `脚手架不存在：${query.scaffoldId}`);
    } else {
      scaffold = scaffoldRepo.latestScaffold(this.db);
      if (!scaffold) throw new AppError('NOT_FOUND', '尚无脚手架产物，请先 POST /api/v1/agents/scaffolds');
    }

    const root = scaffold.targetDir;
    const relativePath = query.path ?? '';
    const absolute = relativePath === '' ? root : resolveRelative(root, relativePath, '浏览路径越出脚手架目录');
    if (!existsSync(absolute)) throw new AppError('NOT_FOUND', `路径不存在：${relativePath}`);
    const stat = statSync(absolute);
    if (stat.isFile()) {
      return [{ path: toRelativePosix(root, absolute), sizeBytes: stat.size, mtime: stat.mtime.toISOString() }];
    }
    const entries: AgentWorkspaceEntry[] = [];
    for (const entry of safeReaddir(absolute)) {
      if (entry.isSymbolicLink()) continue;
      const child = join(absolute, entry.name);
      if (!isWithinRoot(root, child)) continue;
      try {
        const childStat = statSync(child);
        entries.push({
          path: toRelativePosix(root, child),
          sizeBytes: entry.isDirectory() ? 0 : childStat.size,
          mtime: childStat.mtime.toISOString(),
        });
      } catch {
        // 忽略不可读条目
      }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
}