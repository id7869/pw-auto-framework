/**
 * 离线集成测试夹具：本地 HTTP 服务（127.0.0.1:0 随机端口），零外网。
 *
 * 路由：
 * - `/`                主页面（标题/h1/hello/输入框/提交按钮）
 * - `/echo?name=...`   渲染「你好，<name>」（数据驱动断言目标）
 * - `/slow?ms=...`     延迟响应（超时/取消用例）
 * - `/flaky?token=...` 同 token 首次 500、之后 200（官方 retries/flaky 语义）
 */

import http from 'node:http';

export interface FixtureServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, helloText: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
<h1>${escapeHtml(title)}</h1>
<div data-testid="hello">${escapeHtml(helloText)}</div>
<input placeholder="姓名" aria-label="姓名">
<button type="button" onclick="document.querySelector('[data-testid=hello]').textContent='已提交'">提交</button>
</body></html>`;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const flakyCounters = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const sendHtml = (status: number, html: string): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    };
    switch (url.pathname) {
      case '/':
        sendHtml(200, page('演示站', '你好，自动化'));
        return;
      case '/echo': {
        const name = url.searchParams.get('name') ?? '';
        sendHtml(200, page('演示站', `你好，${name}`));
        return;
      }
      case '/slow': {
        const delay = Number.parseInt(url.searchParams.get('ms') ?? '5000', 10);
        setTimeout(() => sendHtml(200, page('演示站', '慢响应')), Number.isFinite(delay) ? delay : 5000);
        return;
      }
      case '/flaky': {
        const token = url.searchParams.get('token') ?? 'default';
        const count = (flakyCounters.get(token) ?? 0) + 1;
        flakyCounters.set(token, count);
        if (count === 1) sendHtml(500, page('演示站', '第一次失败'));
        else sendHtml(200, page('演示站', 'ok'));
        return;
      }
      case '/status': {
        const code = Number.parseInt(url.searchParams.get('code') ?? '200', 10);
        sendHtml(Number.isFinite(code) ? code : 200, page('演示站', `status=${code}`));
        return;
      }
      default:
        sendHtml(404, page('未找到', '404'));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('夹具服务未获得 TCP 地址');
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}