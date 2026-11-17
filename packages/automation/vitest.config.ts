import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 集成测试会真实启动 Chromium / MCP / CLI 子进程，串行执行保证稳定与可清理。
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});