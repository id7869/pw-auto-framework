import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createEngine,
  EXPECTED_PLAYWRIGHT_VERSION,
  PlaywrightTestRunner,
  type CaseSnapshot,
} from '../index.ts';
import { interpretPlaywrightVersionProbe, type PlaywrightVersionProbeInput } from '../runner/testRunner.ts';
import { removeDirWithRetry } from './helpers/fs-cleanup.ts';

function probe(overrides: Partial<PlaywrightVersionProbeInput> = {}): PlaywrightVersionProbeInput {
  return {
    exitCode: 0,
    signal: null,
    stdout: 'Version 1.65.0\n',
    stderr: '',
    timedOut: false,
    aborted: false,
    spawnError: null,
    ...overrides,
  };
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pw-version-probe-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await removeDirWithRetry(dir);
});

function fakeCli(exitCode: number, stdout: string, stderr: string): string {
  const dir = tempDir();
  const scriptPath = join(dir, 'fake-cli.cjs');
  writeFileSync(
    scriptPath,
    [stdout, stderr, `process.exit(${exitCode});`].filter((line) => line !== '').join('\n'),
    'utf8',
  );
  return scriptPath;
}

const caseSnapshot: CaseSnapshot = {
  caseId: 'case_version_probe',
  name: '版本探测',
  mode: 'steps',
  steps: [{ id: 's1', action: 'goto', url: 'http://127.0.0.1:9/' }],
  code: null,
  tags: [],
};

describe('runner/testRunner · 严格版本探测（与 API official.ts 语义一致）', () => {
  it('exitCode=0 且无 signal：stdout 严格匹配 Version x.y.z → source=cli', () => {
    const info = interpretPlaywrightVersionProbe(probe(), 'C:\\pw\\cli.js');
    expect(info).toEqual({
      version: '1.65.0',
      source: 'cli',
      cliPath: 'C:\\pw\\cli.js',
      expectedVersion: EXPECTED_PLAYWRIGHT_VERSION,
    });
    expect(info.error).toBeUndefined();

    const prerelease = interpretPlaywrightVersionProbe(probe({ stdout: 'Version 1.66.0-alpha.1\n' }), 'cli.js');
    expect(prerelease.source).toBe('cli');
    expect(prerelease.version).toBe('1.66.0-alpha.1');
  });

  it('输出不严格匹配整串（大小写/额外内容/stderr/缺段）→ fallback + 非空 error', () => {
    const cases = [
      probe({ stdout: 'version 1.65.0\n' }),
      probe({ stdout: 'Version 1.65.0\nnoise\n' }),
      probe({ stdout: '', stderr: 'Version 1.65.0\n' }),
      probe({ stdout: 'Version 1.65\n' }),
      probe({ stdout: 'Playwright 1.65.0\n' }),
    ];
    for (const input of cases) {
      const info = interpretPlaywrightVersionProbe(input, 'cli.js');
      expect(info.source).toBe('fallback');
      expect(info.version).toBe(EXPECTED_PLAYWRIGHT_VERSION);
      expect(info.error).toBeTruthy();
      expect(info.error).toContain('stdout');
    }
  });

  it('非零退出/超时/信号/取消/spawn 失败 → fallback + 非空 error', () => {
    const nonzero = interpretPlaywrightVersionProbe(
      probe({ exitCode: 3, stdout: 'Version 9.9.9\n', stderr: 'boom' }),
      'cli.js',
    );
    expect(nonzero.source).toBe('fallback');
    expect(nonzero.version).toBe(EXPECTED_PLAYWRIGHT_VERSION);
    expect(nonzero.error).toContain('退出码 3');
    expect(nonzero.error).toContain('boom');

    const timedOut = interpretPlaywrightVersionProbe(probe({ exitCode: null, timedOut: true }), 'cli.js');
    expect(timedOut.source).toBe('fallback');
    expect(timedOut.error).toContain('超时');

    const signalled = interpretPlaywrightVersionProbe(probe({ exitCode: null, signal: 'SIGKILL' }), 'cli.js');
    expect(signalled.source).toBe('fallback');
    expect(signalled.error).toContain('SIGKILL');

    const aborted = interpretPlaywrightVersionProbe(probe({ exitCode: null, aborted: true }), 'cli.js');
    expect(aborted.source).toBe('fallback');
    expect(aborted.error).toContain('取消');

    const spawnFailed = interpretPlaywrightVersionProbe(
      probe({ exitCode: null, spawnError: 'ENOENT: no such file' }),
      'cli.js',
    );
    expect(spawnFailed.source).toBe('fallback');
    expect(spawnFailed.error).toContain('ENOENT');
  });

  it('真实 CLI 存在但非零退出（stderr 含 Node 版本）：getPlaywrightInfo fallback + 非空 error', async () => {
    const fake = fakeCli(
      3,
      "process.stdout.write('Version 9.9.9\\n');",
      'process.stderr.write(`node ${process.version}\\n`);',
    );
    const runner = new PlaywrightTestRunner({ playwrightCliPath: fake });
    const info = await runner.getPlaywrightInfo();
    expect(info.available).toBe(false);
    expect(info.version).toBe(EXPECTED_PLAYWRIGHT_VERSION);
    expect(info.cliPath).toBe(fake);
    expect(info.error).toBeTruthy();
    expect(info.error).toContain('退出码 3');
    expect(info.error).toContain(process.version);

    const probeInfo = await runner.getVersionInfo();
    expect(probeInfo.source).toBe('fallback');
    expect(probeInfo.version).toBe(EXPECTED_PLAYWRIGHT_VERSION);
    expect(probeInfo.error).toBeTruthy();
  });

  it('run 在版本探测失败时继续执行，但 environment/diagnostics 记录 fallback 与非空 warning', async () => {
    const fake = fakeCli(3, "process.stdout.write('Version 9.9.9\\n');", "process.stderr.write('boom');");
    const engine = createEngine({ playwrightCliPath: fake });
    try {
      const result = await engine.run(
        {
          runId: 'run_version_fallback',
          workspaceDir: tempDir(),
          dataRoot: tmpdir(),
          caseSnapshot,
          options: {},
        },
        { onPhase: () => {}, signal: new AbortController().signal, logger: () => {} },
      );
      expect(result.error?.code).toBe('ENGINE_ERROR');
      expect(result.environment.playwright).toBe(EXPECTED_PLAYWRIGHT_VERSION);
      expect(result.diagnostics.playwrightVersion).toBe(EXPECTED_PLAYWRIGHT_VERSION);
      expect(result.diagnostics.warnings.some((warning) => warning.includes('版本探测失败'))).toBe(true);
    } finally {
      await engine.shutdown?.();
    }
  }, 60_000);

  it('真实官方 CLI：available=true、真实版本、无 error', async () => {
    const runner = new PlaywrightTestRunner();
    const info = await runner.getPlaywrightInfo();
    expect(info.available).toBe(true);
    expect(info.version).toBe(EXPECTED_PLAYWRIGHT_VERSION);
    expect(info.cliPath?.endsWith('cli.js')).toBe(true);
    expect(info.error).toBeUndefined();
  }, 60_000);
});
