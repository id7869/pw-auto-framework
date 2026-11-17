#!/usr/bin/env node
/**
 * pw-auto-test · 确定性模拟 agent（非模型）。
 *
 * 用途：在没有 LLM 的情况下，按 SKILL.md 的编排顺序真实调用框架 HTTP API，验证：
 *   NL → generation(agent) → claim → MCP 探索 → submit steps+stepOrigin → accept
 *      → validate → run → 轮询 → 逐行/产物报告。
 *
 * 它不调用任何模型端点、不直连浏览器、不直接运行 `playwright test`；
 * 只通过框架 API（含框架托管的 MCP 会话）完成验收数据路径。
 *
 * 用法：
 *   node agent-loop.mjs --scenario=full   # 单用例（需可访问 --base-url，默认 4174 fixture）
 *   node agent-loop.mjs --scenario=data   # 数据集 2 行 + 逐行报告
 *   node agent-loop.mjs --scenario=all    # 两者都跑
 *   node agent-loop.mjs --scenario=full --review   # 停在 accept 前，人工确认
 *
 * 依赖：框架 API 已启动（$PW_API_BASE 或 --api-base）；被测页面可访问（--base-url）。
 * 退出码：0 通过；1 运行失败/映射不成立；2 参数或预检失败。
 */

import { PwAutoApi, ApiError } from './api.mjs';

const SKILL_VERSION = 'pw-auto-test/1.0.0';
const DEFAULT_BASE_URL = 'http://127.0.0.1:4174/';

function parseArgs(argv) {
  const options = {
    apiBase: process.env.PW_API_BASE ?? 'http://127.0.0.1:8787',
    baseUrl: process.env.PW_AUTO_TARGET_URL ?? DEFAULT_BASE_URL,
    scenario: 'full',
    review: false,
    keep: false,
    skipMcp: false,
    json: false,
    timeoutMs: 180_000,
  };
  for (const arg of argv) {
    if (arg.startsWith('--api-base=')) options.apiBase = arg.slice('--api-base='.length);
    else if (arg.startsWith('--base-url=')) options.baseUrl = arg.slice('--base-url='.length);
    else if (arg.startsWith('--scenario=')) options.scenario = arg.slice('--scenario='.length);
    else if (arg.startsWith('--timeout-ms=')) options.timeoutMs = Number.parseInt(arg.slice('--timeout-ms='.length), 10);
    else if (arg === '--review') options.review = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--skip-mcp') options.skipMcp = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node agent-loop.mjs [--scenario=full|data|all] [--base-url=URL] [--api-base=URL] [--review] [--keep] [--skip-mcp] [--json]');
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  if (!['full', 'data', 'all'].includes(options.scenario)) {
    console.error(`--scenario 只支持 full|data|all，收到：${options.scenario}`);
    process.exit(2);
  }
  return options;
}

function textLines(text) {
  return text.split(/\r?\n/).map((line, index) => ({ line: index + 1, text: line }));
}

function buildFullScenario(baseUrl) {
  const nlText = [
    '# 场景：打开演示站并确认首屏（确定性模拟，不使用模型）',
    `打开 ${baseUrl}`,
    '页面上应该看到标题「演示站」',
    '页面上应该出现文本「你好，自动化」',
  ].join('\n');
  const lines = textLines(nlText);
  const findLine = (needle, from = 1) => {
    const found = lines.find((line) => line.line >= from && line.text.includes(needle));
    if (!found) throw new Error(`无法在 NL 文本中定位行：${needle}`);
    return found.line;
  };
  const steps = [
    { id: 's1', action: 'goto', url: baseUrl, label: '打开演示站' },
    {
      id: 's2',
      action: 'expectVisible',
      target: { by: 'role', role: 'heading', name: '演示站' },
      label: '标题可见',
    },
    {
      id: 's3',
      action: 'expectText',
      target: { by: 'testId', testId: 'hello' },
      value: '你好，自动化',
      label: '首屏问候',
    },
  ];
  const stepOrigin = {
    s1: { nlLine: findLine('打开 ') },
    s2: { nlLine: findLine('看到标题') },
    s3: { nlLine: findLine('出现文本') },
  };
  return { nlText, steps, stepOrigin, dataset: null };
}

function buildDataScenario(baseUrl) {
  const nlText = [
    '# 场景：数据驱动问候（{{名字}} 来自数据集）',
    `打开 ${baseUrl}?name={{名字}}`,
    '页面上应该出现「你好，{{名字}}」',
  ].join('\n');
  const lines = textLines(nlText);
  const findLine = (needle) => {
    const found = lines.find((line) => line.text.includes(needle));
    if (!found) throw new Error(`无法在 NL 文本中定位行：${needle}`);
    return found.line;
  };
  const steps = [
    { id: 's1', action: 'goto', url: `${baseUrl}?name={{名字}}`, label: '打开带参数页面' },
    {
      id: 's2',
      action: 'expectText',
      target: { by: 'testId', testId: 'hello' },
      value: '你好，{{名字}}',
      label: '逐行问候',
    },
  ];
  const stepOrigin = {
    s1: { nlLine: findLine('打开 ') },
    s2: { nlLine: findLine('出现「') },
  };
  return {
    nlText,
    steps,
    stepOrigin,
    dataset: {
      name: 'skill-agent-loop 数据',
      source: 'manual',
      rows: [
        { data: { 名字: '自动化' } },
        { data: { 名字: '张三' } },
      ],
    },
  };
}

async function preflight(api, options) {
  const health = await api.health();
  if (health?.status !== 'ok') throw new Error(`health 非 ok：${JSON.stringify(health)}`);

  const meta = await api.meta();
  if (meta?.versions?.playwrightSource !== 'cli') {
    throw new Error(
      `预检失败：meta.versions.playwrightSource=${meta?.versions?.playwrightSource}（需 cli；fallback 原因：${meta?.versions?.playwrightVersionError ?? '无'}）`,
    );
  }
  if (meta?.versions?.playwright !== '1.65.0') {
    throw new Error(`预检失败：playwright 版本必须为 1.65.0，实际 ${meta?.versions?.playwright}`);
  }

  const harnesses = await api.harnesses();
  const entries = (harnesses?.items ?? []).map((item) => item.entry);
  for (const entry of ['claude', 'codex', 'deepseek']) {
    if (!entries.includes(entry)) throw new Error(`预检失败：harnesses 缺少 ${entry}`);
  }
  return { health, meta, harnesses };
}

async function exploreWithFrameworkMcp(api, baseUrl, scenarioName) {
  const session = await api.createMcpSession({ headless: true, isolated: true });
  try {
    const navigate = await api.callMcpTool(session.id, 'browser_navigate', { url: baseUrl });
    if (navigate?.isError) {
      throw new Error(`${scenarioName}：框架 MCP browser_navigate 失败：${JSON.stringify(navigate.content)}`);
    }
    const snapshot = await api.callMcpTool(session.id, 'browser_snapshot', {});
    if (snapshot?.isError) {
      throw new Error(`${scenarioName}：框架 MCP browser_snapshot 失败：${JSON.stringify(snapshot.content)}`);
    }
    return { sessionId: session.id, toolCount: (session.tools ?? []).length, snapshotBytes: JSON.stringify(snapshot.content ?? []).length };
  } finally {
    await api.closeMcpSession(session.id).catch(() => {});
  }
}

function formatItem(item) {
  const firstAttempt = item.attempts?.[0];
  return {
    itemKey: item.itemKey,
    rowIndex: item.rowIndex,
    outcome: item.outcome,
    title: item.title,
    durationMs: item.durationMs,
    errorHash: firstAttempt?.errorHash ?? '',
    error: firstAttempt?.error?.message?.split('\n')[0] ?? '',
  };
}

async function runScenario(api, options, scenarioName, definition) {
  const log = (message) => console.log(`[${scenarioName}] ${message}`);
  const report = {
    scenario: scenarioName,
    baseUrl: options.baseUrl,
    steps: definition.steps.length,
    dataset: null,
    generationId: null,
    runId: null,
    status: null,
    stats: null,
    items: [],
    artifacts: [],
    warnings: [],
  };

  let caseId = null;
  try {
    log('创建 NL 用例');
    const created = await api.createCase({
      name: `pw-auto-skill-${scenarioName}`,
      description: 'pw-auto-test skill deterministic agent-loop 验收用例',
      mode: 'steps',
      steps: [],
      tags: ['@skill-agent-loop'],
      nl: { text: definition.nlText },
    });
    caseId = created.id;
    report.caseId = caseId;

    if (definition.dataset) {
      log('创建数据集（manual 行）');
      const dataset = await api.createDataset(caseId, definition.dataset);
      definition.datasetId = dataset.id;
      report.dataset = { id: dataset.id, columns: dataset.columns, rowsCount: dataset.rowsCount };
      if (!Array.isArray(dataset.columns) || !dataset.columns.includes('名字')) {
        throw new Error(`数据集列未包含 名字：${JSON.stringify(dataset.columns)}`);
      }
    }

    log('创建生成任务（generator=agent）');
    const generation = await api.createGeneration(caseId, {
      generator: 'agent',
      hints: { skill: SKILL_VERSION, scenario: scenarioName },
    });
    report.generationId = generation.id;
    if (!Array.isArray(generation.datasetColumns) || generation.datasetColumns.length !== (definition.dataset ? 1 : 0)) {
      throw new Error(`generation.datasetColumns 不符合预期：${JSON.stringify(generation.datasetColumns)}`);
    }
    if (definition.dataset && !generation.datasetColumns.includes('名字')) {
      throw new Error(`generation.datasetColumns 未包含 名字：${JSON.stringify(generation.datasetColumns)}`);
    }

    log('领取任务（claim）');
    const claimed = await api.claimGeneration(generation.id, 120);
    if (claimed.status !== 'running' || typeof claimed.leaseId !== 'string') {
      throw new Error(`claim 未返回 running/leaseId：${JSON.stringify(claimed)}`);
    }

    if (options.skipMcp) {
      log('跳过框架 MCP 探索（--skip-mcp）');
    } else {
      log('通过框架 MCP 会话探索目标（浏览器由框架托管）');
      const mcp = await exploreWithFrameworkMcp(api, options.baseUrl, scenarioName);
      report.mcp = mcp;
    }

    log(`提交 steps（${definition.steps.length} 个）+ stepOrigin`);
    const submitted = await api.submitGeneration(generation.id, {
      leaseId: claimed.leaseId,
      steps: definition.steps,
      warnings: [],
      generatorVersion: SKILL_VERSION,
      stepOrigin: definition.stepOrigin,
      ...(definition.datasetId === undefined ? {} : { datasetId: definition.datasetId }),
    });
    if (submitted.status !== 'ready') throw new Error(`submit 未进入 ready：${submitted.status}`);

    if (options.review) {
      log('--review：已停在 accept 前，请人工确认后 POST accept');
      report.status = 'review';
      report.review = { caseId, generationId: generation.id, caseKept: true, submitted };
      console.log(JSON.stringify(report.review, null, 2));
      return report;
    }

    log('接受生成结果（accept）');
    const accepted = await api.acceptGeneration(caseId, generation.id, false);
    if (accepted?.generation?.status !== 'accepted') {
      throw new Error(`accept 未成功：${JSON.stringify(accepted?.generation?.status)}`);
    }
    if (!Array.isArray(accepted.case?.steps) || accepted.case.steps.length !== definition.steps.length) {
      throw new Error('accept 后 case.steps 数量不符');
    }
    report.acceptedSteps = accepted.case.steps.length;
    report.acceptedStepOrigin = accepted.case.stepOrigin;

    log('编译校验（validate）');
    const validated = await api.validateCase(caseId, definition.datasetId);
    if (!validated?.ok) throw new Error(`validate 失败：${JSON.stringify(validated?.warnings ?? validated)}`);
    report.validate = { stepsCount: validated.stepsCount, rowsCount: validated.rowsCount, warnings: validated.warnings };

    log('创建运行（run）');
    const run = await api.createRun({
      target: { kind: 'case', caseId },
      ...(definition.datasetId === undefined ? {} : { datasetId: definition.datasetId }),
      options: {
        retries: 0,
        workers: 1,
        timeoutMs: 60_000,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'off',
        allowStaleNl: false,
      },
      reason: `${SKILL_VERSION} ${scenarioName}`,
    });
    report.runId = run.id;
    const finished = await api.waitForRun(run.id, { timeoutMs: options.timeoutMs, intervalMs: 500 });
    report.status = finished.status;
    report.stats = finished.stats;
    if (!['passed', 'failed', 'cancelled', 'error'].includes(finished.status)) {
      throw new Error(`run 未在 ${options.timeoutMs}ms 内到达终态：${finished.status}`);
    }

    const itemsPage = await api.getRunItems(run.id, { limit: 100 });
    const items = itemsPage?.items ?? [];
    report.items = items.map(formatItem);

    if (scenarioName === 'data') {
      const expectedRows = definition.dataset.rows.length;
      if (items.length !== expectedRows) throw new Error(`逐行结果数量 ${items.length} != 数据集行数 ${expectedRows}`);
      for (const item of items) {
        if (item.rowIndex === null || item.rowIndex === undefined) throw new Error(`缺少 rowIndex：${item.itemKey}`);
        if (item.itemKey !== `${caseId}#row:${item.rowIndex}`) {
          throw new Error(`itemKey 不符合 caseId#row:N：${item.itemKey}`);
        }
        const rowTag = `[row:${item.rowIndex}]`;
        if (!String(item.title).includes(rowTag)) throw new Error(`标题缺少 ${rowTag}：${item.title}`);
      }
      if (finished.status === 'passed') {
        if (finished.stats?.expected !== expectedRows) throw new Error(`expected=${finished.stats?.expected} != ${expectedRows}`);
      }
    } else if (finished.status === 'passed') {
      if (items.length !== 1) throw new Error(`单用例 item 数应为 1，实际 ${items.length}`);
      if (items[0].itemKey !== caseId) throw new Error(`无数据集 itemKey 应为 caseId，实际 ${items[0].itemKey}`);
    }

    const artifactsPage = await api.getRunArtifacts(run.id, { limit: 100 });
    report.artifacts = (artifactsPage?.items ?? []).map((artifact) => ({
      kind: artifact.kind,
      fileName: artifact.fileName,
      sizeBytes: artifact.sizeBytes,
      itemKey: artifact.itemKey,
    }));

    if (finished.status !== 'passed') {
      report.failure = {
        code: finished.error?.code ?? 'RUN_NOT_PASSED',
        message: finished.error?.message ?? `运行终态 ${finished.status}`,
        items: report.items,
        artifacts: report.artifacts,
        diagnostics: finished.diagnostics,
      };
      log(`运行未通过：${finished.status}；errorHash/产物已输出，可用 healer 处理`);
      return report;
    }
    log(`运行通过：expected=${finished.stats.expected} duration=${finished.stats.durationMs}ms`);
    return report;
  } finally {
    // --review 时保留现场，等待人工 accept；其余情况默认清理临时用例。
    if (caseId !== null && !options.keep && !options.review) {
      try {
        await api.deleteCase(caseId);
      } catch {
        // 清理失败不影响验收结论；--keep 可保留现场。
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const api = new PwAutoApi({ baseUrl: options.apiBase, timeoutMs: 30_000 });
  const results = [];
  try {
    const pre = await preflight(api, options);
    if (!options.json) {
      console.log(`预检通过：health=${pre.health.status} playwright=${pre.meta.versions.playwright}（${pre.meta.versions.playwrightSource}） harnesses=${pre.harnesses.items.length}`);
    }
  } catch (error) {
    console.error(`预检失败：${error instanceof Error ? error.message : String(error)}`);
    console.error('请先启动框架 API（node apps/api/src/main.ts）并确认被测页面可通过 --base-url 访问。');
    process.exitCode = 2;
    return;
  }

  const scenarios = [
    ...(options.scenario === 'full' || options.scenario === 'all' ? [['full', buildFullScenario(options.baseUrl)]] : []),
    ...(options.scenario === 'data' || options.scenario === 'all' ? [['data', buildDataScenario(options.baseUrl)]] : []),
  ];

  for (const [name, definition] of scenarios) {
    try {
      const report = await runScenario(api, options, name, definition);
      results.push(report);
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printSummary(report);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${name}] 失败：${message}`);
      results.push({ scenario: name, status: 'skill-loop-error', error: message });
      process.exitCode = 1;
    }
  }

  if (!options.json) {
    const failed = results.filter((item) => item.status !== 'passed' && item.status !== 'review');
    const reviewCount = results.filter((item) => item.status === 'review').length;
    console.log(`\n汇总：${results.length} 个场景，${failed.length} 个未通过${reviewCount > 0 ? `，${reviewCount} 个等待人工确认` : ''}`);
  }
  if (results.some((item) => item.status !== 'passed' && item.status !== 'review')) process.exitCode = 1;
}

function printSummary(report) {
  console.log(`\n== ${report.scenario} ==`);
  console.log(`case=${report.caseId} generation=${report.generationId} run=${report.runId} status=${report.status}`);
  console.log(`stats=${JSON.stringify(report.stats)}`);
  if (report.items.length > 0) {
    console.log('itemKey\trow\toutcome\tdurationMs\tfirstErrorHash\tfirstError');
    for (const item of report.items) {
      console.log(`${item.itemKey}\t${item.rowIndex ?? '-'}\t${item.outcome}\t${item.durationMs}\t${item.errorHash || '-'}\t${item.error || '-'}`);
    }
  }
  if (report.artifacts.length > 0) console.log(`artifacts=${report.artifacts.map((item) => item.kind).join(',')}`);
}

await main();