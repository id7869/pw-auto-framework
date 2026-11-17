import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../errors.ts';
import { assertWithinRoot, isWithinRoot, resolveRelative } from '../paths.ts';
import { call, cleanupDir, makeTempDir, startApiIn, type TestApi } from './helpers.ts';
import { createFakeEngine } from './fake-engine.ts';

/** 裸 TCP 请求：绕过 fetch/undici 的 URL 归一化，验证服务端对原始路径的判定 */
async function rawGet(baseUrl: string, path: string): Promise<{ status: number; body: string }> {
  const url = new URL(baseUrl);
  const port = Number(url.port);
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    socket.on('end', () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0);
      const separator = data.indexOf('\r\n\r\n');
      resolve({ status, body: separator >= 0 ? data.slice(separator + 4) : data });
    });
    socket.on('error', reject);
  });
}

const dirs: string[] = [];
const apis: TestApi[] = [];

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close();
  for (const dir of dirs.splice(0)) cleanupDir(dir);
});

describe('路径防护（纯函数）', () => {
  const root = join('C:', 'data', 'runs', 'run_1');

  it('拒绝 ../ 绝对路径 / UNC / 盘符 / NUL', () => {
    for (const evil of ['../secret', '..\\secret', '/etc/passwd', 'C:\\Windows\\win.ini', '\\\\server\\share', 'a\0b']) {
      expect(() => resolveRelative(root, evil)).toThrowError(AppError);
    }
  });

  it('合法相对路径解析到受控根内', () => {
    const resolved = resolveRelative(root, 'case-0/report.json');
    expect(isWithinRoot(root, resolved)).toBe(true);
  });

  it('越界断言抛出 PATH_FORBIDDEN（403）', () => {
    try {
      assertWithinRoot(root, join(root, '..', 'other', 'x.txt'));
      throw new Error('应当抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('PATH_FORBIDDEN');
      expect((error as AppError).status).toBe(403);
    }
  });
});

describe('静态托管与越界访问', () => {
  it('托管 index.html 且拒绝路径穿越（含编码变体）', async () => {
    const dataDir = makeTempDir();
    dirs.push(dataDir);
    const staticDir = join(dataDir, 'static');
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>pw</title>', 'utf8');
    writeFileSync(join(staticDir, 'app.js'), 'console.log(1);', 'utf8');
    writeFileSync(join(dataDir, 'secret.txt'), 'TOP_SECRET', 'utf8');

    const api = await startApiIn(dataDir, { engine: createFakeEngine(), config: { staticDir } });
    apis.push(api);

    const index = await call(api.baseUrl, 'GET', '/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(index.text).toContain('pw');

    const script = await call(api.baseUrl, 'GET', '/app.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');

    for (const evil of ['/..%2fsecret.txt', '/..%5csecret.txt']) {
      const response = await call(api.baseUrl, 'GET', evil);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('TOP_SECRET');
    }

    // fetch/undici 会先把 `/../`、`/%2e%2e/` 归一化掉，故用裸 TCP 请求验证服务端对原始路径的判定
    for (const rawPath of ['/../secret.txt', '/%2e%2e/secret.txt', '/a/../../secret.txt']) {
      const raw = await rawGet(api.baseUrl, rawPath);
      expect(raw.status).toBe(404);
      expect(raw.body).not.toContain('TOP_SECRET');
    }

    // API 路由优先于静态回退
    const health = await call(api.baseUrl, 'GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toContain('application/json');
  });

  it('未配置静态目录时 / 返回 404 JSON（不误吞 API 路由）', async () => {
    const dataDir = makeTempDir();
    dirs.push(dataDir);
    const api = await startApiIn(dataDir, { engine: createFakeEngine() });
    apis.push(api);
    const response = await call(api.baseUrl, 'GET', '/');
    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

describe('请求与响应安全', () => {
  it('所有错误响应都带 X-Request-Id 与机器可读 code', async () => {
    const dataDir = makeTempDir();
    dirs.push(dataDir);
    const api = await startApiIn(dataDir, { engine: createFakeEngine() });
    apis.push(api);

    const response = await call(api.baseUrl, 'GET', '/api/v1/cases/case_missing');
    expect(response.status).toBe(404);
    const body = response.body as { error: { code: string; message: string; requestId: string } };
    expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toMatch(/[\u4e00-\u9fa5]/);
  });

  it('请求体上限 413 与 Content-Type 415 均在业务逻辑前拦截', async () => {
    const dataDir = makeTempDir();
    dirs.push(dataDir);
    const api = await startApiIn(dataDir, { engine: createFakeEngine() });
    apis.push(api);

    const tooLarge = await call(api.baseUrl, 'POST', '/api/v1/cases', undefined, {
      rawBody: JSON.stringify({ name: 'x', description: 'a'.repeat(1024 * 1024 + 1) }),
    });
    expect(tooLarge.status).toBe(413);

    const wrongType = await call(api.baseUrl, 'PUT', '/api/v1/datasets/ds_x/rows', undefined, {
      rawBody: 'rows=1',
      omitContentType: true,
    });
    expect(wrongType.status).toBe(415);
  });
});