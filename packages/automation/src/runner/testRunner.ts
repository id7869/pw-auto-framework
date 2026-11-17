/**
 * 官方 Playwright Test 执行器。
 *
 * 唯一执行方式：`node <resolved @playwright/test/cli.js> test --config <generated config>`（spawn，shell:false）。
 * 结果唯一来源：官方 JSON reporter 产出的 report.json（不解析 stdout 冒充结果）。
 *
 * 取消/超时：AbortSignal 或 run 级超时 → taskkill /F /T 进程树 → cancelled / RUN_TIMEOUT；
 * 官方 flaky / retry 语义原样保留（stats.flaky + tests[].status + results[].retry）。
 */

import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  CaseSnapshot,
  CompileResult,
  EngineRunContext,
  EngineRunItem,
  EngineRunOptions,
  EngineRunRequest,
  EngineRunResult,
  EngineRunStats,
  EngineRunStatus,
  EnvironmentFingerprint,
  PlaywrightInfo,
  ResolvedEngineRunOptions,
} from '../types.ts';
import { resolveEngineRunOptions } from '../types.ts';
import { AutomationError, toAutomationError } from '../errors.ts';
import { compileCaseSnapshot } from '../compiler/specCompiler.ts';
import {
  EXPECTED_PLAYWRIGHT_VERSION,
  findRepoNodeModules,
  resolvePlaywrightCli,
} from '../playwrightCli.ts';
import { ProcessRegistry, runProcess } from '../process/process-tree.ts';
import { buildPlaywrightConfig } from './config.ts';
import { indexRunArtifacts, toPosixRelative } from './artifacts.ts';
import { parseJsonReport, type ParsedJsonReport } from './jsonReport.ts';

export interface PlaywrightTestRunnerOptions {
  /** 覆盖官方 CLI 路径（仅测试/诊断用；默认自动 resolve）。 */
  playwrightCliPath?: string;
  /** 进程台账（与引擎共享，便于 shutdown 统一清理）。 */
  registry?: ProcessRegistry;
  /** 测试注入：workspace 在仓库外时的 node_modules 目录。 */
  repoNodeModules?: string | null;
  /** 默认 false；PW_HTML_REPORT=1 时额外生成 html 报告（官方 reporter）。 */
  htmlReport?: boolean;
}

/** 编译期 row 上下文：只有编译器确实生成的数据行才允许被 JSON 解析器识别为 row。 */
interface ExpectedRowContext {
  itemKeys: readonly string[];
  rowIndexes: readonly number[];
}

/** 版本探测输入：runProcess 结果的可测子集（便于单测直接构造超时/信号等分支）。 */
export interface PlaywrightVersionProbeInput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError: string | null;
}

/**
 * 版本探测结论（与 apps/api/src/official.ts t23 修法统一）：
 * - source='cli'：仅 exitCode===0 且无 signal/超时/取消/spawn 失败时，stdout 严格匹配 `Version x.y.z`；
 * - source='fallback'：其余所有情况，version=冻结常量，error 必非空。
 */
export interface PlaywrightVersionProbe {
  version: string;
  source: 'cli' | 'fallback';
  cliPath: string;
  error?: string;
  expectedVersion: string;
}

/** 严格匹配官方 `playwright --version` 输出整串：`Version x.y.z[-prerelease]`。 */
const STRICT_VERSION_PATTERN = /^Version\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function clipVersionText(text: string, maxLength = 160): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength)}…`;
}

/**
 * 纯函数：把一次 `node <cli.js> --version` 的进程结果解释为版本结论。
 * 只有 status=0 且无 signal/超时/取消/spawn 失败时才解析 stdout（不把 stderr 混入）；
 * 其它情况一律 fallback 冻结常量并带非空中文 error。
 */
export function interpretPlaywrightVersionProbe(
  result: PlaywrightVersionProbeInput,
  cliPath: string,
): PlaywrightVersionProbe {
  const fallback = (error: string): PlaywrightVersionProbe => ({
    version: EXPECTED_PLAYWRIGHT_VERSION,
    source: 'fallback',
    cliPath,
    error: error === '' ? '版本探测失败（原因未知）' : error,
    expectedVersion: EXPECTED_PLAYWRIGHT_VERSION,
  });

  if (result.spawnError !== null) {
    return fallback(`执行 node <cli.js> --version 失败：${clipVersionText(result.spawnError)}`);
  }
  if (result.timedOut) {
    return fallback('node <cli.js> --version 超时（15000ms）');
  }
  if (result.aborted) {
    return fallback('node <cli.js> --version 被取消');
  }
  if (result.signal !== null) {
    return fallback(`node <cli.js> --version 被信号终止：${String(result.signal)}`);
  }
  if (result.exitCode !== 0) {
    const stderr = clipVersionText(result.stderr ?? '', 120);
    return fallback(
      `node <cli.js> --version 退出码 ${String(result.exitCode)}${stderr === '' ? '' : `：${stderr}`}`,
    );
  }

  // 只解析 stdout；要求整串严格匹配 Version x.y.z。
  const stdout = (result.stdout ?? '').trim();
  const match = STRICT_VERSION_PATTERN.exec(stdout);
  if (match === null || match[1] === undefined) {
    return fallback(`stdout 不匹配严格 "Version x.y.z"：${clipVersionText(stdout)}`);
  }
  return {
    version: match[1],
    source: 'cli',
    cliPath,
    expectedVersion: EXPECTED_PLAYWRIGHT_VERSION,
  };
}

function isInside(rootDir: string, targetPath: string): boolean {
  const relative = path.relative(rootDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function emptyStats(): EngineRunStats {
  return { expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 };
}

function summarizeDiagnostics(result: { stdout: string; stderr: string }): string {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

/** 从编译期 itemKeys 推导数据行号集合（无数据集时为空数组）。 */
export function rowIndexesFromItemKeys(itemKeys: readonly string[]): number[] {
  const rows: number[] = [];
  for (const itemKey of itemKeys) {
    const match = /#row:(\d+)$/.exec(itemKey);
    if (match === null) continue;
    const parsed = Number.parseInt(match[1] ?? '', 10);
    if (Number.isInteger(parsed) && parsed >= 0) rows.push(parsed);
  }
  return rows;
}

export class PlaywrightTestRunner {
  private readonly options: PlaywrightTestRunnerOptions;
  private readonly registry: ProcessRegistry;
  private versionPromise: Promise<PlaywrightVersionProbe> | null = null;
  private cliPathPromise: Promise<string> | null = null;

  constructor(options: PlaywrightTestRunnerOptions = {}) {
    this.options = options;
    this.registry = options.registry ?? new ProcessRegistry();
  }

  getRegistry(): ProcessRegistry {
    return this.registry;
  }

  async resolveCliPath(): Promise<string> {
    if (this.cliPathPromise === null) {
      this.cliPathPromise = (async () => resolvePlaywrightCli(this.options.playwrightCliPath))();
    }
    return this.cliPathPromise;
  }

  async getVersionInfo(): Promise<PlaywrightVersionProbe> {
    if (this.versionPromise === null) {
      this.versionPromise = (async () => {
        const cliPath = await this.resolveCliPath();
        const result = await runProcess(process.execPath, [cliPath, '--version'], {
          timeoutMs: 15_000,
          maxBufferBytes: 64 * 1024,
          registry: this.registry,
          label: 'playwright-version',
        });
        return interpretPlaywrightVersionProbe(
          {
            exitCode: result.exitCode,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: result.timedOut,
            aborted: result.aborted,
            spawnError: result.spawnError,
          },
          cliPath,
        );
      })();
      // 解析失败不缓存（resolveCliPath 抛错时允许下一次重试）；探测结论本身缓存。
      this.versionPromise.catch(() => {
        this.versionPromise = null;
      });
    }
    return this.versionPromise;
  }

  /**
   * 官方入口能力信息。
   * - available === true ⇔ CLI 路径可解析**且**版本探测成功（source='cli'）。
   * - version 恒为非空字符串：探测成功为真实版本，否则为冻结常量（同时 error 非空）。
   */
  async getPlaywrightInfo(): Promise<PlaywrightInfo> {
    try {
      const info = await this.getVersionInfo();
      return {
        available: info.source === 'cli',
        cliPath: info.cliPath,
        version: info.version,
        expectedVersion: EXPECTED_PLAYWRIGHT_VERSION,
        ...(info.error === undefined ? {} : { error: info.error }),
      };
    } catch (error) {
      return {
        available: false,
        cliPath: null,
        version: EXPECTED_PLAYWRIGHT_VERSION,
        expectedVersion: EXPECTED_PLAYWRIGHT_VERSION,
        error: toAutomationError(error).message,
      };
    }
  }

  async compile(caseSnapshot: CaseSnapshot): Promise<CompileResult> {
    return compileCaseSnapshot(caseSnapshot);
  }

  /**
   * 执行一次 run。
   * 任何可预期失败都返回 EngineRunResult（status=error + error.code），便于 apps/api 落库；
   * 不向上抛异常（除非调用方参数完全非法导致无法构造 result，本实现也做了兜底）。
   */
  async run(request: EngineRunRequest, ctx: EngineRunContext): Promise<EngineRunResult> {
    const startedAt = Date.now();
    const warnings: string[] = [];
    let options: ResolvedEngineRunOptions;
    try {
      options = resolveEngineRunOptions(request.options);
    } catch (error) {
      warnings.push(
        `options 校验失败，未探测官方 Playwright 版本；environment.playwright 使用冻结版本 ${EXPECTED_PLAYWRIGHT_VERSION} 占位`,
      );
      return this.buildResult({
        request,
        status: 'error',
        exitCode: null,
        stats: emptyStats(),
        items: [],
        artifacts: [],
        environment: this.fingerprint(null, null),
        reportPath: '',
        error: { code: 'VALIDATION_FAILED', message: toAutomationError(error, 'VALIDATION_FAILED').message },
        diagnostics: {
          playwrightCliPath: '',
          command: [],
          specPath: null,
          reportPath: null,
          workspaceDir: request.workspaceDir,
          warnings,
          playwrightVersion: EXPECTED_PLAYWRIGHT_VERSION,
          browser: String(request.options?.browser ?? 'chromium'),
          nodeVersion: process.versions.node,
          durationMs: Date.now() - startedAt,
        },
      });
    }

    let workspaceDir: string;
    try {
      if (typeof request.workspaceDir !== 'string' || request.workspaceDir.trim() === '') {
        throw new AutomationError('VALIDATION_FAILED', 'workspaceDir 不能为空');
      }
      workspaceDir = path.resolve(request.workspaceDir);
      if (!path.isAbsolute(request.workspaceDir)) {
        throw new AutomationError('VALIDATION_FAILED', `workspaceDir 必须是绝对路径：${request.workspaceDir}`);
      }
      await fs.mkdir(workspaceDir, { recursive: true });
    } catch (error) {
      const automationError = toAutomationError(error, 'VALIDATION_FAILED');
      warnings.push(
        `workspaceDir 校验失败，未探测官方 Playwright 版本；environment.playwright 使用冻结版本 ${EXPECTED_PLAYWRIGHT_VERSION} 占位`,
      );
      return this.buildResult({
        request,
        status: 'error',
        exitCode: null,
        stats: emptyStats(),
        items: [],
        artifacts: [],
        environment: this.fingerprint(null, null),
        reportPath: '',
        error: { code: automationError.code, message: automationError.message },
        diagnostics: {
          playwrightCliPath: '',
          command: [],
          specPath: null,
          reportPath: null,
          workspaceDir: String(request.workspaceDir ?? ''),
          warnings,
          playwrightVersion: EXPECTED_PLAYWRIGHT_VERSION,
          browser: options.browser,
          nodeVersion: process.versions.node,
          durationMs: Date.now() - startedAt,
        },
      });
    }

    const specsDir = path.join(workspaceDir, 'specs');
    const testResultsDir = path.join(workspaceDir, 'test-results');
    const logsDir = path.join(workspaceDir, 'logs');
    const reportPath = path.join(workspaceDir, 'report.json');
    const stdoutLogPath = path.join(logsDir, 'stdout.log');
    const stderrLogPath = path.join(logsDir, 'stderr.log');
    const htmlReportDir = this.options.htmlReport === true ? path.join(workspaceDir, 'playwright-report') : undefined;

    let cliPath = '';
    let command: string[] = [];
    let specPath: string | null = null;
    // 版本探测失败时用冻结版本占位：environment/diagnostics 字段恒非空（早期失败也能入库诊断）。
    let playwrightVersion: string = EXPECTED_PLAYWRIGHT_VERSION;
    let environment = this.fingerprint(null, options.browser);

    const buildError = (code: string, message: string, detail?: unknown): EngineRunResult =>
      this.buildResult({
        request,
        status: 'error',
        exitCode: null,
        stats: emptyStats(),
        items: [],
        artifacts: [],
        environment,
        reportPath: '',
        error: { code, message, ...(detail === undefined ? {} : { detail }) },
        diagnostics: {
          playwrightCliPath: cliPath,
          command,
          specPath,
          reportPath: null,
          workspaceDir,
          warnings,
          playwrightVersion,
          browser: options.browser,
          nodeVersion: process.versions.node,
          durationMs: Date.now() - startedAt,
        },
      });

    if (ctx.signal.aborted) {
      return this.buildResult({
        request,
        status: 'cancelled',
        exitCode: null,
        stats: emptyStats(),
        items: [],
        artifacts: [],
        environment,
        reportPath: '',
        diagnostics: {
          playwrightCliPath: cliPath,
          command,
          specPath,
          reportPath: null,
          workspaceDir,
          warnings,
          playwrightVersion,
          browser: options.browser,
          nodeVersion: process.versions.node,
          durationMs: Date.now() - startedAt,
        },
      });
    }

    try {
      // 0) 官方入口与版本探测（缓存）：在编译/早失败前完成，保证 run 诊断字段非空且可复现。
      try {
        cliPath = await this.resolveCliPath();
        const versionInfo = await this.getVersionInfo();
        playwrightVersion = versionInfo.version;
        environment = this.fingerprint(versionInfo.version, options.browser);
        if (versionInfo.source === 'fallback') {
          warnings.push(
            `官方 Playwright 版本探测失败（${versionInfo.error ?? '原因未知'}），environment.playwright 使用冻结版本 ${EXPECTED_PLAYWRIGHT_VERSION} 占位`,
          );
        } else if (versionInfo.version !== EXPECTED_PLAYWRIGHT_VERSION) {
          warnings.push(
            `官方 Playwright 版本与冻结版本不一致：实际 ${versionInfo.version}，期望 ${EXPECTED_PLAYWRIGHT_VERSION}`,
          );
        }
      } catch (error) {
        const automationError = toAutomationError(error, 'NOT_IMPLEMENTED');
        warnings.push(
          `官方 Playwright 入口不可用（${automationError.message}），environment.playwright 使用冻结版本 ${EXPECTED_PLAYWRIGHT_VERSION} 占位`,
        );
        environment = this.fingerprint(null, options.browser);
        return buildError(automationError.code, automationError.message, automationError.detail);
      }

      // 1) 编译（纯内存） → 2) 落盘 spec/config
      ctx.onPhase('compile');
      const compiled = await compileCaseSnapshot(request.caseSnapshot);
      if (!compiled.ok || compiled.specSource === null || compiled.specFileName === null) {
        const first = compiled.errors[0];
        return buildError(first?.code ?? 'INVALID_STEP', first?.message ?? '用例编译失败', {
          errors: compiled.errors,
        });
      }
      warnings.push(...compiled.warnings.map((warning) => warning.message));
      if (compiled.errors.length > 0) warnings.push(...compiled.errors.map((error) => error.message));
      // 把编译期 itemKeys/行号传入 JSON 解析器：只认编译器确实生成的数据行标记，
      // 避免 case 名或 code 模式标题里自带 [row:N] 时被误判为 row。
      const expectedRows: ExpectedRowContext = {
        itemKeys: compiled.itemKeys,
        rowIndexes: rowIndexesFromItemKeys(compiled.itemKeys),
      };

      ctx.onPhase('prepare');
      await fs.mkdir(specsDir, { recursive: true });
      await fs.mkdir(testResultsDir, { recursive: true });
      await fs.mkdir(logsDir, { recursive: true });
      specPath = path.join(specsDir, compiled.specFileName);
      await fs.writeFile(specPath, compiled.specSource, 'utf8');
      const generated = buildPlaywrightConfig({
        workspaceDir,
        specsDir,
        outputDir: testResultsDir,
        reportPath,
        ...(htmlReportDir === undefined ? {} : { htmlReportDir }),
        options,
      });
      await fs.writeFile(generated.configPath, generated.content, 'utf8');
      await this.ensurePlaywrightResolvable(workspaceDir, warnings);
      command = [process.execPath, cliPath, 'test', '--config', generated.configPath];

      // 3) 执行官方 test
      ctx.onPhase('execute');
      const elapsed = Date.now() - startedAt;
      const remaining = options.timeoutMs - elapsed;
      if (remaining <= 0) {
        return buildError('RUN_TIMEOUT', `运行级超时（${options.timeoutMs}ms）在启动前已耗尽`);
      }
      ctx.logger(`执行官方 Playwright Test：${command.join(' ')}`);
      const processResult = await runProcess(process.execPath, [cliPath, 'test', '--config', generated.configPath], {
        cwd: workspaceDir,
        timeoutMs: remaining,
        signal: ctx.signal,
        registry: this.registry,
        label: `playwright-test:${request.runId}`,
        maxBufferBytes: 4 * 1024 * 1024,
      });

      const stdoutLog = processResult.stdoutTruncated
        ? `${processResult.stdout}\n...[stdout 已截断]\n`
        : processResult.stdout;
      const stderrLog = processResult.stderrTruncated
        ? `${processResult.stderr}\n...[stderr 已截断]\n`
        : processResult.stderr;
      await fs.writeFile(stdoutLogPath, stdoutLog, 'utf8');
      await fs.writeFile(stderrLogPath, stderrLog, 'utf8');

      const baseDiagnostics = {
        playwrightCliPath: cliPath,
        command,
        specPath,
        reportPath: null as string | null,
        workspaceDir,
        warnings,
        playwrightVersion,
        browser: options.browser,
        nodeVersion: process.versions.node,
        durationMs: Date.now() - startedAt,
      };

      if (processResult.aborted) {
        const partial = await this.tryParseReport(reportPath, workspaceDir, request.caseSnapshot, warnings, expectedRows);
        return this.buildResult({
          request,
          status: 'cancelled',
          exitCode: processResult.exitCode,
          stats: partial?.stats ?? emptyStats(),
          items: partial?.items ?? [],
          artifacts: await this.indexArtifacts({
            workspaceDir,
            reportPath,
            stdoutLogPath,
            stderrLogPath,
            specsDir,
            htmlReportDir,
            parsed: partial,
          }),
          environment,
          reportPath: partial === null ? '' : reportPath,
          diagnostics: baseDiagnostics,
        });
      }
      if (processResult.timedOut) {
        const partial = await this.tryParseReport(reportPath, workspaceDir, request.caseSnapshot, warnings, expectedRows);
        return this.buildResult({
          request,
          status: 'error',
          exitCode: processResult.exitCode,
          stats: partial?.stats ?? emptyStats(),
          items: partial?.items ?? [],
          artifacts: await this.indexArtifacts({
            workspaceDir,
            reportPath,
            stdoutLogPath,
            stderrLogPath,
            specsDir,
            htmlReportDir,
            parsed: partial,
          }),
          environment,
          reportPath: partial === null ? '' : reportPath,
          error: {
            code: 'RUN_TIMEOUT',
            message: `运行级超时（${options.timeoutMs}ms），已强杀进程树`,
            detail: { exitCode: processResult.exitCode, stderr: summarizeDiagnostics(processResult) },
          },
          diagnostics: baseDiagnostics,
        });
      }
      if (processResult.spawnError !== null) {
        return buildError('SUBPROCESS_ERROR', `官方 Playwright Test 启动失败：${processResult.spawnError}`);
      }

      // 4) 解析官方 JSON 报告（唯一结果来源）
      ctx.onPhase('parse');
      const parsed = await this.tryParseReport(reportPath, workspaceDir, request.caseSnapshot, warnings, expectedRows);
      if (parsed === null) {
        const artifacts = await this.indexArtifacts({
          workspaceDir,
          reportPath,
          stdoutLogPath,
          stderrLogPath,
          specsDir,
          htmlReportDir,
          parsed: null,
        });
        return this.buildResult({
          request,
          status: 'error',
          exitCode: processResult.exitCode,
          stats: emptyStats(),
          items: [],
          artifacts,
          environment,
          reportPath: '',
          error: {
            code: 'ENGINE_ERROR',
            message: `官方 Playwright Test 未产出 JSON 报告（退出码 ${String(processResult.exitCode)}），详见日志`,
            detail: { stdout: summarizeDiagnostics(processResult) },
          },
          diagnostics: { ...baseDiagnostics, durationMs: Date.now() - startedAt },
        });
      }
      if (parsed.items.length === 0) {
        const artifacts = await this.indexArtifacts({
          workspaceDir,
          reportPath,
          stdoutLogPath,
          stderrLogPath,
          specsDir,
          htmlReportDir,
          parsed,
        });
        return this.buildResult({
          request,
          status: 'error',
          exitCode: processResult.exitCode,
          stats: parsed.stats,
          items: [],
          artifacts,
          environment,
          reportPath,
          error: {
            code: 'ENGINE_ERROR',
            message: '官方 JSON 报告未包含任何 test 结果（0 项），拒绝伪造通过',
            detail: { stdout: summarizeDiagnostics(processResult) },
          },
          diagnostics: { ...baseDiagnostics, reportPath, durationMs: Date.now() - startedAt },
        });
      }
      this.warnOnItemKeyMismatch(compiled, parsed, warnings);
      this.warnOnBrowserLaunchFailure(parsed, warnings);

      // 5) 产物索引
      ctx.onPhase('artifacts');
      const artifacts = await this.indexArtifacts({
        workspaceDir,
        reportPath,
        stdoutLogPath,
        stderrLogPath,
        specsDir,
        htmlReportDir,
        parsed,
      });

      const passed =
        parsed.stats.unexpected === 0 &&
        processResult.exitCode === 0 &&
        (options.failOnFlaky === false || parsed.stats.flaky === 0);
      const status: EngineRunStatus = passed ? 'passed' : 'failed';
      ctx.onPhase('done');
      return this.buildResult({
        request,
        status,
        exitCode: processResult.exitCode,
        stats: parsed.stats,
        items: parsed.items,
        artifacts,
        environment,
        reportPath,
        diagnostics: { ...baseDiagnostics, reportPath, durationMs: Date.now() - startedAt },
      });
    } catch (error) {
      const automationError = toAutomationError(error);
      return buildError(automationError.code, automationError.message, {
        ...(automationError.details === undefined ? {} : { details: automationError.details }),
        ...(automationError.detail === undefined ? {} : { detail: automationError.detail }),
      });
    }
  }

  private async tryParseReport(
    reportPath: string,
    workspaceDir: string,
    snapshot: CaseSnapshot,
    warnings: string[],
    expectedRows: ExpectedRowContext,
  ): Promise<ParsedJsonReport | null> {
    let content: string;
    try {
      content = await fs.readFile(reportPath, 'utf8');
    } catch {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (error) {
      warnings.push(`JSON 报告不是合法 JSON：${(error as Error).message}`);
      return null;
    }
    try {
      const parsed = parseJsonReport(raw, {
        caseId: snapshot.caseId,
        workspaceDir,
        resolveAttachmentRelPath: (absolutePath) =>
          isInside(workspaceDir, absolutePath) ? toPosixRelative(workspaceDir, absolutePath) : undefined,
        expectedItemKeys: expectedRows.itemKeys,
        expectedRowIndexes: expectedRows.rowIndexes,
      });
      warnings.push(...parsed.warnings);
      return parsed;
    } catch (error) {
      warnings.push(`JSON 报告结构不符合官方 schema：${(error as Error).message}`);
      return null;
    }
  }

  private async indexArtifacts(input: {
    workspaceDir: string;
    reportPath: string;
    stdoutLogPath: string;
    stderrLogPath: string;
    specsDir: string;
    htmlReportDir?: string;
    parsed: ParsedJsonReport | null;
  }): Promise<EngineRunResult['artifacts']> {
    const indexed = await indexRunArtifacts({
      workspaceDir: input.workspaceDir,
      reportPath: input.reportPath,
      stdoutLogPath: input.stdoutLogPath,
      stderrLogPath: input.stderrLogPath,
      specsDir: input.specsDir,
      ...(input.htmlReportDir === undefined ? {} : { htmlReportDir: input.htmlReportDir }),
      attachmentItemKeys: input.parsed?.attachmentItemKeys ?? new Map<string, string>(),
    });
    return indexed.artifacts;
  }

  private warnOnItemKeyMismatch(compiled: CompileResult, parsed: ParsedJsonReport, warnings: string[]): void {
    const actual = new Set(parsed.items.map((item) => item.itemKey.replace(/#idx:\d+$/, '')));
    const missing = compiled.itemKeys.filter((key) => !actual.has(key));
    const extra = [...actual].filter((key) => !compiled.itemKeys.includes(key));
    if (missing.length > 0) {
      warnings.push(`编译产物与 JSON 报告 itemKey 不一致，缺少：${missing.slice(0, 10).join(', ')}`);
    }
    if (extra.length > 0) {
      warnings.push(`JSON 报告出现未预期的 itemKey：${extra.slice(0, 10).join(', ')}`);
    }
  }

  private warnOnBrowserLaunchFailure(parsed: ParsedJsonReport, warnings: string[]): void {
    const needsBrowser = parsed.items.some((item) =>
      item.attempts.some((attempt) => {
        const message = attempt.error?.message ?? '';
        return /Executable doesn't exist|browserType\.launch|Please run the following command/i.test(message);
      }),
    );
    if (needsBrowser) {
      warnings.push(
        '浏览器可能未安装：请运行 npx playwright install chromium（本框架默认使用 chromium-1254；Windows 缓存位于 %LOCALAPPDATA%\\ms-playwright）',
      );
    }
  }

  /** workspace 在仓库外时，官方 test 无法从祖先目录解析 @playwright/test；创建 junction 兜底。 */
  private async ensurePlaywrightResolvable(workspaceDir: string, warnings: string[]): Promise<void> {
    const requireFromWorkspace = createRequire(path.join(workspaceDir, 'package.json'));
    try {
      requireFromWorkspace.resolve('@playwright/test');
      return;
    } catch {
      // 继续尝试 junction。
    }
    const nodeModules = path.join(workspaceDir, 'node_modules');
    try {
      await fs.access(nodeModules);
      return;
    } catch {
      // 不存在时才创建。
    }
    const repoNodeModules = this.options.repoNodeModules ?? findRepoNodeModules();
    if (repoNodeModules === null) {
      warnings.push(
        'workspace 位于仓库外且未找到 node_modules：官方 test 无法解析 @playwright/test，可设置 repoNodeModules 或把 run 工作区放在仓库内',
      );
      return;
    }
    try {
      await fs.symlink(repoNodeModules, nodeModules, 'junction');
      warnings.push('workspace 位于仓库外：已创建 node_modules junction 以解析官方 @playwright/test');
    } catch (error) {
      warnings.push(`无法创建 node_modules junction：${(error as Error).message}`);
    }
  }

  private fingerprint(playwrightVersion: string | null, browser: string | null): EnvironmentFingerprint {
    const browserName = browser ?? 'chromium';
    return {
      node: process.versions.node,
      // 版本无法解析时使用冻结版本占位，保证 environment 字段恒为非空（便于入库/诊断）。
      playwright: playwrightVersion ?? EXPECTED_PLAYWRIGHT_VERSION,
      browser: browserName,
      os: `${process.platform}-${process.arch} (${os.release()})`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    };
  }

  private buildResult(input: {
    request: EngineRunRequest;
    status: EngineRunStatus;
    exitCode: number | null;
    stats: EngineRunStats;
    items: EngineRunItem[];
    artifacts: EngineRunResult['artifacts'];
    environment: EnvironmentFingerprint;
    reportPath: string;
    error?: EngineRunResult['error'];
    diagnostics: EngineRunResult['diagnostics'];
  }): EngineRunResult {
    return {
      runId: input.request.runId,
      status: input.status,
      exitCode: input.exitCode,
      stats: input.stats,
      items: input.items,
      artifacts: input.artifacts,
      environment: input.environment,
      reportPath: input.reportPath,
      ...(input.error === undefined ? {} : { error: input.error }),
      diagnostics: input.diagnostics,
    };
  }
}

/** 供 apps/api 在未执行 run 时生成稳定环境指纹（GET /api/v1/meta 等）。 */
export async function readEnvironmentFingerprint(
  runner: PlaywrightTestRunner,
  browser: EngineRunOptions['browser'] = 'chromium',
): Promise<EnvironmentFingerprint> {
  const info = await runner.getPlaywrightInfo();
  return {
    node: process.versions.node,
    playwright: info.version ?? EXPECTED_PLAYWRIGHT_VERSION,
    browser: browser ?? 'chromium',
    os: `${process.platform}-${process.arch} (${os.release()})`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  };
}