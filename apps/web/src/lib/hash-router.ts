/**
 * 自研 hash 路由（架构 §6 固定路由表，不引入 react-router）。
 * 路由： #/cases、#/cases/new、#/cases/:id/edit、#/datasets、#/suites、
 *        #/runs、#/runs/:id、#/regression、#/agents、#/health
 */

export type RouteName =
  | 'cases'
  | 'case-new'
  | 'case-edit'
  | 'datasets'
  | 'suites'
  | 'runs'
  | 'run-detail'
  | 'regression'
  | 'agents'
  | 'health'
  | 'not-found';

export interface RouteQuery {
  [key: string]: string;
}

export type Route =
  | { name: 'cases'; query: RouteQuery }
  | { name: 'case-new'; query: RouteQuery }
  | { name: 'case-edit'; caseId: string; query: RouteQuery }
  | { name: 'datasets'; caseId?: string; datasetId?: string; query: RouteQuery }
  | { name: 'suites'; suiteId?: string; query: RouteQuery }
  | { name: 'runs'; status?: string; query: RouteQuery }
  | { name: 'run-detail'; runId: string; query: RouteQuery }
  | { name: 'regression'; comparisonId?: string; baselineId?: string; query: RouteQuery }
  | { name: 'agents'; query: RouteQuery }
  | { name: 'health'; query: RouteQuery }
  | { name: 'not-found'; path: string; query: RouteQuery };

export interface NavItem {
  path: string;
  label: string;
  description: string;
  routeNames: RouteName[];
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/cases', label: '测试用例', description: '新建、编辑与运行', routeNames: ['cases', 'case-new', 'case-edit'] },
  { path: '/datasets', label: '数据集', description: '数据驱动与逐行结果', routeNames: ['datasets'] },
  { path: '/suites', label: '套件', description: '用例集合与批量运行', routeNames: ['suites'] },
  { path: '/runs', label: '运行记录', description: '实时状态、结果与产物', routeNames: ['runs', 'run-detail'] },
  { path: '/regression', label: '回归对比', description: '基线与差异分析', routeNames: ['regression'] },
  { path: '/agents', label: 'Agent 交接', description: 'MCP / CLI / 官方 Agent', routeNames: ['agents'] },
  { path: '/health', label: '设置与健康', description: '连接状态与执行环境', routeNames: ['health'] },
];

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function toQuery(search: URLSearchParams): RouteQuery {
  const query: RouteQuery = {};
  for (const [key, value] of search.entries()) query[key] = value;
  return query;
}

/** 解析 location.hash（容错：无 #、缺前导 /、多余尾斜杠） */
export function parseRoute(hash: string): Route {
  let raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const questionIndex = raw.indexOf('?');
  let search = new URLSearchParams();
  if (questionIndex >= 0) {
    search = new URLSearchParams(raw.slice(questionIndex + 1));
    raw = raw.slice(0, questionIndex);
  }
  let path = raw.trim();
  if (path === '' || path === '/') return { name: 'cases', query: toQuery(search) };
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const query = toQuery(search);
  const segments = path.split('/').filter((segment) => segment !== '').map(decodeSegment);

  if (segments.length === 1 && segments[0] === 'cases') return { name: 'cases', query };
  if (segments.length === 2 && segments[0] === 'cases' && segments[1] === 'new') return { name: 'case-new', query };
  if (segments.length === 3 && segments[0] === 'cases' && segments[2] === 'edit') {
    const caseId = segments[1];
    if (caseId) return { name: 'case-edit', caseId, query };
  }
  if (segments.length === 1 && segments[0] === 'datasets') {
    const caseId = query['caseId'];
    const datasetId = query['datasetId'];
    return {
      name: 'datasets',
      ...(caseId ? { caseId } : {}),
      ...(datasetId ? { datasetId } : {}),
      query,
    };
  }
  if (segments.length === 1 && segments[0] === 'suites') {
    const suiteId = query['suiteId'];
    return { name: 'suites', ...(suiteId ? { suiteId } : {}), query };
  }
  if (segments.length === 1 && segments[0] === 'runs') {
    const status = query['status'];
    return { name: 'runs', ...(status ? { status } : {}), query };
  }
  if (segments.length === 2 && segments[0] === 'runs') {
    const runId = segments[1];
    if (runId) return { name: 'run-detail', runId, query };
  }
  if (segments.length === 1 && segments[0] === 'regression') {
    const comparisonId = query['comparisonId'];
    const baselineId = query['baselineId'];
    return {
      name: 'regression',
      ...(comparisonId ? { comparisonId } : {}),
      ...(baselineId ? { baselineId } : {}),
      query,
    };
  }
  if (segments.length === 1 && segments[0] === 'agents') return { name: 'agents', query };
  if (segments.length === 1 && segments[0] === 'health') return { name: 'health', query };
  return { name: 'not-found', path: `/${segments.join('/')}`, query };
}

/** 生成 hash href（值会做 URL 编码；undefined/null/空串被跳过） */
export function buildHref(path: string, query?: Record<string, string | number | boolean | null | undefined>): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (!query) return `#${normalized}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `#${normalized}?${qs}` : `#${normalized}`;
}

export function hrefForCase(caseId: string): string {
  return buildHref(`/cases/${encodeURIComponent(caseId)}/edit`);
}

export function hrefForRun(runId: string): string {
  return buildHref(`/runs/${encodeURIComponent(runId)}`);
}

export function hrefForDatasets(caseId?: string, datasetId?: string): string {
  return buildHref('/datasets', { caseId, datasetId });
}

export function hrefForSuites(suiteId?: string): string {
  return buildHref('/suites', { suiteId });
}

export function hrefForComparison(comparisonId: string): string {
  return buildHref('/regression', { comparisonId });
}

/** 导航高亮：同一路由族（如 case-edit 属于 /cases） */
export function navItemFor(route: Route): NavItem | null {
  return NAV_ITEMS.find((item) => item.routeNames.includes(route.name)) ?? null;
}

export function routeTitle(route: Route): string {
  switch (route.name) {
    case 'cases':
      return '测试用例';
    case 'case-new':
      return '新建用例';
    case 'case-edit':
      return '编辑用例';
    case 'datasets':
      return '数据集';
    case 'suites':
      return '套件';
    case 'runs':
      return '运行记录';
    case 'run-detail':
      return '运行详情';
    case 'regression':
      return '回归对比';
    case 'agents':
      return 'Agent 交接';
    case 'health':
      return '设置与健康';
    default:
      return '页面不存在';
  }
}