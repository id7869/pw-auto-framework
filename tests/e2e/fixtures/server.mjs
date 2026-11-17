/**
 * 验收用的本地被测站点（fixture）。
 *
 * 目的：为 e2e 提供**零外网**的真实被测页面。只使用 Node 内置 `node:http`，
 * 不引入任何依赖；所有响应 `Cache-Control: no-store`（保证 /flaky-once 的重试一定重新请求）。
 *
 * 路由（docs/acceptance-plan.md §1）：
 *   GET /health                  → {"status":"ok"}
 *   GET /                        → 演示首页：h1=演示站、data-testid=hello、列表、表单；?name= 可改问候语
 *   GET /login                   → 登录表单 + 提交后显示「登录成功」
 *   GET /rows?n=3                → 渲染 n 行
 *   GET /flaky-once?token=t      → 同一 token 首次 500，之后 200（供官方 retries→flaky）
 *   GET /slow?ms=5000            → 延迟响应（供超时/取消场景）
 *
 * 用法：node tests/e2e/fixtures/server.mjs --port 4174
 */

import { createServer } from 'node:http';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const inline = args.find((item) => item.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1] !== undefined) return args[index + 1];
  return fallback;
}

const port = Number(argValue('port', process.env['PW_FIXTURE_PORT'] ?? '4174'));
const host = argValue('host', '127.0.0.1');

/** token → 已请求次数（进程内，仅用于 flaky 场景） */
const flakySeen = new Map();

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 2rem; line-height: 1.6; }
  h1 { font-size: 1.6rem; }
  form { display: grid; gap: .6rem; max-width: 22rem; margin-top: 1rem; }
  label { font-weight: 600; }
  input, button { font-size: 1rem; padding: .35rem .5rem; }
  .ok { color: #0a7a2f; }
  .bad { color: #b00020; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function send(req, res, status, body, contentType = 'text/html; charset=utf-8') {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(buffer.byteLength),
    'cache-control': 'no-store',
    'x-fixture-route': req.url ?? '/',
  });
  res.end(buffer);
}

function json(req, res, status, payload) {
  send(req, res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  const pathname = url.pathname;

  if (pathname === '/health') {
    json(req, res, 200, { status: 'ok', fixture: 'pw-e2e', uptimeSec: Math.round(process.uptime()) });
    return;
  }

  if (pathname === '/') {
    const name = url.searchParams.get('name');
    const greeting = name === null || name === '' ? '你好，自动化' : `你好，${name}`;
    send(
      req,
      res,
      200,
      page(
        '演示站',
        `<h1>演示站</h1>
  <p data-testid="hello">${escapeHtml(greeting)}</p>
  <ul data-testid="list">
    <li>第一项</li>
    <li>第二项</li>
    <li>第三项</li>
  </ul>
  <form id="demo-form" data-testid="demo-form">
    <label for="name">名字</label>
    <input id="name" name="name" data-testid="name" autocomplete="off" />
    <label for="note">备注</label>
    <input id="note" name="note" data-testid="note" autocomplete="off" />
    <button type="submit">提交</button>
  </form>
  <p data-testid="form-result" class="ok"></p>
  <script>
    document.getElementById('demo-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var value = document.getElementById('name').value;
      document.getElementById('form-result').textContent = '已提交：' + value;
    });
  </script>`,
      ),
    );
    return;
  }

  if (pathname === '/login') {
    send(
      req,
      res,
      200,
      page(
        '登录',
        `<h1>登录</h1>
  <form id="login-form">
    <label for="username">用户名</label>
    <input id="username" name="username" />
    <label for="password">密码</label>
    <input id="password" name="password" type="password" />
    <label for="role">角色</label>
    <select id="role" name="role">
      <option value="user">用户</option>
      <option value="admin">管理员</option>
    </select>
    <button type="submit">登录</button>
  </form>
  <p data-testid="login-result" class="ok"></p>
  <script>
    document.getElementById('login-form').addEventListener('submit', function (event) {
      event.preventDefault();
      document.querySelector('[data-testid="login-result"]').textContent = '登录成功';
    });
  </script>`,
      ),
    );
    return;
  }

  if (pathname === '/rows') {
    const raw = Number(url.searchParams.get('n') ?? '3');
    const count = Number.isFinite(raw) ? Math.max(0, Math.min(200, Math.trunc(raw))) : 3;
    const items = Array.from({ length: count }, (_, index) => `    <li data-testid="row">第 ${index + 1} 行</li>`).join('\n');
    send(
      req,
      res,
      200,
      page('行列表', `<h1>行列表</h1>\n  <ul data-testid="rows">\n${items}\n  </ul>\n  <p data-testid="count">共 ${count} 行</p>`),
    );
    return;
  }

  if (pathname === '/flaky-once') {
    const token = url.searchParams.get('token') ?? 'default';
    const seen = flakySeen.get(token) ?? 0;
    flakySeen.set(token, seen + 1);
    if (seen === 0) {
      send(req, res, 500, page('首次失败', '<h1>首次失败</h1><p data-testid="flaky-banner">服务暂时不可用（只失败一次）</p>'));
      return;
    }
    send(req, res, 200, page('稳定了', '<h1>稳定了</h1><p data-testid="flaky-banner">服务已恢复</p>'));
    return;
  }

  if (pathname === '/slow') {
    const raw = Number(url.searchParams.get('ms') ?? '5000');
    const delay = Number.isFinite(raw) ? Math.max(0, Math.min(120_000, Math.trunc(raw))) : 5000;
    setTimeout(() => {
      send(req, res, 200, page('慢响应', `<h1>慢响应</h1><p data-testid="slow-done">已等待 ${delay}ms</p>`));
    }, delay);
    return;
  }

  send(req, res, 404, page('未找到', `<h1>未找到</h1><p data-testid="not-found">${escapeHtml(pathname)}</p>`));
});

server.listen(port, host, () => {
  console.log(`[fixture] 被测站点已启动：http://${host}:${port}/health`);
});

function shutdown(signal) {
  console.log(`[fixture] 收到 ${signal}，关闭中…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));