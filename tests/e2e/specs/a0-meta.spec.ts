/**
 * A0 环境与元信息（需求 R5：官方依据）。
 *
 * 对应 docs/acceptance-plan.md §3 A0：
 *  1. GET /api/health → 200，status=ok、db=ok；
 *  2. GET /api/v1/meta → versions.playwright=1.65.0、playwrightCliPath 真实存在、capabilities.agents.entries=3（三 harness）；
 *  3. node <playwrightCliPath> --version 输出 Version 1.65.0。
 */

import { existsSync, statSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { getHealth, getMeta, http, unwrap } from '../support/api.ts';
import { runOfficialCli } from '../support/official.ts';
import { saveJson, saveText } from '../support/evidence.ts';
import { PLAYWRIGHT_VERSION } from '../support/env.ts';

const SCENARIO = 'a0-meta';

test.describe('A0 环境与元信息', () => {
  test('A0-1 健康检查返回 200 且数据库可用，响应头符合合同', async () => {
    const health = await getHealth();
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(health.requestId).not.toBeNull();
    expect(health.requestId).toMatch(/^req_/);

    const data = unwrap<{ status: string; uptimeMs: number; db: string; version: string }>(health);
    expect(data.status).toBe('ok');
    expect(data.db).toBe('ok');
    expect(data.uptimeMs).toBeGreaterThan(0);
    expect(data.version).toBe('0.1.0');

    saveJson(SCENARIO, 'health.json', { status: health.status, headers: Object.fromEntries(health.headers), data });
  });

  test('A0-2 元信息：官方版本 1.65.0、CLI 路径真实存在、3 个 harness 入口、仅绑定 127.0.0.1', async () => {
    const meta = await getMeta();

    expect(meta.app.name).toBe('pw-auto-framework');
    expect(meta.versions.node).toBe(process.versions.node);
    expect(meta.versions.playwright).toBe(PLAYWRIGHT_VERSION);
    expect(meta.versions.playwrightCliPath).toBeTruthy();
    expect(existsSync(meta.versions.playwrightCliPath)).toBe(true);
    expect(statSync(meta.versions.playwrightCliPath).isFile()).toBe(true);
    expect(meta.versions.playwrightSource).toBe('cli');

    // R7：收敛为三入口（不得出现 6 loop）
    expect(meta.capabilities.agents.entries).toEqual(['claude', 'codex', 'deepseek']);
    expect(meta.capabilities.mcp.enabled).toBe(true);
    expect(meta.capabilities.cli.enabled).toBe(true);
    expect(meta.capabilities.cli.unsafeEnabled).toBe(false);
    expect(meta.capabilities.unsafeTools).toBe(false);

    // 仅本地绑定 + 请求体上限 1 MiB（architecture §7）
    expect(meta.env.bindHost).toBe('127.0.0.1');
    expect(meta.limits['bodyLimitBytes']).toBe(1024 * 1024);
    expect(meta.limits['maxConcurrentRuns']).toBe(1);
    expect(meta.env.dataDir).toContain('pw-e2e-acceptance');

    saveJson(SCENARIO, 'meta.json', meta);
  });

  test('A0-3 官方 @playwright/test 内置 CLI 版本为 1.65.0（独立调用，不经后端）', async () => {
    const result = await runOfficialCli(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(`Version ${PLAYWRIGHT_VERSION}`);
    saveText(SCENARIO, 'cli-version.txt', `exit=${String(result.exitCode)}\nstdout=${result.stdout}\nstderr=${result.stderr}`);

    // 同一路径后端也用于执行（meta 回显 || 后端 diagnostics.playwrightCliPath 一致）
    const meta = await getMeta();
    expect(meta.versions.playwrightCliPath).toMatch(/@playwright[/\\]test[/\\]cli\.js$/);
  });

  test('A0-4 未实现能力的端点返回机器可读错误码（不伪造成功）', async () => {
    // 不存在的资源 → 404 NOT_FOUND（中文 message）
    const missing = await http('GET', '/api/v1/cases/case_not_exists_e2e');
    expect(missing.status).toBe(404);
    const code = (missing.body as { error?: { code?: string; message?: string } }).error?.code;
    expect(code).toBe('NOT_FOUND');
    expect((missing.body as { error?: { message?: string } }).error?.message).toContain('用例不存在');
  });
});