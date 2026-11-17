/**
 * F1 回归：官方 CLI 版本探测的严格语义。
 * - 仅 status===0 且无 signal 才解析 stdout；严格 `Version x.y.z` 整串匹配；
 * - 非零/信号/超时/spawn 失败/解析失败 → version=PLAYWRIGHT_VERSION、source='fallback'、非空 error；
 * - meta 字段（playwrightSource / playwrightVersionError）由 metaVersionFields 统一构造。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAYWRIGHT_VERSION } from '@pw-auto/contracts';
import {
  interpretPlaywrightVersionProbe,
  metaVersionFields,
  probePlaywrightVersion,
  resolvePlaywrightCliPath,
} from '../official.ts';
import { call, cleanupDir, dataOf, makeTempDir, startApi, type TestApi } from './helpers.ts';

let api: TestApi | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  if (api) {
    await api.close();
    cleanupDir(api.dataDir);
    api = null;
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pw-official-version-'));
  tempDirs.push(dir);
  return dir;
}

describe('F1 探测结果解释（纯函数，覆盖官方输出/异常分支）', () => {
  const cliPath = 'C:/fake/cli.js';

  it('status=0 且 stdout 为严格 "Version x.y.z" → source=cli', () => {
    const info = interpretPlaywrightVersionProbe({ status: 0, signal: null, stdout: 'Version 1.65.0\n', stderr: '' }, cliPath);
    expect(info).toMatchObject({ version: '1.65.0', source: 'cli', cliPath, expectedVersion: PLAYWRIGHT_VERSION });
    expect(info.error).toBeUndefined();
    expect(metaVersionFields(info).playwrightVersionError).toBeUndefined();
    expect(metaVersionFields(info).playwrightSource).toBe('cli');
  });

  it('status=0 但 stdout 不匹配严格格式 → fallback + 非空 error（不解析 stderr）', () => {
    for (const stdout of ['', '1.65.0', 'playwright 1.65.0', 'Version 1.65', 'Version v1.65.0']) {
      const info = interpretPlaywrightVersionProbe({ status: 0, signal: null, stdout, stderr: 'Version 1.65.0' }, cliPath);
      expect(info.source).toBe('fallback');
      expect(info.version).toBe(PLAYWRIGHT_VERSION);
      expect(info.error).toBeTruthy();
      expect(metaVersionFields(info).playwrightVersionError).toBeTruthy();
      expect(metaVersionFields(info).playwrightSource).toBe('fallback');
    }
  });

  it('非零退出即使 stdout 有版本也不采信 → fallback（错误含退出码）', () => {
    const info = interpretPlaywrightVersionProbe(
      { status: 3, signal: null, stdout: 'Version 1.65.0', stderr: 'boom' },
      cliPath,
    );
    expect(info.source).toBe('fallback');
    expect(info.version).toBe(PLAYWRIGHT_VERSION);
    expect(info.error).toContain('3');
  });

  it('被信号终止 → fallback（错误含信号名）', () => {
    const info = interpretPlaywrightVersionProbe({ status: null, signal: 'SIGTERM', stdout: 'Version 1.65.0', stderr: '' }, cliPath);
    expect(info.source).toBe('fallback');
    expect(info.version).toBe(PLAYWRIGHT_VERSION);
    expect(info.error).toContain('SIGTERM');
  });

  it('spawn 失败/超时（error 字段）→ fallback + 非空 error', () => {
    for (const error of [
      { message: 'spawn ENOENT', code: 'ENOENT' },
      { message: 'spawnSync node ETIMEDOUT', code: 'ETIMEDOUT' },
    ]) {
      const info = interpretPlaywrightVersionProbe({ status: null, signal: null, stdout: '', stderr: '', error }, cliPath);
      expect(info.source).toBe('fallback');
      expect(info.version).toBe(PLAYWRIGHT_VERSION);
      expect(info.error).toBeTruthy();
      expect(info.error).toContain(error.code);
    }
  });
});

describe('F1 真实探测（spawn）与 meta fallback', () => {
  it('有效 CLI：真实执行 node <cli.js> --version 并与 meta 字段一致', () => {
    const cliPath = resolvePlaywrightCliPath();
    expect(cliPath.endsWith('cli.js')).toBe(true);
    const real = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
    const realVersion = /Version\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(`${real.stdout ?? ''}`)?.[1];
    expect(realVersion).toBeTruthy();

    const info = probePlaywrightVersion(cliPath);
    expect(info.source).toBe('cli');
    expect(info.version).toBe(realVersion);
    expect(info.version).toBe(PLAYWRIGHT_VERSION);
    const fields = metaVersionFields(info);
    expect(fields.playwrightSource).toBe('cli');
    expect(fields.playwrightVersionError).toBeUndefined();
    expect(fields.playwrightCliPath).toBe(cliPath);
  });

  it('无效 path（spawn 失败）→ fallback + 非空 error', () => {
    const dir = tempDir();
    const missing = join(dir, 'no-such-cli.js');
    const info = probePlaywrightVersion(missing);
    expect(info.source).toBe('fallback');
    expect(info.version).toBe(PLAYWRIGHT_VERSION);
    expect(info.error).toBeTruthy();
    expect(info.cliPath).toBe(missing);
    expect(metaVersionFields(info)).toEqual({
      playwright: PLAYWRIGHT_VERSION,
      playwrightCliPath: missing,
      playwrightSource: 'fallback',
      playwrightVersionError: info.error,
    });
  });

  it('超时（脚本 sleep 超过 timeoutMs）→ fallback + 非空 error', () => {
    const dir = tempDir();
    const script = join(dir, 'hang.mjs');
    writeFileSync(script, 'setTimeout(() => {}, 5000);\n', 'utf8');
    const info = probePlaywrightVersion(script, 150);
    expect(info.source).toBe('fallback');
    expect(info.version).toBe(PLAYWRIGHT_VERSION);
    expect(info.error).toBeTruthy();
  });

  it('非零退出脚本 → fallback 且 meta 回显 playwrightVersionError', () => {
    const dir = tempDir();
    const script = join(dir, 'fail.mjs');
    writeFileSync(script, "console.log('Version 1.65.0'); process.exit(7);\n", 'utf8');
    const info = probePlaywrightVersion(script);
    expect(info.source).toBe('fallback');
    expect(info.version).toBe(PLAYWRIGHT_VERSION);
    expect(info.error).toContain('7');
    expect(metaVersionFields(info).playwrightVersionError).toContain('7');
  });

  it('GET /api/v1/meta：注入无效 CLI 路径 → playwrightSource=fallback + 非空 playwrightVersionError', async () => {
    const dir = tempDir();
    const missing = join(dir, 'missing-cli.js');
    api = await startApi({ engine: null, playwrightCliPath: missing });
    const response = await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', '/api/v1/meta');
    expect(response.status).toBe(200);
    const versions = dataOf(response)['versions'];
    expect(versions.playwright).toBe(PLAYWRIGHT_VERSION);
    expect(versions.playwrightSource).toBe('fallback');
    expect(typeof versions.playwrightVersionError).toBe('string');
    expect(versions.playwrightVersionError.length).toBeGreaterThan(0);
    expect(versions.playwrightCliPath).toBe(missing);
  });

  it('GET /api/v1/meta：默认有效 CLI → playwrightSource=cli 且无 playwrightVersionError', async () => {
    api = await startApi({ engine: null });
    const response = await call<{ data: Record<string, any> }>(api.baseUrl, 'GET', '/api/v1/meta');
    const versions = dataOf(response)['versions'];
    expect(versions.playwrightSource).toBe('cli');
    expect(versions.playwrightVersionError).toBeUndefined();
    expect(versions.playwright).toBe(PLAYWRIGHT_VERSION);
  });
});