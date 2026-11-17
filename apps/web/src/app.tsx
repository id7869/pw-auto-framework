/**
 * 应用入口：hash 路由 → 九个页面（架构 §6 固定路由表）。
 * 所有页面共享 ApiProvider（默认同源 /api，开发态由 Vite 代理）。
 */
import { ApiProvider, defaultApi } from './api/context.tsx';
import type { Route } from './lib/hash-router.ts';
import { buildHref, routeTitle } from './lib/hash-router.ts';
import { useDocumentTitle, useRoute } from './hooks/use-route.ts';
import { Shell } from './components/Shell.tsx';
import { EmptyState, PageHeader } from './components/ui.tsx';
import { CasesPage } from './pages/CasesPage.tsx';
import { CaseEditorPage } from './pages/CaseEditorPage.tsx';
import { DatasetsPage } from './pages/DatasetsPage.tsx';
import { SuitesPage } from './pages/SuitesPage.tsx';
import { RunsPage } from './pages/RunsPage.tsx';
import { RunDetailPage } from './pages/RunDetailPage.tsx';
import { RegressionPage } from './pages/RegressionPage.tsx';
import { AgentsPage } from './pages/AgentsPage.tsx';
import { HealthPage } from './pages/HealthPage.tsx';

export function App() {
  const route = useRoute();
  useDocumentTitle(routeTitle(route));
  return (
    <ApiProvider api={defaultApi}>
      <Shell route={route}>{renderRoute(route)}</Shell>
    </ApiProvider>
  );
}

function renderRoute(route: Route) {
  switch (route.name) {
    case 'cases':
      return <CasesPage />;
    case 'case-new':
    case 'case-edit':
      return <CaseEditorPage />;
    case 'datasets':
      return <DatasetsPage />;
    case 'suites':
      return <SuitesPage />;
    case 'runs':
      return <RunsPage />;
    case 'run-detail':
      return <RunDetailPage />;
    case 'regression':
      return <RegressionPage />;
    case 'agents':
      return <AgentsPage />;
    case 'health':
      return <HealthPage />;
    default:
      return <NotFoundPage path={route.path} />;
  }
}

function NotFoundPage({ path }: { path: string }) {
  return (
    <div className="page">
      <PageHeader title="页面不存在" description={`未知路由：${path}`} />
      <EmptyState
        title="没有找到该页面"
        description="可用的页面：测试用例、数据集、套件、运行记录、回归对比、Agent 交接、设置与健康。"
        action={
          <a className="button button-primary" href={buildHref('/cases')}>
            返回测试用例
          </a>
        }
      />
    </div>
  );
}