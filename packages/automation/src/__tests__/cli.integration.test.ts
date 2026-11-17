import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AutomationError, createCliAdapter, type CliAdapter } from '../index.ts';
import { removeDirWithRetry } from './helpers/fs-cleanup.ts';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server.ts';

describe('cli/官方 Playwright CLI · 离线集成', () => {
  let server: FixtureServer;
  let adapter: CliAdapter;
  let workDir: string;
  const session = 'pw-cli-test';

  beforeAll(async () => {
    server = await startFixtureServer();
    workDir = mkdtempSync(join(tmpdir(), 'pw-auto-cli-'));
    adapter = createCliAdapter({ allowedWorkDirRoots: [workDir], defaultTimeoutMs: 60_000 });
  });

  afterAll(async () => {
    await adapter?.killAll();
    await server?.close();
    if (workDir !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await removeDirWithRetry(workDir);
    }
  });

  it('open → snapshot --json → close：官方退出码与结构化输出', async () => {
    const open = await adapter.exec({
      argv: ['open', `http://127.0.0.1:${server.port}/`],
      session,
      workDir,
    });
    expect(open.exitCode).toBe(0);
    expect(open.isError).toBe(false);
    expect(open.error).toBeNull();
    const openJson = open.json as { session?: string; pid?: number } | null;
    expect(openJson?.session).toBe(session);
    expect(typeof openJson?.pid).toBe('number');
    expect(open.command).toContain('cli');
    expect(open.command).toContain(`-s=${session}`);
    expect(open.command).toContain('--json');
    expect(open.artifacts.some((artifact) => artifact.kind === 'snapshot')).toBe(true);

    const snapshot = await adapter.exec({ argv: ['snapshot', '--json'], session, workDir });
    expect(snapshot.exitCode).toBe(0);
    expect(Array.isArray(snapshot.parsed)).toBe(true);
    expect(JSON.stringify(snapshot.parsed)).toContain('演示站');
    const json = snapshot.json as { snapshot?: unknown[] } | null;
    expect(Array.isArray(json?.snapshot)).toBe(true);
    expect(snapshot.command.filter((arg) => arg === '--json')).toHaveLength(1);

    const close = await adapter.exec({ argv: ['close'], session, workDir });
    expect(close.exitCode).toBe(0);
    expect((close.json as { status?: string } | null)?.status).toBe('closed');
  }, 120_000);

  it('screenshot --filename：产物被索引（相对 workDir）', async () => {
    const open = await adapter.exec({ argv: ['open', `http://127.0.0.1:${server.port}/`], session, workDir });
    expect(open.exitCode).toBe(0);
    const shot = await adapter.exec({ argv: ['screenshot', '--filename=shot.png'], session, workDir });
    expect(shot.exitCode).toBe(0);
    const artifact = shot.artifacts.find((entry) => entry.path === 'shot.png');
    expect(artifact).toBeDefined();
    expect(artifact?.kind).toBe('screenshot');
    expect(artifact?.contentType).toBe('image/png');
    expect(artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await adapter.exec({ argv: ['close'], session, workDir });
  }, 120_000);

  it('白名单与 unsafe 规则：install/attach/未知命令/run-code 未授权 → CAPABILITY_DISABLED', async () => {
    for (const argv of [['install-browser'], ['install'], ['attach'], ['codegen'], ['config-print']]) {
      await expect(adapter.exec({ argv, workDir })).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
    }
    // run-code：未 confirm / confirm 但 PW_ENABLE_UNSAFE_TOOLS 未开 → 均拒绝。
    await expect(adapter.exec({ argv: ['run-code', '1+1'], workDir })).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
    });
    await expect(
      adapter.exec({ argv: ['run-code', '1+1'], workDir, confirm: true }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
    await expect(adapter.exec({ argv: ['eval', '1+1'], workDir, confirm: true })).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
    });
  });

  it('Windows 绝对路径不作为位置参数（INVALID_PATH）', async () => {
    await expect(adapter.exec({ argv: ['open', 'C:\\Windows\\System32'], workDir })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(adapter.exec({ argv: ['upload', '..\\secret.txt'], workDir })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(adapter.exec({ argv: ['snapshot', '--filename=C:\\tmp\\x.png'], workDir })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('workDir 受控：越出 allowedWorkDirRoots → PATH_FORBIDDEN；缺 workDir → VALIDATION_FAILED', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pw-auto-cli-outside-'));
    await expect(adapter.exec({ argv: ['list'], workDir: outside })).rejects.toMatchObject({
      code: 'PATH_FORBIDDEN',
    });
    await removeDirWithRetry(outside);
    const noDefault = createCliAdapter({ allowedWorkDirRoots: [workDir] });
    await expect(noDefault.exec({ argv: ['list'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('kill-all：官方清理命令可执行且返回结构化 JSON', async () => {
    const result = await adapter.exec({ argv: ['kill-all', '--json'], workDir, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    const json = result.json as { killed?: number } | null;
    expect(typeof json?.killed).toBe('number');
    await adapter.killAll();
  }, 60_000);

  it('官方入口不可用 → NOT_IMPLEMENTED', async () => {
    const unavailable = createCliAdapter({
      playwrightCliPath: 'C:\\no-such-dir\\playwright-cli.js',
      defaultWorkDir: workDir,
    });
    await expect(unavailable.exec({ argv: ['list'] })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });
});