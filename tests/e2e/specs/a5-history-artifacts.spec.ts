/**
 * A5 运行历史、产物与跨重启持久化（R3）。
 *
 * 对应 docs/acceptance-plan.md §3 A5：
 *  1. 运行列表游标分页（limit=1 → hasMore=true 且 nextCursor 非空）；
 *  2. 失败运行至少有 1 个 trace 产物，内容端点 200 且长度/类型/sha256 匹配，支持 Range；
 *  3. 停后端 → 用同一数据目录重启 → 旧运行与逐项结果仍可读且字段一致（真实第二个 API 实例）。
 */

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  createCase,
  createRun,
  fetchArtifactContent,
  http,
  listRunArtifacts,
  listRunItems,
  listRuns,
  unwrap,
  waitRun,
} from '../support/api.ts';
import { saveJson } from '../support/evidence.ts';
import { API_ALT_BASE, API_ALT_PORT, API_BASE, FIXTURE_BASE, REPO_ROOT, WORK_DIR } from '../support/env.ts';
import { saveText } from '../support/evidence.ts';
import { spawnServer, waitForHttp, type ServerHandle } from '../support/process.ts';

const SCENARIO = 'a5-history';

test.describe('A5 运行历史与产物', () => {
  test('A5-1 失败运行产出 trace/截图等官方产物，内容端点可按登记信息读取（含 Range）', async () => {
    const created = await createCase({
      name: `A5-失败-${String(Date.now())}`,
      mode: 'steps',
      steps: [
        { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
        { id: 'st_2', action: 'expectText', target: { by: 'testId', testId: 'hello' }, value: '不存在的文案（本用例必然失败）' },
      ],
    });
    const run = await createRun({ target: { kind: 'case', caseId: created.id } });
    const final = await waitRun(run.id);
    expect(final.status).toBe('failed');
    expect(final.stats.unexpected).toBe(1);

    const artifacts = await listRunArtifacts(run.id);
    const kinds = artifacts.items.map((artifact) => artifact.kind);
    expect(kinds).toContain('trace');
    expect(kinds).toContain('json-report');
    expect(kinds).toContain('screenshot');
    expect(kinds).toContain('spec');
    for (const artifact of artifacts.items) {
      expect(artifact.sizeBytes).toBeGreaterThan(0);
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    const trace = artifacts.items.find((artifact) => artifact.kind === 'trace');
    expect(trace).toBeDefined();
    const content = await fetchArtifactContent(run.id, trace?.id as string);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('application/zip');
    expect(content.bytes.byteLength).toBe(trace?.sizeBytes);
    expect(createHash('sha256').update(content.bytes).digest('hex')).toBe(trace?.sha256);
    expect(content.headers.get('content-length')).toBe(String(trace?.sizeBytes));

    // 单段 Range：bytes=0-99 → 206 + content-range
    const ranged = await fetchArtifactContent(run.id, trace?.id as string, '', { range: 'bytes=0-99' });
    expect(ranged.status).toBe(206);
    expect(ranged.bytes.byteLength).toBe(100);
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-99/${String(trace?.sizeBytes)}`);

    // 失败的逐项结果带官方错误、errorLocation 与 step 轨迹
    const items = await listRunItems(run.id);
    expect(items.items.length).toBe(1);
    const attempt = items.items[0]?.attempts[0];
    expect(attempt?.status).toBe('failed');
    expect(attempt?.error?.message ?? '').toMatch(/toHaveText|expect/i);
    expect(attempt?.error?.location?.line).toBeGreaterThan(0);
    expect(attempt?.steps.length).toBe(2);
    expect(attempt?.errorHash).toMatch(/^[0-9a-f]{16,}$/);

    saveJson(SCENARIO, 'artifacts.json', artifacts.items);
    saveJson(SCENARIO, 'items-failed.json', items.items);
    saveJson(SCENARIO, 'range-check.json', {
      size: trace?.sizeBytes,
      sha256: trace?.sha256,
      contentLength: content.bytes.byteLength,
      rangeStatus: ranged.status,
      contentRange: ranged.headers.get('content-range'),
    });
  });

  test('A5-2 运行列表游标分页语义（limit=1 → hasMore 与 nextCursor）', async () => {
    const first = await listRuns('?limit=1');
    expect(first.items.length).toBe(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await listRuns(`?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`);
    expect(second.items.length).toBe(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);

    // 按 caseId 过滤命中真实历史
    const caseId = first.items[0]?.caseId ?? '';
    const filtered = await listRuns(`?limit=100&caseId=${encodeURIComponent(caseId)}`);
    expect(filtered.items.length).toBeGreaterThanOrEqual(1);
    for (const run of filtered.items) expect(run.caseId).toBe(caseId);

    saveJson(SCENARIO, 'pagination.json', {
      first: { id: first.items[0]?.id, hasMore: first.hasMore, nextCursor: first.nextCursor },
      second: { id: second.items[0]?.id, hasMore: second.hasMore },
      filteredCount: filtered.items.length,
      caseId,
    });
  });

  test('A5-3 跨重启持久化：同一数据目录重启后运行/逐项结果字段一致', async () => {
    const persistDir = join(WORK_DIR, 'persist-data');
    rmSync(persistDir, { recursive: true, force: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PW_PORT: String(API_ALT_PORT),
      PW_DATA_DIR: persistDir,
      PW_CORS_ORIGINS: 'http://127.0.0.1:4173',
      PW_LOG_LEVEL: 'warn',
      PW_KEEP_RUNS: '200',
    };

    const startInstance = async (): Promise<ServerHandle> => {
      const handle = spawnServer(process.execPath, ['apps/api/src/main.ts'], { cwd: REPO_ROOT, env });
      await waitForHttp(`${API_ALT_BASE}/api/health`, 60_000);
      return handle;
    };

    const altUnwrap = <T,>(result: Awaited<ReturnType<typeof http>>): T => unwrap<T>(result);

    let handle = await startInstance();
    let runId = '';
    let itemCount = 0;
    let runSnapshot = '';
    let itemsSnapshot = '';
    try {
      expect(handle.pid).toBeGreaterThan(0);
      const created = altUnwrap<{ id: string }>(
        await http('POST', '/api/v1/cases', {
          base: API_ALT_BASE,
          body: {
            name: `A5-重启持久化-${String(Date.now())}`,
            mode: 'steps',
            steps: [
              { id: 'st_1', action: 'goto', url: `${FIXTURE_BASE}/` },
              { id: 'st_2', action: 'expectVisible', target: { by: 'testId', testId: 'hello' } },
            ],
          },
        }),
      );
      const run = altUnwrap<{ id: string }>(
        await http('POST', '/api/v1/runs', {
          base: API_ALT_BASE,
          body: { target: { kind: 'case', caseId: created.id }, options: { timeoutMs: 60_000 } },
        }),
      );
      runId = run.id;

      // 轮询到终态（第二个实例自己的队列）
      const deadline = Date.now() + 120_000;
      let status = 'queued';
      while (Date.now() < deadline) {
        const current = altUnwrap<{ status: string }>(await http('GET', `/api/v1/runs/${runId}`, { base: API_ALT_BASE }));
        status = current.status;
        if (['passed', 'failed', 'cancelled', 'error'].includes(status)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(status).toBe('passed');

      const before = await http('GET', `/api/v1/runs/${runId}`, { base: API_ALT_BASE });
      const beforeItems = await http('GET', `/api/v1/runs/${runId}/items?limit=100`, { base: API_ALT_BASE });
      runSnapshot = JSON.stringify(unwrap(before));
      itemsSnapshot = JSON.stringify(unwrap(beforeItems));
      itemCount = (unwrap<{ items: unknown[] }>(beforeItems).items ?? []).length;
      expect(itemCount).toBe(1);
      saveText(SCENARIO, 'restart-run-before.json', runSnapshot);
    } finally {
      handle.stop();
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    // 用同一 PW_DATA_DIR 重启
    handle = await startInstance();
    try {
      const after = await http('GET', `/api/v1/runs/${runId}`, { base: API_ALT_BASE });
      expect(after.status).toBe(200);
      const afterItems = await http('GET', `/api/v1/runs/${runId}/items?limit=100`, { base: API_ALT_BASE });
      expect(afterItems.status).toBe(200);

      const afterRun = unwrap<{ status: string; stats: unknown; diagnostics: { reportPath: string | null } }>(after);
      expect(afterRun.status).toBe('passed');
      // 字段一致（运行与逐项结果都在 SQLite 中，不是内存态）
      expect(JSON.stringify(unwrap(after))).toBe(runSnapshot);
      expect(JSON.stringify(unwrap(afterItems))).toBe(itemsSnapshot);
      expect(afterRun.diagnostics.reportPath).toBeTruthy();

      saveText(SCENARIO, 'restart-run-after.json', JSON.stringify(unwrap(after)));
      saveJson(SCENARIO, 'restart.json', {
        dataDir: persistDir,
        runId,
        itemCount,
        beforeEqualsAfter: true,
        apiBase: API_BASE,
        altApiBase: API_ALT_BASE,
      });
    } finally {
      handle.stop();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      rmSync(persistDir, { recursive: true, force: true });
    }
  });
});