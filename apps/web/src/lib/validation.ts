/**
 * 前端表单校验（与 docs/api-contract.md 的边界一致；后端仍会二次校验）。
 * 只校验「用户可见输入」；不重算运行状态、不重写差异分类（架构 §6 禁止）。
 */
import type {
  BaselineCreator,
  BaselineScope,
  BrowserName,
  CaseInput,
  CaseMode,
  CaseStatus,
  DatasetCreateInput,
  DatasetSource,
  RunOptions,
  ScreenshotMode,
  Step,
  TraceMode,
  VideoMode,
} from '../api/types.ts';
import { isValidColumnName } from '../api/endpoints.ts';
import { normalizeSteps, validateSteps } from './steps.ts';

export interface FieldError {
  path: string;
  message: string;
}

export interface CaseFormValues {
  name: string;
  description: string;
  mode: CaseMode;
  steps: Step[];
  code: string;
  tagsText: string;
  status: CaseStatus;
}

export interface DatasetRowDraft {
  enabled: boolean;
  /** 单元格按文本编辑；提交时统一作为字符串值 */
  values: Record<string, string>;
}

export interface DatasetFormValues {
  name: string;
  source: DatasetSource;
  columns: string[];
  rows: DatasetRowDraft[];
}

export interface SuiteFormValues {
  name: string;
  description: string;
  caseIds: string[];
}

export interface BaselineFormValues {
  scope: BaselineScope;
  scopeId: string;
  runId: string;
  name: string;
  note: string;
  createdBy: BaselineCreator;
}

export interface ComparisonFormValues {
  baselineId: string;
  runId: string;
}

export const MAX_CASE_NAME = 200;
export const MAX_CASE_DESCRIPTION = 2000;
export const MAX_CASE_TAGS = 20;
export const MAX_TAG_LENGTH = 30;
export const MAX_CODE_LENGTH = 200000;
export const MAX_DATASET_ROWS = 500;
export const MAX_DATASET_COLUMNS = 50;
export const MAX_CELL_LENGTH = 8192;

export function parseTagsInput(text: string): string[] {
  const parts = text
    .split(/[,，、\n\r]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const unique: string[] = [];
  for (const part of parts) {
    if (!unique.includes(part)) unique.push(part);
  }
  return unique;
}

export function formatTagsInput(tags: readonly string[]): string {
  return tags.join(', ');
}

/** 用例表单校验，覆盖合同 §2.1/§2.2 的边界 */
export function validateCaseForm(values: CaseFormValues): FieldError[] {
  const errors: FieldError[] = [];
  const name = values.name.trim();
  if (name === '') {
    errors.push({ path: 'name', message: '请填写用例名称' });
  } else if (name.length > MAX_CASE_NAME) {
    errors.push({ path: 'name', message: `用例名称不能超过 ${String(MAX_CASE_NAME)} 个字符` });
  }

  if (values.description.length > MAX_CASE_DESCRIPTION) {
    errors.push({ path: 'description', message: `描述不能超过 ${String(MAX_CASE_DESCRIPTION)} 个字符` });
  }

  const tags = parseTagsInput(values.tagsText);
  if (tags.length > MAX_CASE_TAGS) {
    errors.push({ path: 'tags', message: `标签最多 ${String(MAX_CASE_TAGS)} 个` });
  } else {
    for (const tag of tags) {
      if (tag.length > MAX_TAG_LENGTH) {
        errors.push({ path: 'tags', message: `标签「${tag}」超过 ${String(MAX_TAG_LENGTH)} 个字符` });
      }
    }
  }

  if (values.mode === 'code') {
    if (values.code.trim() === '') {
      errors.push({ path: 'code', message: '原始代码模式下必须填写 Playwright Test 代码' });
    } else if (values.code.length > MAX_CODE_LENGTH) {
      errors.push({ path: 'code', message: `代码不能超过 ${String(MAX_CODE_LENGTH)} 个字符` });
    }
  } else {
    errors.push(...validateSteps(values.steps));
  }

  return errors;
}

export function toCaseInput(values: CaseFormValues): CaseInput {
  const mode = values.mode;
  const input: CaseInput = {
    name: values.name.trim(),
    description: values.description.trim(),
    mode,
    tags: parseTagsInput(values.tagsText),
  };
  if (mode === 'steps') {
    input.steps = normalizeSteps(values.steps);
    input.code = null;
  } else {
    input.code = values.code;
    input.steps = [];
  }
  return input;
}

/** PATCH 才允许携带 status（api-contract §2.4 的创建请求不含 status） */
export function toCasePatchInput(values: CaseFormValues): CaseInput {
  return { ...toCaseInput(values), status: values.status };
}

/** 数据集表单校验：列名合法、行数/单元格上限、行与列一致 */
export function validateDatasetForm(values: DatasetFormValues): FieldError[] {
  const errors: FieldError[] = [];
  if (values.name.trim() === '') {
    errors.push({ path: 'name', message: '请填写数据集名称' });
  } else if (values.name.trim().length > MAX_CASE_NAME) {
    errors.push({ path: 'name', message: `数据集名称不能超过 ${String(MAX_CASE_NAME)} 个字符` });
  }

  const columns = values.columns.map((column) => column.trim());
  if (columns.length === 0) {
    errors.push({ path: 'columns', message: '请至少添加一个数据列' });
  }
  if (columns.length > MAX_DATASET_COLUMNS) {
    errors.push({ path: 'columns', message: `数据列不能超过 ${String(MAX_DATASET_COLUMNS)} 个` });
  }
  const seen = new Set<string>();
  columns.forEach((column, index) => {
    if (column === '') {
      errors.push({ path: `columns[${String(index)}]`, message: `第 ${String(index + 1)} 列的列名不能为空` });
      return;
    }
    if (!isValidColumnName(column)) {
      errors.push({
        path: `columns[${String(index)}]`,
        message: `列名「${column}」不合法（1~60 字符，且不能包含 {{ 或 }}）`,
      });
    }
    if (seen.has(column)) {
      errors.push({ path: `columns[${String(index)}]`, message: `列名「${column}」重复` });
    }
    seen.add(column);
  });

  if (values.rows.length === 0) {
    errors.push({ path: 'rows', message: '请至少添加一行数据（无行的数据集无法执行）' });
  } else if (values.rows.length > MAX_DATASET_ROWS) {
    errors.push({ path: 'rows', message: `数据行不能超过 ${String(MAX_DATASET_ROWS)} 行` });
  }

  values.rows.forEach((row, rowIndex) => {
    columns.forEach((column) => {
      if (column === '') return;
      const value = row.values[column];
      const text = value ?? '';
      if (text.length > MAX_CELL_LENGTH) {
        errors.push({
          path: `rows[${String(rowIndex)}].${column}`,
          message: `第 ${String(rowIndex + 1)} 行的「${column}」超过 ${String(MAX_CELL_LENGTH)} 字符`,
        });
      }
    });
    if (Object.keys(row.values).length !== columns.length) {
      errors.push({
        path: `rows[${String(rowIndex)}]`,
        message: `第 ${String(rowIndex + 1)} 行的单元格数量与列数不一致`,
      });
    }
  });

  return errors;
}

export function toDatasetInput(values: DatasetFormValues, source: DatasetSource): DatasetCreateInput {
  const columns = values.columns.map((column) => column.trim());
  return {
    name: values.name.trim(),
    source,
    rows: values.rows.map((row) => {
      const data: Record<string, string> = {};
      for (const column of columns) {
        if (column === '') continue;
        data[column] = row.values[column] ?? '';
      }
      return { data, enabled: row.enabled };
    }),
  };
}

export function validateSuiteForm(values: SuiteFormValues): FieldError[] {
  const errors: FieldError[] = [];
  if (values.name.trim() === '') {
    errors.push({ path: 'name', message: '请填写套件名称' });
  } else if (values.name.trim().length > MAX_CASE_NAME) {
    errors.push({ path: 'name', message: `套件名称不能超过 ${String(MAX_CASE_NAME)} 个字符` });
  }
  if (values.description.length > MAX_CASE_DESCRIPTION) {
    errors.push({ path: 'description', message: `描述不能超过 ${String(MAX_CASE_DESCRIPTION)} 个字符` });
  }
  if (values.caseIds.length === 0) {
    errors.push({ path: 'caseIds', message: '请至少选择一个测试用例' });
  } else if (values.caseIds.length > 100) {
    errors.push({ path: 'caseIds', message: '套件最多包含 100 个用例' });
  }
  const seen = new Set<string>();
  for (const caseId of values.caseIds) {
    if (seen.has(caseId)) {
      errors.push({ path: 'caseIds', message: '同一个用例不能在套件中重复出现' });
      break;
    }
    seen.add(caseId);
  }
  return errors;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  retries: 0,
  workers: 1,
  timeoutMs: 60000,
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',
  video: 'off',
  headed: false,
  browser: 'chromium',
  failOnFlaky: false,
  allowStaleNl: false,
};

export const TRACE_OPTIONS: { value: TraceMode; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'retain-on-failure', label: '失败时保留（推荐）' },
  { value: 'on', label: '总是保留' },
];

export const SCREENSHOT_OPTIONS: { value: ScreenshotMode; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'only-on-failure', label: '仅失败时截图（推荐）' },
  { value: 'on', label: '总是截图' },
];

export const VIDEO_OPTIONS: { value: VideoMode; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'retain-on-failure', label: '失败时保留' },
  { value: 'on', label: '总是录制' },
];

export const BROWSER_OPTIONS: { value: BrowserName; label: string }[] = [
  { value: 'chromium', label: 'Chromium（官方自带，推荐）' },
  { value: 'chrome', label: 'Chrome（系统通道）' },
  { value: 'msedge', label: 'Edge（系统通道）' },
  { value: 'firefox', label: 'Firefox（需安装）' },
  { value: 'webkit', label: 'WebKit（需安装）' },
];

/** 运行选项校验（边界见 api-contract §5.3 / 附录 A.4） */
export function validateRunOptions(options: RunOptions, reason = ''): FieldError[] {
  const errors: FieldError[] = [];
  if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 5) {
    errors.push({ path: 'options.retries', message: '重试次数需为 0~5 的整数' });
  }
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 4) {
    errors.push({ path: 'options.workers', message: '并行数需为 1~4 的整数' });
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 3600000) {
    errors.push({ path: 'options.timeoutMs', message: '超时需为 1000~3600000 毫秒' });
  }
  if (!TRACE_OPTIONS.some((item) => item.value === options.trace)) {
    errors.push({ path: 'options.trace', message: 'trace 取值不合法' });
  }
  if (!SCREENSHOT_OPTIONS.some((item) => item.value === options.screenshot)) {
    errors.push({ path: 'options.screenshot', message: '截图取值不合法' });
  }
  if (!VIDEO_OPTIONS.some((item) => item.value === options.video)) {
    errors.push({ path: 'options.video', message: '录屏取值不合法' });
  }
  if (!BROWSER_OPTIONS.some((item) => item.value === options.browser)) {
    errors.push({ path: 'options.browser', message: '浏览器取值不合法' });
  }
  if (reason.length > 200) {
    errors.push({ path: 'reason', message: '运行备注不能超过 200 个字符' });
  }
  return errors;
}

export function validateBaselineForm(values: BaselineFormValues): FieldError[] {
  const errors: FieldError[] = [];
  if (values.scope !== 'case' && values.scope !== 'suite') {
    errors.push({ path: 'scope', message: '请选择基线归属（用例/套件）' });
  }
  if (values.scopeId.trim() === '') {
    errors.push({ path: 'scopeId', message: '请填写归属对象 ID（caseId 或 suiteId）' });
  }
  if (values.runId.trim() === '') {
    errors.push({ path: 'runId', message: '请填写作为基线的运行 ID' });
  }
  if (values.name.trim() === '') {
    errors.push({ path: 'name', message: '请填写基线名称' });
  } else if (values.name.trim().length > 200) {
    errors.push({ path: 'name', message: '基线名称不能超过 200 个字符' });
  }
  if (values.note.length > 2000) {
    errors.push({ path: 'note', message: '备注不能超过 2000 个字符' });
  }
  return errors;
}

export function validateComparisonForm(values: ComparisonFormValues): FieldError[] {
  const errors: FieldError[] = [];
  if (values.baselineId.trim() === '') errors.push({ path: 'baselineId', message: '请选择回归基线' });
  if (values.runId.trim() === '') errors.push({ path: 'runId', message: '请填写目标运行 ID' });
  return errors;
}

/** 从字段错误列表中取某个前缀的全部消息（用于表单就地提示） */
export function errorsFor(errors: readonly FieldError[], path: string): FieldError[] {
  return errors.filter((error) => error.path === path || error.path.startsWith(`${path}.`) || error.path.startsWith(`${path}[`));
}

export function firstError(errors: readonly FieldError[]): FieldError | null {
  return errors[0] ?? null;
}

/** 后端错误 details[] → 表单字段错误（api-contract §0.2） */
export function toFieldErrors(details: { path: string; message: string }[] | undefined): FieldError[] {
  if (!details) return [];
  return details.map((detail) => ({ path: detail.path, message: detail.message }));
}