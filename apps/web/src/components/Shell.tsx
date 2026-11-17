/**
 * 应用外壳：左侧导航 + 主内容区 + 页脚官方依据。
 * 无障碍：跳过导航按钮（hash 路由下不能用 #anchor）、nav 地标、main tabIndex。
 */
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { APP_NAME, APP_VERSION, PLAYWRIGHT_VERSION } from '@pw-auto/contracts';
import type { Route } from '../lib/hash-router.ts';
import { NAV_ITEMS, buildHref, navItemFor, routeTitle } from '../lib/hash-router.ts';

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const mainRef = useRef<HTMLElement>(null);
  const active = navItemFor(route);

  const focusMain = (): void => {
    mainRef.current?.focus();
  };

  return (
    <div className="app-shell">
      <button type="button" className="skip-link" onClick={focusMain}>
        跳到主内容
      </button>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-name">{APP_NAME}</span>
          <span className="brand-tag">官方 Playwright 承重 · 中文测试平台</span>
        </div>
        <nav aria-label="主导航">
          <ul className="nav-list">
            {NAV_ITEMS.map((item) => {
              const isActive = active?.path === item.path;
              return (
                <li key={item.path}>
                  <a
                    className={`nav-link${isActive ? ' is-active' : ''}`}
                    href={buildHref(item.path)}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <span className="nav-label">{item.label}</span>
                    <span className="nav-desc">{item.description}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="sidebar-meta">
          <p className="meta-line">
            框架版本 <strong>{APP_VERSION}</strong>
          </p>
          <p className="meta-line">
            官方承重 <strong>@playwright/test {PLAYWRIGHT_VERSION}</strong>
          </p>
          <p className="meta-note">
            本框架不内置模型：规划 / 生成 / 修复由外部 coding agent 依据官方 Agent 定义完成。
          </p>
        </div>
      </aside>

      <main id="main-content" className="main" tabIndex={-1} ref={mainRef} aria-label="主内容">
        <div className="topbar">
          <span className="crumb">
            {routeTitle(route)}
            {route.name === 'not-found' ? `（${route.path}）` : ''}
          </span>
          <span className="topbar-note">本地单机 · API 默认 127.0.0.1:8787 · 中文界面</span>
        </div>
        <div className="main-inner">{children}</div>
        <footer className="app-footer">
          <p>
            官方依据：
            <a href="https://playwright.dev/docs/test-agents" target="_blank" rel="noreferrer">
              Playwright Test Agents
            </a>
            {' · '}
            <a href="https://playwright.dev/mcp/introduction" target="_blank" rel="noreferrer">
              MCP
            </a>
            {' · '}
            <a href="https://playwright.dev/agent-cli/introduction" target="_blank" rel="noreferrer">
              CLI
            </a>
            {' · '}
            <a href="https://playwright.dev/docs/test-reporters" target="_blank" rel="noreferrer">
              JSON 报告
            </a>
          </p>
          <p className="muted">
            结果口径：官方 Playwright JSON 报告；基线/对比/归因属胶水层计算并在界面标注。所有运行均在本地执行，不访问外网。
          </p>
        </footer>
      </main>
    </div>
  );
}