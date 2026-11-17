/**
 * 官方 Playwright JSON 报告的读取工具（schema 见 docs/research/01-playwright-core-test.md §3.6）。
 *
 * 报告形态：{ suites: [ { title, file, specs?: [...], suites?: [...] } ] }（describe 会嵌套 suites）。
 * 验收断言必须递归遍历，不能假设只有一层。
 */

export interface JsonReportResult {
  status: string;
  duration: number;
  error?: { message?: string };
  errors?: { message?: string }[];
  steps?: { title: string; duration: number; error?: { message?: string } }[];
  attachments?: { name: string; contentType: string; path?: string }[];
}

export interface JsonReportTest {
  title: string;
  status: string;
  projectName?: string;
  results: JsonReportResult[];
}

export interface JsonReportSpec {
  title: string;
  file?: string;
  line?: number;
  tests: JsonReportTest[];
}

interface RawSuite {
  title?: string;
  file?: string;
  line?: number;
  specs?: JsonReportSpec[];
  suites?: RawSuite[];
}

export interface JsonReport {
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number };
  suites?: RawSuite[];
  errors?: unknown[];
}

/** 递归收集所有 spec（含嵌套 describe） */
export function collectSpecs(report: JsonReport): JsonReportSpec[] {
  const acc: JsonReportSpec[] = [];
  const walk = (suite: RawSuite): void => {
    for (const spec of suite.specs ?? []) acc.push(spec);
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return acc;
}

/** 递归收集所有 test */
export function collectTests(report: JsonReport): JsonReportTest[] {
  return collectSpecs(report).flatMap((spec) => spec.tests ?? []);
}

/** 单个 test 的步骤标题（用于核对 test.step 是否真实产生） */
export function stepTitles(test: JsonReportTest): string[] {
  const first = test.results[0];
  return (first?.steps ?? []).map((step) => step.title);
}