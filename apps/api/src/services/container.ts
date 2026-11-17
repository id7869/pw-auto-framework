/**
 * 服务容器装配（应用启动唯一入口）：打开数据库、装载引擎与官方能力适配面、构造各 service。
 *
 * 可注入点（单测用）：
 * - `engine`：fake ExecutionEngine（避免真实子进程/浏览器）；
 * - `surfaces`：fake Agent/MCP/CLI 适配面（验证 501/403 之外的成功路径）；
 * - `config`：临时目录与并发/超时设置。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ExecutionEngine } from '@pw-auto/automation';
import type { SurfaceBundle } from '@pw-auto/contracts';
import type { AppConfig } from '../config.ts';
import { closeDatabase, checkDatabase, openDatabase } from '../db/database.ts';
import { bootstrapEngine, type EngineHandle } from '../engine.ts';
import { probePlaywrightVersion, resolvePlaywrightCliPath, type PlaywrightVersionInfo } from '../official.ts';
import { markStaleMcpSessions } from '../repositories/mcp.ts';
import { loadSurfaces } from '../surfaces.ts';
import { AgentService } from './agents.ts';
import { CaseService } from './cases.ts';
import { CliService } from './cli.ts';
import { DatasetService } from './datasets.ts';
import { McpService } from './mcp.ts';
import { NlGenerationService } from './nl-generations.ts';
import { NlService } from './nl.ts';
import { BaselineService, ComparisonService } from './regression.ts';
import { RunService } from './runs.ts';
import { SuiteService } from './suites.ts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type Logger = (level: LogLevel, message: string) => void;

export const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createConsoleLogger(minLevel: LogLevel): Logger {
  return (level, message) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const line = `[pw-auto-api][${level}] ${message}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };
}

export type SilentLogger = Logger;

export interface AppServices {
  config: AppConfig;
  db: DatabaseSync;
  engine: EngineHandle;
  surfaces: SurfaceBundle;
  logger: Logger;
  /** 启动时探测的官方 CLI 版本信息（meta 只读缓存，不重复 spawn） */
  playwrightInfo: PlaywrightVersionInfo;
  cases: CaseService;
  datasets: DatasetService;
  suites: SuiteService;
  runs: RunService;
  baselines: BaselineService;
  comparisons: ComparisonService;
  agents: AgentService;
  mcp: McpService;
  cli: CliService;
  /** NL 用例（R6） */
  nl: NlService;
  nlGenerations: NlGenerationService;
  healthCheck(): 'ok' | 'error';
}

export interface CreateServicesOptions {
  config: AppConfig;
  /** 显式注入引擎（null 表示不可用）；undefined 表示按 automation 包装配 */
  engine?: ExecutionEngine | null | undefined;
  /** 显式注入官方能力适配面；undefined 表示按 automation 包发现 */
  surfaces?: SurfaceBundle | undefined;
  logger?: Logger | undefined;
  /** 覆盖官方 CLI 路径（测试注入无效路径以验证 fallback 语义） */
  playwrightCliPath?: string | undefined;
}

export interface ServicesHandle {
  services: AppServices;
  close(): Promise<void>;
}

export function createServices(options: CreateServicesOptions): ServicesHandle {
  const { config } = options;
  const logger = options.logger ?? createConsoleLogger(config.logLevel);
  const db = openDatabase(config.dataDir);

  // 启动时探测并缓存官方 CLI 版本（真实 `node <cli.js> --version`；失败才回退常量并标注来源）
  const playwrightInfo = probePlaywrightVersion(options.playwrightCliPath ?? resolvePlaywrightCliPath());
  if (playwrightInfo.source === 'cli') {
    logger('info', `官方 Playwright 版本：${playwrightInfo.version}（来自 ${playwrightInfo.cliPath}）`);
  } else {
    logger('warn', `官方 Playwright 版本探测失败，回退常量 ${playwrightInfo.version}：${playwrightInfo.error ?? '未知原因'}`);
  }

  const engine: EngineHandle =
    options.engine === undefined
      ? bootstrapEngine()
      : options.engine === null
        ? { engine: null, reason: '测试注入：执行引擎不可用' }
        : { engine: options.engine, reason: null };
  if (engine.engine === null && engine.reason) logger('warn', engine.reason);

  const surfaces =
    options.surfaces ??
    loadSurfaces({ repoRoot: config.repoRoot, dataDir: config.dataDir, enableUnsafeTools: config.enableUnsafeTools });
  for (const [name, reason] of Object.entries(surfaces.reasons)) {
    logger('warn', `官方能力 ${name} 不可用：${reason}`);
  }

  const nl = new NlService({ db, config, engine });
  const cases = new CaseService({ db, engine, nl });
  const datasets = new DatasetService(db);
  const suites = new SuiteService(db);
  const runs = new RunService({
    db,
    nl,
    engine,
    config: {
      dataDir: config.dataDir,
      runTimeoutMs: config.runTimeoutMs,
      caseTimeoutMs: config.caseTimeoutMs,
      maxConcurrentRuns: config.maxConcurrentRuns,
      keepRuns: config.keepRuns,
      queueLimit: config.queueLimit,
      browser: config.browser,
      headed: config.headed,
    },
    log: (message) => logger('info', message),
  });
  const baselines = new BaselineService(db);
  const comparisons = new ComparisonService(db);
  const agents = new AgentService({
    db,
    repoRoot: config.repoRoot,
    surfaces,
    log: (message) => logger('info', message),
  });
  const mcp = new McpService({
    db,
    surfaces,
    dataDir: config.dataDir,
    enableUnsafeTools: config.enableUnsafeTools,
    maxSessions: config.mcpMaxSessions,
    log: (message) => logger('info', message),
  });
  const cli = new CliService({
    db,
    surfaces,
    dataDir: config.dataDir,
    enableUnsafeTools: config.enableUnsafeTools,
    log: (message) => logger('info', message),
  });

  runs.recover();
  const nlGenerations = new NlGenerationService({ db, config, nl });
  const nlRecovery = nlGenerations.recover();
  if (nlRecovery.failed > 0 || nlRecovery.requeued > 0) {
    logger(
      'warn',
      `启动恢复：NL 生成任务 ${nlRecovery.failed} 个置为 failed，${nlRecovery.requeued} 个租约过期回 queued`,
    );
  }
  const staleSessions = markStaleMcpSessions(db, new Date().toISOString());
  if (staleSessions > 0) logger('warn', `启动恢复：${staleSessions} 个 MCP 会话已置为 error(RUN_INTERRUPTED)`);

  const services: AppServices = {
    config,
    db,
    engine,
    surfaces,
    logger,
    playwrightInfo,
    cases,
    datasets,
    suites,
    runs,
    baselines,
    comparisons,
    agents,
    mcp,
    cli,
    nl,
    nlGenerations,
    healthCheck: () => (checkDatabase(db) ? 'ok' : 'error'),
  };

  return {
    services,
    close: async () => {
      runs.shutdown();
      try {
        // 官方引擎可选：强杀登记的子进程/浏览器（Windows 下 taskkill /F /T）
        await engine.engine?.shutdown?.();
      } catch (error) {
        logger('warn', `执行引擎关闭失败：${error instanceof Error ? error.message : String(error)}`);
      }
      closeDatabase(db);
    },
  };
}