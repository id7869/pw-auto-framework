/**
 * 数据导入：CSV 与 JSON 数组 → 数据集行草稿。
 * 说明：导入结果只是「草稿」，提交仍走后端 POST/PUT（合同 §3.2）；不做本地落库。
 */
import { isValidColumnName } from '../api/endpoints.ts';
import type { DatasetRowDraft } from './validation.ts';
import { MAX_CELL_LENGTH } from './validation.ts';

export interface ImportResult {
  columns: string[];
  rows: DatasetRowDraft[];
  errors: string[];
  warnings: string[];
}

interface CsvParseResult {
  header: string[];
  records: string[][];
  errors: string[];
}

/**
 * RFC 4180 风格 CSV 解析：支持双引号包裹、字段内逗号/换行、"" 转义、CRLF。
 * 空行会被忽略；表头重复/为空、列数不一致会给出中文错误。
 */
export function parseCsv(text: string): CsvParseResult {
  const source = text.replace(/^\uFEFF/u, '');
  const errors: string[] = [];
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    const hasContent = row.some((cell) => cell.trim() !== '');
    if (hasContent) rows.push(row);
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) continue;
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\n') {
      pushRow();
    } else if (char === '\r') {
      if (source[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      field += char;
    }
  }

  if (inQuotes) errors.push('CSV 存在未闭合的双引号，请检查');
  if (field !== '' || row.length > 0) pushRow();

  const headerRow = rows.shift();
  if (!headerRow) {
    return { header: [], records: [], errors: [...errors, 'CSV 内容为空'] };
  }
  const header = headerRow.map((name) => name.trim());
  if (header.length === 0 || header.every((name) => name === '')) {
    errors.push('CSV 第一行必须是表头（列名）');
  }
  const seen = new Set<string>();
  header.forEach((name, index) => {
    if (name === '') errors.push(`CSV 第 ${String(index + 1)} 列的列名为空`);
    else if (!isValidColumnName(name)) errors.push(`CSV 列名「${name}」不合法（1~60 字符，且不能包含 {{ 或 }}）`);
    else if (seen.has(name)) errors.push(`CSV 列名「${name}」重复`);
    seen.add(name);
  });

  const records: string[][] = [];
  rows.forEach((record, index) => {
    if (record.length !== header.length) {
      errors.push(
        `CSV 第 ${String(index + 2)} 行有 ${String(record.length)} 列，与表头的 ${String(header.length)} 列不一致`,
      );
    }
    const normalized = header.map((_, columnIndex) => record[columnIndex] ?? '');
    records.push(normalized);
  });

  return { header, records, errors };
}

function rowsFromTable(header: string[], records: string[][]): ImportResult {
  const errors: string[] = [];
  const columns = header.map((name) => name.trim());
  const rows: DatasetRowDraft[] = records.map((record, index) => {
    const values: Record<string, string> = {};
    columns.forEach((column, columnIndex) => {
      if (column === '') return;
      const value = record[columnIndex] ?? '';
      if (value.length > MAX_CELL_LENGTH) {
        errors.push(`第 ${String(index + 1)} 行的「${column}」超过 ${String(MAX_CELL_LENGTH)} 字符`);
      }
      values[column] = value;
    });
    return { enabled: true, values };
  });
  return { columns, rows, errors, warnings: columns.length === 0 ? ['没有解析到数据列'] : [] };
}

export function rowsFromCsv(text: string): ImportResult {
  const parsed = parseCsv(text);
  const result = rowsFromTable(parsed.header, parsed.records);
  const errors = [...parsed.errors, ...result.errors];
  if (parsed.records.length === 0) errors.push('CSV 至少需要一行数据');
  return { columns: result.columns, rows: result.rows, errors, warnings: result.warnings };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON 数组导入：`[{ "列名": 值, ... }, ...]`。
 * 值只能是字符串/数字/布尔/null；数字与布尔统一转为文本（官方断言/填写 API 只接受字符串，避免运行时类型问题）。
 */
export function rowsFromJson(text: string): ImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { columns: [], rows: [], errors: ['JSON 解析失败，请检查括号、引号与逗号'], warnings: [] };
  }
  if (!Array.isArray(parsed)) {
    return { columns: [], rows: [], errors: ['JSON 必须是对象数组，例如 [{"名字":"张三"}]'], warnings: [] };
  }
  if (parsed.length === 0) {
    return { columns: [], rows: [], errors: ['JSON 数组至少需要一行数据'], warnings: [] };
  }

  const columns: string[] = [];
  const rows: DatasetRowDraft[] = [];

  parsed.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`第 ${String(index + 1)} 行必须是对象（键值对）`);
      return;
    }
    const values: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(item)) {
      const key = rawKey.trim();
      if (!isValidColumnName(key)) {
        errors.push(`第 ${String(index + 1)} 行的列名「${rawKey}」不合法（1~60 字符，且不能包含 {{ 或 }}）`);
        continue;
      }
      let text: string;
      if (rawValue === null) text = '';
      else if (typeof rawValue === 'string') text = rawValue;
      else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') text = String(rawValue);
      else {
        errors.push(`第 ${String(index + 1)} 行的「${key}」必须是字符串、数字、布尔或 null`);
        continue;
      }
      if (text.length > MAX_CELL_LENGTH) {
        errors.push(`第 ${String(index + 1)} 行的「${key}」超过 ${String(MAX_CELL_LENGTH)} 字符`);
      }
      values[key] = text;
      if (!columns.includes(key)) columns.push(key);
    }
    rows.push({ enabled: true, values });
  });

  for (const row of rows) {
    for (const column of columns) {
      if (row.values[column] === undefined) {
        row.values[column] = '';
        warnings.push(`部分行缺少列「${column}」，已按空值补全`);
      }
    }
  }

  return { columns, rows, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/** 表格草稿 → 预览行（每一行按列顺序输出文本） */
export function draftRowsToMatrix(columns: readonly string[], rows: readonly DatasetRowDraft[]): string[][] {
  return rows.map((row) => columns.map((column) => row.values[column] ?? ''));
}

/** 生成一份可复制的 JSON 预览（不落库，仅展示） */
export function rowsToJsonPreview(columns: readonly string[], rows: readonly DatasetRowDraft[]): string {
  const data = rows.map((row) => {
    const item: Record<string, string> = {};
    for (const column of columns) item[column] = row.values[column] ?? '';
    return item;
  });
  return JSON.stringify(data, null, 2);
}