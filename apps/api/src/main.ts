/**
 * 进程入口：加载配置 → 创建应用 → 监听 → 优雅退出（停止接新、中止活动运行、关闭数据库）。
 * 端口占用：退出码 3 + 中文指引（architecture §3.3，不静默换端口）。
 */

import type { AddressInfo } from 'node:net';
import { ConfigError, loadConfig } from './config.ts';
import { createApplication } from './app.ts';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[pw-auto-api] 配置错误：${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  const app = createApplication({ config });

  app.server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[pw-auto-api] 端口 ${config.port} 已被占用，请设置 PW_PORT 换一个端口后重试。`);
      process.exit(3);
    }
    console.error('[pw-auto-api] 服务启动失败：', error);
    process.exit(1);
  });

  app.server.listen(config.port, config.bindHost, () => {
    const address = app.server.address() as AddressInfo;
    console.log(`[pw-auto-api] 已启动：http://${address.address}:${address.port}（健康检查 /api/health）`);
    console.log(`[pw-auto-api] 数据目录：${config.dataDir}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[pw-auto-api] 收到 ${signal}，正在关闭（中止活动运行并关闭数据库）…`);
    void safeClose().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  const safeClose = async (): Promise<void> => {
    try {
      await app.close();
    } catch (error) {
      console.error('[pw-auto-api] 关闭过程出错：', error);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();