/**
 * 独立验收套件配置（官方 @playwright/test 1.65.0）。
 *
 * 启动方式（docs/architecture.md §5.5、docs/acceptance-plan.md §1）：
 *   1) fixture 站点 127.0.0.1:4174  → node tests/e2e/fixtures/server.mjs --port 4174
 *   2) 后端 API     127.0.0.1:8787  → node apps/api/src/main.ts（Node 24 类型剥离源码直跑，不依赖 build）
 *   3) 前端 Web     127.0.0.1:4173  → vite dev（/api 代理到 8787）
 *
 * 隔离与可复现：
 * - testDir 只指向 ./specs（captain F1：绝不允许把 .tmp 下的生成 spec 采集成用例）；
 * - 后端数据目录在系统临时目录（support/env.ts），启动前清空，验收后由执行者清理；
 * - 端口冲突即失败（reuseExistingServer=false + strictPort），不静默换端口。
 */

import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import {
  API_PORT,
  DATA_DIR,
  FIXTURE_PORT,
  PLANTED_SECRET_NAME,
  PLANTED_SECRET_VALUE,
  REPO_ROOT,
  TMP_DIR,
  WEB_PORT,
  WORK_DIR,
} from './support/env.ts';

const here = dirname(fileURLToPath(import.meta.url));

// 只允许在主进程（config 首次求值，早于 webServer 启动）清空数据目录。
// 注意：Playwright 也会在 worker 进程中重新求值 config（TEST_WORKER_INDEX 有值），
// 此时 API 已持有 SQLite 文件锁，删除必然 EPERM——因此必须跳过。
const isWorkerProcess = process.env['TEST_WORKER_INDEX'] !== undefined;
if (!isWorkerProcess && process.env['PW_E2E_KEEP_DATA'] !== '1') {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `无法清空验收数据目录（可能有上一次遗留的 API 进程仍占用文件锁）：${DATA_DIR}；` +
        `请先结束占用进程（或设置 PW_E2E_KEEP_DATA=1 复用数据）。原始错误：${String(error)}`,
    );
  }
}
mkdirSync(TMP_DIR, { recursive: true });

export default defineConfig({
  testDir: join(here, 'specs'),
  testIgnore: ['**/.tmp/**', '**/node_modules/**', '**/test-results/**'],
  outputDir: join(here, 'test-results'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: join(here, 'test-results', 'e2e-report.json') }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // 1) 本地被测站点（零外网）
      command: `node tests/e2e/fixtures/server.mjs --port ${String(FIXTURE_PORT)}`,
      cwd: REPO_ROOT,
      url: `http://127.0.0.1:${String(FIXTURE_PORT)}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // 2) 后端 API：源码直跑（Node 24 类型剥离），数据目录在系统临时目录
      command: 'node apps/api/src/main.ts',
      cwd: REPO_ROOT,
      url: `http://127.0.0.1:${String(API_PORT)}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PW_PORT: String(API_PORT),
        PW_DATA_DIR: DATA_DIR,
        PW_CORS_ORIGINS: `http://127.0.0.1:${String(WEB_PORT)}`,
        PW_LOG_LEVEL: 'info',
        PW_MAX_CONCURRENT_RUNS: '1',
        PW_KEEP_RUNS: '200',
        // 安全抽查用：植入假密钥，任何响应/前端/产物都不得出现其值
        [PLANTED_SECRET_NAME]: PLANTED_SECRET_VALUE,
      },
    },
    {
      // 3) 前端 Vite dev（/api 代理到 8787）
      command: `node node_modules/vite/bin/vite.js --port ${String(WEB_PORT)} --strictPort`,
      cwd: join(REPO_ROOT, 'apps', 'web'),
      url: `http://127.0.0.1:${String(WEB_PORT)}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PW_API_BASE: `http://127.0.0.1:${String(API_PORT)}` },
    },
  ],
});

// 说明：spec 不得 import 本配置文件（导入会再次触发数据目录清理的副作用）；
// 共享常量请从 support/env.ts 读取。