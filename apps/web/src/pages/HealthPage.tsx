/**
 * 设置与健康：API 连接状态、官方版本元信息、执行环境摘要（全部只读，不含密钥）。
 * 接口：GET /api/health、GET /api/v1/meta（api-contract §1）。
 */
import { PLAYWRIGHT_VERSION } from '@pw-auto/contracts';
import { useApi } from '../api/context.tsx';
import { useApiResource } from '../hooks/use-api-resource.ts';
import { formatDateTime, formatDuration } from '../lib/format.ts';
import { agentEntryLabel } from '../lib/labels.ts';
import {
  Card,
  EmptyState,
  ErrorState,
  KeyValueList,
  LoadingState,
  Notice,
  PageHeader,
  TagList,
} from '../components/ui.tsx';

/** 静态目录展示：空串/null/undefined 均视为未配置（F5：truthy 判断，不用 ??） */
export function StaticDirValue({ value }: { value: string | null | undefined }) {
  return <span className="mono break-all">{value || '（未配置）'}</span>;
}

export function HealthPage() {  const api = useApi();
  const health = useApiResource(() => api.health(), []);
  const meta = useApiResource(() => api.meta(), []);

  const refresh = (): void => {
    health.reload();
    meta.reload();
  };

  const statusTone = health.data?.status === 'ok' ? 'success' : health.data?.status === 'degraded' ? 'warning' : 'danger';

  return (
    <div className="page">
      <PageHeader
        title="设置与健康"
        description="只读展示后端连接状态、官方版本与执行环境；本页不提供任何修改入口，也不显示密钥。"
        actions={
          <button type="button" className="button" onClick={refresh} disabled={health.loading || meta.loading}>
            {health.loading || meta.loading ? '刷新中…' : '刷新'}
          </button>
        }
      />

      <Notice tone="info" title="连接方式">
        前端通过同源 <code>/api</code> 访问后端（开发态由 Vite 代理到 <code>http://127.0.0.1:8787</code>）；所有数据保存在本机，
        不访问外网。API 响应中的密钥字段一律脱敏，前端不存储任何密钥。
      </Notice>

      <Card title="API 连接状态" description="GET /api/health（供 webServer 探活，失败时后端可能未启动）。">
        {health.loading && !health.data ? <LoadingState label="正在检查后端连接…" /> : null}
        {health.error ? (
          <ErrorState
            error={health.error}
            title="无法连接后端 API"
            onRetry={health.reload}
          />
        ) : health.data ? (
          <>
            <div className="health-banner">
              <span className={`badge badge-${statusTone}`}>
                {health.data.status === 'ok' ? '连接正常' : health.data.status === 'degraded' ? '降级（数据库不可用）' : '未知'}
              </span>
              <span className="muted">数据库：{health.data.db === 'ok' ? '可用' : '不可用'}</span>
              <span className="muted">框架版本：{health.data.version}</span>
              <span className="muted">运行时长：{formatDuration(health.data.uptimeMs)}</span>
            </div>
            {health.data.status === 'degraded' ? (
              <Notice tone="warning" title="后端处于降级状态">
                数据库不可用（db=error）。运行与回归数据可能无法读写，请检查数据目录权限或后端日志。
              </Notice>
            ) : null}
          </>
        ) : null}
      </Card>

      <Card title="官方版本与运行环境" description="GET /api/v1/meta：官方 CLI 绝对路径、浏览器、Node 与系统指纹（不含密钥）。">
        {meta.loading && !meta.data ? <LoadingState label="正在读取版本元信息…" /> : null}
        {meta.error ? <ErrorState error={meta.error} title="版本元信息读取失败" onRetry={meta.reload} /> : null}
        {meta.data ? (
          <>
            {meta.data.versions.playwright !== PLAYWRIGHT_VERSION ? (
              <Notice tone="danger" title="后端 Playwright 版本与冻结版本不一致">
                后端报告 {meta.data.versions.playwright}，框架冻结版本为 {PLAYWRIGHT_VERSION}。请核对依赖冻结与安装结果。
              </Notice>
            ) : (
              <Notice tone="success" title={`官方承重版本一致：@playwright/test ${PLAYWRIGHT_VERSION}`}>
                所有用例执行、结果入库与回归对比均以该版本官方 JSON 报告为准。
              </Notice>
            )}
            <KeyValueList
              ariaLabel="版本信息"
              items={[
                { label: '框架名称', value: meta.data.app?.name ?? '—' },
                { label: 'Node', value: meta.data.versions?.node ?? '—' },
                { label: 'Playwright', value: meta.data.versions?.playwright ?? '—' },
                { label: '官方 CLI 路径', value: <span className="mono break-all">{meta.data.versions?.playwrightCliPath ?? '—'}</span> },
                {
                  label: '浏览器',
                  value: meta.data.versions?.browser
                    ? `${meta.data.versions.browser.name}${meta.data.versions.browser.channel ? ` · 通道 ${meta.data.versions.browser.channel}` : ''}${meta.data.versions.browser.version ? ` · ${meta.data.versions.browser.version}` : ''}`
                    : '—',
                },
                { label: '操作系统', value: meta.data.versions?.os ?? '—' },
              ]}
            />
            <div className="two-col">
              <div>
                <h3>限制</h3>
                <KeyValueList
                  items={[
                    { label: '运行级超时', value: formatDuration(meta.data.limits?.runTimeoutMs ?? 0) },
                    { label: '用例级超时', value: formatDuration(meta.data.limits?.caseTimeoutMs ?? 0) },
                    { label: '并发运行上限', value: meta.data.limits?.maxConcurrentRuns ?? '—' },
                    { label: '产物保留运行数', value: meta.data.limits?.keepRuns ?? '—' },
                    { label: '请求体上限', value: meta.data.limits?.bodyLimitBytes ?? '—' },
                  ]}
                />
              </div>
              <div>
                <h3>环境（只读）</h3>
                <KeyValueList
                  items={[
                    { label: '绑定地址', value: <span className="mono">{meta.data.env?.bindHost ?? '—'}</span> },
                    { label: '端口', value: meta.data.env?.port ?? '—' },
                    { label: '数据目录', value: <span className="mono break-all">{meta.data.env?.dataDir ?? '—'}</span> },
                    {
                      label: '静态目录',
                      value: <StaticDirValue value={meta.data.env?.staticDir} />,
                    },
                    { label: 'CORS 白名单', value: <TagList tags={meta.data.env?.corsOrigins ?? []} /> },
                  ]}
                />
              </div>
            </div>
            <h3>能力开关</h3>
            <KeyValueList
              items={[
                {
                  label: 'MCP',
                  value: meta.data.capabilities?.mcp
                    ? `${meta.data.capabilities.mcp.enabled ? '可用' : '关闭'} · 会话数 ${String(meta.data.capabilities.mcp.sessions)}`
                    : '—',
                },
                {
                  label: 'CLI',
                  value: meta.data.capabilities?.cli
                    ? `${meta.data.capabilities.cli.enabled ? '可用' : '关闭'} · 不安全工具 ${meta.data.capabilities.cli.unsafeEnabled ? '已启用' : '默认关闭'}`
                    : '—',
                },
                {
                  label: 'Agent 入口',
                  value:
                    (meta.data.capabilities?.agents?.entries ?? []).map(agentEntryLabel).join('、') || '—',
                },
                { label: 'SSE', value: meta.data.capabilities?.sse ? '可用（作为轮询增强）' : '未启用（前端使用轮询）' },
                { label: '不安全工具', value: meta.data.capabilities?.unsafeTools ? '已启用（需 PW_ENABLE_UNSAFE_TOOLS=1）' : '默认关闭' },
              ]}
            />
            <p className="muted">最近读取：{formatDateTime(new Date().toISOString())}（每次刷新由后端重新计算）</p>
          </>
        ) : null}
      </Card>

      <Card title="安全与数据边界" description="与 docs/PRD.md §6 一致。">
        <ul className="tight-list">
          <li>后端默认绑定 127.0.0.1，CORS 仅允许本机前端源；不对外提供服务。</li>
          <li>响应不包含密钥、token、cookie 值与 storageState 内容；前端代码与本地存储也不保存任何密钥。</li>
          <li>危险能力（MCP unsafe 工具、CLI run-code/eval、脚手架写入）默认关闭且需要显式确认。</li>
          <li>产物只能通过已登记的产物 ID 读取，禁止按请求参数拼接路径。</li>
          <li>所有运行数据保存在本机数据目录；框架不向任何外部服务发送数据。</li>
        </ul>
      </Card>

      {!health.loading && !health.data && !health.error ? (
        <EmptyState title="暂无健康数据" description="请点击刷新重试。" />
      ) : null}
    </div>
  );
}