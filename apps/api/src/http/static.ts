/**
 * 生产静态托管（PW_STATIC_DIR，architecture §3.3）：
 * - `/` → index.html；未知前端路由回退 index.html；
 * - 路径穿越防护：拒绝 `..`/绝对路径/UNC，解析后必须仍在静态根内；
 * - 未设置 PW_STATIC_DIR 时完全跳过（不影响 API）。
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { isPathShapedDangerous, isWithinRoot } from '../paths.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function sendFile(res: ServerResponse, absolutePath: string, requestId: string, method: string): void {
  const stat = statSync(absolutePath);
  res.writeHead(200, {
    'content-type': contentTypeFor(absolutePath),
    'content-length': stat.size,
    'cache-control': 'no-store',
    'x-request-id': requestId,
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(absolutePath).pipe(res);
}

/**
 * 尝试以静态资源响应；返回 true 表示已处理。
 * 只接受 GET/HEAD；`/api/*` 一律交回路由层。
 */
export function tryServeStatic(
  req: IncomingMessage,
  res: ServerResponse,
  staticDir: string,
  pathname: string,
  requestId: string,
): boolean {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (pathname.startsWith('/api/')) return false;
  if (!existsSync(staticDir)) return false;

  // 先解码再判危险形态：%2e%2e%2f 之类的编码穿越必须在解析前拦截
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-request-id': requestId });
    res.end('Not Found');
    return true;
  }
  const relativePath = decodedPath.replace(/^\/+/, '');
  if (relativePath !== '' && isPathShapedDangerous(relativePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-request-id': requestId });
    res.end('Not Found');
    return true;
  }

  const candidate = relativePath === '' ? join(staticDir, 'index.html') : resolve(staticDir, relativePath);
  if (!isWithinRoot(staticDir, candidate)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'x-request-id': requestId });
    res.end('Forbidden');
    return true;
  }

  if (existsSync(candidate) && statSync(candidate).isFile()) {
    sendFile(res, candidate, requestId, method);
    return true;
  }

  // 前端 hash 路由不会产生深层 pathname，但仍按 SPA 约定回退到 index.html
  const indexFile = join(staticDir, 'index.html');
  if (existsSync(indexFile)) {
    sendFile(res, indexFile, requestId, method);
    return true;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-request-id': requestId });
  res.end('Not Found');
  return true;
}