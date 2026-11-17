import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createEngine, AutomationExecutionEngine, type CaseSnapshot, type EngineRunOptions } from '../index.ts';
import { removeDirWithRetry } from './helpers/fs-cleanup.ts';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server.ts';

interface Harness {
  server: FixtureServer;
  engine: AutomationExecutionEngine;
  workspaces: string[];
  workspace: () => string;
}

async function createHarness(): Promise<Harness> {
  const server = await startFixtureServer();
  const engine = createEngine() as AutomationExecutionEngine;
  const workspaces: string[] = [];
  return {
    server,
    engine,
    workspaces,
    workspace: () => {
      const dir = mkdtempSync(join(tmpdir(), 'pw-auto-engine-'));
      workspaces.push(dir);
      return dir;
    },
  };
}

function baseSteps(port: number, name = '自动化'): CaseSnapshot['steps'] {
  return [
    { id: 's1', action: 'goto', url: `http://127.0.0.1:${port}/echo?name=${name}` },
    { id: 's2', action: 'expectVisible', target: { by: 'role', role: 'heading', name: '演示站' } },
    { id: 's3', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: `你好，${name}` },
  ];
}

function snapshotFor(steps: CaseSnapshot['steps'], rows?: CaseSnapshot['rows']): CaseSnapshot {
  return {
    caseId: 'case_1',
    name: '演示用例',
    mode: 'steps',
    steps,
    code: null,
    tags: [],
    ...(rows === undefined ? {} : { rows }),
  };
}

function options(overrides: EngineRunOptions = {}): EngineRunOptions {
  return {
    timeoutMs: 600_000,
    caseTimeoutMs: 60_000,
    retries: 0,
    workers: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    headed: false,
    browser: 'chromium',
    failOnFlaky: false,
    ...overrides,
  };
}

describe('engine.run · 官方 Playwright Test 离线集成', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    for (const dir of harness.workspaces.splice(0)) {
      await removeDirWithRetry(dir);
    }
  });

  afterAll(async () => {
    await harness.engine.shutdown();
    await harness.server.close();
  });

  it('数据驱动 2 行（动态 origin + 页面级等待）→ 编译/校验/运行一致，逐行 itemKey/title/outcome 与产物齐全', async () => {
    const controller = new AbortController();
    const phases: string[] = [];
    const baseUrl = `http://127.0.0.1:${harness.server.port}`;
    const caseSnapshot = snapshotFor(
      [
        { id: 's1', action: 'goto', url: '{{base}}/echo?name={{名字}}' },
        { id: 's2', action: 'waitFor', state: 'visible', timeoutMs: 5000 },
        { id: 's3', action: 'expectVisible', target: { by: 'role', role: 'heading', name: '演示站' } },
        { id: 's4', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '你好，{{名字}}' },
        { id: 's5', action: 'fill', target: { by: 'placeholder', text: '姓名' }, value: '{{名字}}' },
        { id: 's6', action: 'press', key: 'Enter', target: { by: 'placeholder', text: '姓名' } },
        { id: 's7', action: 'setViewport', width: 1280, height: 720 },
        { id: 's8', action: 'screenshot' },
      ],
      [
        { rowIndex: 0, data: { base: baseUrl, 名字: '自动化' } },
        { rowIndex: 1, data: { base: baseUrl, 名字: '张三' } },
      ],
    );

    // create/validate 与 run 必须一致：动态 origin 编译期放行（warning），运行期由官方 page.goto 校验。
    const validated = await harness.engine.compile({ caseSnapshot });
    expect(validated.ok).toBe(true);
    expect(validated.itemKeys).toEqual(['case_1#row:0', 'case_1#row:1']);
    expect(validated.warnings.map((warning) => warning.code)).toContain('DYNAMIC_ORIGIN');

    const result = await harness.engine.run(
      {
        runId: `run_${randomUUID()}`,
        workspaceDir: harness.workspace(),
        dataRoot: tmpdir(),
        caseSnapshot,
        options: options(),
      },
      {
        onPhase: (phase) => phases.push(phase),
        signal: controller.signal,
        logger: () => {},
      },
    );

    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(result.stats).toEqual({ expected: 2, unexpected: 0, flaky: 0, skipped: 0, durationMs: expect.any(Number) });
    expect(result.items.map((item) => item.itemKey)).toEqual(['case_1#row:0', 'case_1#row:1']);
    expect(result.items.map((item) => item.rowIndex)).toEqual([0, 1]);
    expect(result.items.every((item) => item.title.includes('[row:'))).toBe(true);
    expect(result.items.every((item) => item.outcome === 'expected')).toBe(true);
    expect(result.items[0]?.attempts[0]?.status).toBe('passed');
    expect(result.items[0]?.attempts[0]?.steps.length).toBeGreaterThanOrEqual(7);
    expect(result.diagnostics.warnings.some((warning) => warning.includes('编译期跳过协议静态校验'))).toBe(true);

    const kinds = new Set(result.artifacts.map((artifact) => artifact.kind));
    expect(kinds.has('json-report')).toBe(true);
    expect(kinds.has('spec')).toBe(true);
    expect(kinds.has('stdout')).toBe(true);
    expect(kinds.has('stderr')).toBe(true);
    expect(result.artifacts.find((artifact) => artifact.kind === 'json-report')?.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(result.environment.playwright).toBe('1.65.0');
    expect(result.environment.node).toBe(process.versions.node);
    expect(result.environment.timezone.length).toBeGreaterThan(0);
    expect(result.reportPath).toContain('report.json');
    expect(result.diagnostics.specPath).toContain('case_1.spec.ts');
    expect(result.diagnostics.reportPath).toBe(result.reportPath);
    expect(result.diagnostics.playwrightCliPath.endsWith('cli.js')).toBe(true);
    expect(result.diagnostics.command).toContain('test');
    expect(result.diagnostics.workspaceDir.length).toBeGreaterThan(0);
    expect(phases).toEqual(['compile', 'prepare', 'execute', 'parse', 'artifacts', 'done']);
  }, 180_000);

  it('断言失败 → failed，保留官方 error/errorHash 与 trace/截图产物', async () => {
    const result = await harness.engine.run(
      {
        runId: `run_${randomUUID()}`,
        workspaceDir: harness.workspace(),
        dataRoot: tmpdir(),
        caseSnapshot: snapshotFor([
          { id: 's1', action: 'goto', url: `http://127.0.0.1:${harness.server.port}/` },
          { id: 's2', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '不匹配的文本' },
        ]),
        options: options(),
      },
      { onPhase: () => {}, signal: new AbortController().signal, logger: () => {} },
    );

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.stats.unexpected).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.itemKey).toBe('case_1');
    expect(result.items[0]?.outcome).toBe('unexpected');
    const attempt = result.items[0]?.attempts[0];
    expect(attempt?.status).toBe('failed');
    expect(attempt?.error?.message).toContain('toHaveText');
    expect(attempt?.errorHash).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt?.error?.location?.file).toContain('case_1.spec.ts');
    expect(attempt?.steps.length).toBeGreaterThan(0);

    const trace = result.artifacts.find((artifact) => artifact.kind === 'trace');
    const screenshot = result.artifacts.find((artifact) => artifact.kind === 'screenshot');
    expect(trace).toBeDefined();
    expect(trace?.itemKey).toBe('case_1');
    expect(screenshot).toBeDefined();
    expect(screenshot?.itemKey).toBe('case_1');
    expect(trace?.sizeBytes).toBeGreaterThan(0);
  }, 180_000);

  it('重试后通过 → flaky 语义（stats.flaky + attempts[0]=failed/attempts[1]=passed）', async () => {
    const token = randomUUID();
    const result = await harness.engine.run(
      {
        runId: `run_${randomUUID()}`,
        workspaceDir: harness.workspace(),
        dataRoot: tmpdir(),
        caseSnapshot: snapshotFor([
          { id: 's1', action: 'goto', url: `http://127.0.0.1:${harness.server.port}/flaky?token=${token}` },
          { id: 's2', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: 'ok' },
        ]),
        options: options({ retries: 1, failOnFlaky: false, trace: 'off', screenshot: 'off' }),
      },
      { onPhase: () => {}, signal: new AbortController().signal, logger: () => {} },
    );

    expect(result.status).toBe('passed');
    expect(result.stats.flaky).toBe(1);
    expect(result.stats.unexpected).toBe(0);
    expect(result.items[0]?.outcome).toBe('flaky');
    expect(result.items[0]?.attempts).toHaveLength(2);
    expect(result.items[0]?.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);
    expect(result.items[0]?.attempts[0]?.error?.message).toContain('第一次失败');
  }, 180_000);

  it('AbortSignal 取消 → cancelled，进程树被清理', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const runPromise = harness.engine.run(
      {
        runId: `run_${randomUUID()}`,
        workspaceDir: harness.workspace(),
        dataRoot: tmpdir(),
        caseSnapshot: snapshotFor([
          { id: 's1', action: 'goto', url: `http://127.0.0.1:${harness.server.port}/slow?ms=8000` },
        ]),
        options: options(),
      },
      { onPhase: () => {}, signal: controller.signal, logger: () => {} },
    );
    setTimeout(() => controller.abort(), 900);
    const result = await runPromise;
    expect(result.status).toBe('cancelled');
    expect(Date.now() - startedAt).toBeLessThan(60_000);
    expect(harness.engine.getRegistry().size()).toBe(0);
  }, 180_000);

  it('run 级超时（timeoutMs=1500）→ error + RUN_TIMEOUT', async () => {
    const result = await harness.engine.run(
      {
        runId: `run_${randomUUID()}`,
        workspaceDir: harness.workspace(),
        dataRoot: tmpdir(),
        caseSnapshot: snapshotFor([
          { id: 's1', action: 'goto', url: `http://127.0.0.1:${harness.server.port}/slow?ms=8000` },
        ]),
        options: options({ timeoutMs: 1500 }),
      },
      { onPhase: () => {}, signal: new AbortController().signal, logger: () => {} },
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('RUN_TIMEOUT');
    expect(result.error?.message).toContain('运行级超时');
  }, 180_000);

  it('用例级超时（caseTimeoutMs=1200）→ 官方 timedOut 结果，run=failed', async () => {
    const result = await harness.engine.run(
      {
        runId: `run_${randomUUID()}`,
        workspaceDir: harness.workspace(),
        dataRoot: tmpdir(),
        caseSnapshot: snapshotFor([
          { id: 's1', action: 'goto', url: `http://127.0.0.1:${harness.server.port}/slow?ms=8000` },
        ]),
        options: options({ caseTimeoutMs: 1200, trace: 'off', screenshot: 'off' }),
      },
      { onPhase: () => {}, signal: new AbortController().signal, logger: () => {} },
    );
    expect(result.status).toBe('failed');
    expect(result.stats.unexpected).toBe(1);
    const attempt = result.items[0]?.attempts[0];
    expect(attempt?.status).toBe('timedOut');
    expect(attempt?.error?.message.toLowerCase()).toContain('timeout');
  }, 180_000);

  it('官方入口不可用 → NOT_IMPLEMENTED（不伪造结果），compile 仍可用', async () => {
    const unavailable = createEngine({ playwrightCliPath: 'C:\\no-such-dir\\playwright-cli.js' });
    const result = await unavailable.run(
      {
        runId: `run_${randomUUID()}`,
        workspaceDir: harness.workspace(),
        dataRoot: tmpdir(),
        caseSnapshot: snapshotFor(baseSteps(harness.server.port)),
        options: options(),
      },
      { onPhase: () => {}, signal: new AbortController().signal, logger: () => {} },
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('NOT_IMPLEMENTED');
    expect(result.items).toEqual([]);
    // 早失败 run 的版本字段也必须非空（冻结版本占位），便于入库与诊断。
    expect(result.environment.playwright).toBe('1.65.0');
    expect(result.diagnostics.playwrightVersion).toBe('1.65.0');
    expect(result.diagnostics.warnings.some((warning) => warning.includes('入口不可用'))).toBe(true);

    const compiled = await unavailable.compile({ caseSnapshot: snapshotFor(baseSteps(harness.server.port)) });
    expect(compiled.ok).toBe(true);
  }, 60_000);

  it('invalid options 早失败：status=error + VALIDATION_FAILED，environment/diagnostics 版本占位非空', async () => {
    const result = await harness.engine.run(
      {
        runId: `run_${randomUUID()}`,
        workspaceDir: harness.workspace(),
        dataRoot: tmpdir(),
        caseSnapshot: snapshotFor(baseSteps(harness.server.port)),
        options: options({ workers: 9 }),
      },
      { onPhase: () => {}, signal: new AbortController().signal, logger: () => {} },
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(result.items).toEqual([]);
    expect(result.environment.playwright).toBe('1.65.0');
    expect(result.diagnostics.playwrightVersion).toBe('1.65.0');
    expect(result.diagnostics.warnings.some((warning) => warning.includes('options 校验失败'))).toBe(true);
  }, 60_000);

  it('compile error 早失败：INVALID_STEP，且 CLI 路径/版本字段已探测非空', async () => {
    const result = await harness.engine.run(
      {
        runId: `run_${randomUUID()}`,
        workspaceDir: harness.workspace(),
        dataRoot: tmpdir(),
        caseSnapshot: snapshotFor([{ id: 's1', action: 'click' }]),
        options: options(),
      },
      { onPhase: () => {}, signal: new AbortController().signal, logger: () => {} },
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('INVALID_STEP');
    expect(result.items).toEqual([]);
    expect(result.environment.playwright).toBe('1.65.0');
    expect(result.diagnostics.playwrightVersion).toBe('1.65.0');
    expect(result.diagnostics.playwrightCliPath.endsWith('cli.js')).toBe(true);
  }, 60_000);

  it('code 模式标题自带 [row:N]：不产生数据行 itemKey（rowIndex=null，itemKey=caseId）', async () => {
    const code = [
      "import { test, expect } from '@playwright/test';",
      '',
      "test('原生代码 [row:7]', async ({ page }) => {",
      "  await page.setContent('<h1>ok</h1>');",
      "  await expect(page.getByText('ok')).toBeVisible();",
      '});',
      '',
    ].join('\n');
    const result = await harness.engine.run(
      {
        runId: `run_${randomUUID()}`,
        workspaceDir: harness.workspace(),
        dataRoot: tmpdir(),
        caseSnapshot: {
          caseId: 'case_code',
          name: '代码用例 [row:9]',
          mode: 'code',
          steps: [],
          code,
          tags: [],
        },
        options: options({ trace: 'off', screenshot: 'off' }),
      },
      { onPhase: () => {}, signal: new AbortController().signal, logger: () => {} },
    );
    expect(result.status).toBe('passed');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.itemKey).toBe('case_code');
    expect(result.items[0]?.rowIndex).toBeNull();
    expect(result.items[0]?.title).toContain('[row:7]');
  }, 120_000);

  it('compile 校验未知列 → ok=false + UNKNOWN_COLUMN（供 /validate 映射 422）', async () => {
    const compiled = await harness.engine.compile({
      caseSnapshot: snapshotFor(
        [{ id: 's1', action: 'fill', target: { by: 'placeholder', text: '姓名' }, value: '{{不存在}}' }],
        [{ rowIndex: 0, data: { 名字: '张三' } }],
      ),
    });
    expect(compiled.ok).toBe(false);
    expect(compiled.errors[0]?.code).toBe('UNKNOWN_COLUMN');
    expect(compiled.errors[0]?.path).toBe('steps[0].value');
  });
});