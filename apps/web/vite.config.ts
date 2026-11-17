import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 前端构建与服务配置（脚手架占位）。
 * - dev 端口固定 5173 且 strictPort（冲突即失败，不静默换端口）
 * - /api 代理到后端 8787（PW_API_BASE 可覆盖）
 * - 工作区内 `@pw-auto/contracts` 暴露的是 .ts 源码，故排除预打包、允许读取仓库根
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    preserveSymlinks: false,
  },
  optimizeDeps: {
    exclude: ['@pw-auto/contracts'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      allow: ['../..'],
    },
    proxy: {
      '/api': {
        target: process.env['PW_API_BASE'] ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
