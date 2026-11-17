/**
 * A8 官方 CLI（需求 R2）：官方 `playwright cli` 独立调用 + 框架白名单执行端点。
 *
 * 对应 docs/acceptance-plan.md §3 A8：
 *  - 独立：cli list / open / snapshot --json / close / kill-all，记录版本、输出与退出码；
 *  - 框架：open→snapshot→close 全链路 exitCode=0；
 *  - 白名单：install-browser / attach 永久拒绝；run-code 需 confirm 且 unsafe 未开仍拒绝；
 *  - 工程纪律：URL 作为 argv 元素传递（含 `&` 不被 shell 拆分），不拼命令行。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { cliExec, errorCodeOf, http, unwrap } from '../support/api.ts';
import { saveJson, saveText } from '../support/evidence.ts';
import { DATA_DIR, FIXTURE_BASE, PLAYWRIGHT_VERSION, WORK_DIR } from '../support/env.ts';
import { runOfficialCli } from '../support/official.ts';
import { countBrowserProcesses, countBrowserProcessesWithMarker } from '../support/process.ts';
import type { CliExecResult } from '../support/types.ts';

const SCENARIO = 'a8-cli';

test.describe('A8 官方 CLI', () => {
  test('A8-1 独立调用官方 CLI：list/open/snapshot/close/kill-all 全部 exitCode=0', async () => {
    const cwd = join(WORK_DIR, 'cli-direct');
    mkdirSync(cwd, { recursive: true });
    const session = 'pw-e2e-direct';

    const versionResult = await runOfficialCli(['--version'], { cwd });
    expect(versionResult.exitCode).toBe(0);
    expect(versionResult.stdout.trim()).toBe(`Version ${PLAYWRIGHT_VERSION}`);

    const listResult = await runOfficialCli(['cli', 'list'], { cwd });
    expect(listResult.exitCode).toBe(0);

    const openResult = await runOfficialCli(['cli', `-s=${session}`, 'open', `${FIXTURE_BASE}/?a=1&b=2`], { cwd, timeoutMs: 120_000 });
    expect(openResult.exitCode).toBe(0);

    const snapshotResult = await runOfficialCli(['cli', `-s=${session}`, 'snapshot', '--json'], { cwd, timeoutMs: 120_000 });
    expect(snapshotResult.exitCode).toBe(0);
    // 官方 --json 输出为 JSON 对象（snapshot 为数组），且页面内容来自本地 fixture（说明 `&` 未被 shell 拆分）
    const parsed = JSON.parse(snapshotResult.stdout) as { snapshot?: unknown };
    expect(Array.isArray(parsed.snapshot)).toBe(true);
    expect(snapshotResult.stdout).toContain('演示站');

    const closeResult = await runOfficialCli(['cli', `-s=${session}`, 'close'], { cwd, timeoutMs: 120_000 });
    expect(closeResult.exitCode).toBe(0);

    const killAll = await runOfficialCli(['cli', 'kill-all'], { cwd, timeoutMs: 120_000 });
    expect(killAll.exitCode).toBe(0);

    saveText(
      SCENARIO,
      'official-cli.txt',
      [
        `cwd=${cwd}`,
        `version exit=${String(versionResult.exitCode)} stdout=${versionResult.stdout.trim()}`,
        `list exit=${String(listResult.exitCode)} stdout=${listResult.stdout.trim().slice(0, 400)}`,
        `open exit=${String(openResult.exitCode)} stdout=${openResult.stdout.trim().slice(0, 400)} stderr=${openResult.stderr.trim().slice(0, 200)}`,
        `snapshot exit=${String(snapshotResult.exitCode)} stdoutLen=${String(snapshotResult.stdout.length)}`,
        `close exit=${String(closeResult.exitCode)}`,
        `kill-all exit=${String(killAll.exitCode)}`,
      ].join('\n'),
    );
    saveText(SCENARIO, 'official-snapshot.json', snapshotResult.stdout);
  });

  test('A8-2 框架 CLI 端点：白名单命令真实执行；安装类/注入类一律拒绝', async () => {
    const chromeBaseline = countBrowserProcesses();
    const session = 'pw-e2e-api';

    const commands = await http('GET', '/api/v1/cli/commands');
    expect(commands.status).toBe(200);
    const allowList = unwrap<{ allow: string[]; needsConfirm: string[]; deny: string[] }>(commands);
    expect(allowList.allow.length).toBe(72);
    expect(allowList.allow).toContain('open');
    expect(allowList.allow).toContain('snapshot');
    expect(allowList.needsConfirm).toEqual(['run-code', 'eval']);
    expect(allowList.deny).toEqual(['install', 'install-browser', 'attach', 'config-print']);

    // open（URL 含 & 查询串，作为 argv 元素传递）
    const open = await cliExec({ argv: ['open', `${FIXTURE_BASE}/?a=1&b=2`], session });
    expect(open.status).toBe(200);
    const openData = unwrap<CliExecResult>(open);
    expect(openData.exitCode).toBe(0);
    expect(openData.artifacts.map((artifact) => artifact.kind)).toContain('snapshot');

    // snapshot --json
    const snapshot = await cliExec({ argv: ['snapshot', '--json'], session });
    expect(snapshot.status).toBe(200);
    const snapshotData = unwrap<CliExecResult>(snapshot);
    expect(snapshotData.exitCode).toBe(0);
    expect(snapshotData.json).not.toBeNull();
    expect(Array.isArray((snapshotData.json as { snapshot?: unknown }).snapshot)).toBe(true);
    expect(snapshotData.stdout).toContain('演示站');

    // close
    const close = await cliExec({ argv: ['close'], session });
    expect(close.status).toBe(200);
    expect(unwrap<CliExecResult>(close).exitCode).toBe(0);

    // 白名单负路径
    const install = await cliExec({ argv: ['install-browser'] });
    expect(install.status).toBe(403);
    expect(errorCodeOf(install)).toBe('CAPABILITY_DISABLED');
    const attach = await cliExec({ argv: ['attach'] });
    expect(attach.status).toBe(403);
    const unknown = await cliExec({ argv: ['rm-rf', '/'] });
    expect(unknown.status).toBe(403);
    const runCode = await cliExec({ argv: ['run-code', '1+1'] });
    expect(runCode.status).toBe(403);
    const runCodeConfirm = await cliExec({ argv: ['run-code', '1+1'], confirm: true });
    expect(runCodeConfirm.status).toBe(403); // PW_ENABLE_UNSAFE_TOOLS 未开

    // 工作目录越界（路径参数 → INVALID_PATH；合同 §10 对含 .. 的路径参数定义为 400）
    const traversal = await cliExec({ argv: ['list'], workDir: '../../' });
    expect(traversal.status).toBe(400);
    expect(errorCodeOf(traversal)).toBe('INVALID_PATH');

    // 收尾：官方 kill-all 保证无残留 CLI 会话
    const killAll = await cliExec({ argv: ['kill-all'] });
    expect(killAll.status).toBe(200);
    expect(unwrap<CliExecResult>(killAll).exitCode).toBe(0);

    const deadline = Date.now() + 25_000;
    let chromeAfter = countBrowserProcessesWithMarker(DATA_DIR);
    while (Date.now() < deadline && chromeAfter.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      chromeAfter = countBrowserProcessesWithMarker(DATA_DIR);
    }
    expect(chromeAfter).toEqual([]);

    saveJson(SCENARIO, 'framework-cli.json', {
      session,
      allowCount: allowList.allow.length,
      open: { exitCode: openData.exitCode, stdout: openData.stdout.slice(0, 400), artifacts: openData.artifacts },
      snapshot: { exitCode: snapshotData.exitCode, jsonKeys: Object.keys((snapshotData.json as object) ?? {}), stdoutLen: snapshotData.stdout.length },
      close: { exitCode: unwrap<CliExecResult>(close).exitCode },
      negative: {
        install: install.body,
        attach: attach.body,
        unknown: unknown.body,
        runCode: runCode.body,
        runCodeConfirm: runCodeConfirm.body,
        traversal: traversal.body,
      },
      processCount: { chromeBaselineGlobal: chromeBaseline, chromeAfterGlobal: countBrowserProcesses(), chromeAfterDataDir: chromeAfter.length },
    });
  });
});