import { defineConfig } from 'vitest/config';

/**
 * apps/api 单测配置（t14 集成期最小修复：仅测试超时，无产品行为变更）。
 *
 * 背景：根脚本 `pnpm -r run test:unit` 会让各包 test:unit **并行**执行；
 * packages/automation 的集成测试会真实启动 Chromium/MCP/CLI 子进程（约 57s），
 * 与 apps/api 的用例争用 CPU。api 用例中存在真实 spawn `node <cli.js> --version`
 * 的探测（约 0.45s，单独跑 2.9s），在并发压力下会超过 vitest 默认 5s，
 * 造成根门禁偶发 `Test timed out in 5000ms`（t14 复现：8/108、1/108 两次失败）。
 *
 * 修复原则：**不放宽任何断言、不跳过任何用例**，只给测试超时留出机器并发余量；
 * 与 packages/automation/vitest.config.ts 的既有约定保持一致（该包为串行 + 长超时）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
