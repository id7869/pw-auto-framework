import { describe, expect, it } from 'vitest';
import { draftRowsToMatrix, parseCsv, rowsFromCsv, rowsFromJson, rowsToJsonPreview } from './csv.ts';

describe('lib/csv：CSV 解析', () => {
  it('解析简单表头与行', () => {
    const result = parseCsv('名字,期望\n张三,你好，张三\n李四,你好，李四\n');
    expect(result.header).toEqual(['名字', '期望']);
    expect(result.records).toEqual([
      ['张三', '你好，张三'],
      ['李四', '你好，李四'],
    ]);
    expect(result.errors).toEqual([]);
  });

  it('支持引号包裹、字段内逗号与换行、双引号转义', () => {
    const result = parseCsv('名字,期望\r\n"王,五","他说""你好"""\r\n"张\n三","多行"');
    expect(result.records[0]).toEqual(['王,五', '他说"你好"']);
    expect(result.records[1]).toEqual(['张\n三', '多行']);
  });

  it('忽略空行与 BOM', () => {
    const result = parseCsv('\uFEFFa,b\n\n1,2\n   \n');
    expect(result.header).toEqual(['a', 'b']);
    expect(result.records).toEqual([['1', '2']]);
  });

  it('未闭合引号、空表头、重复列名、列数不一致给出中文错误', () => {
    expect(parseCsv('a,"unterminated').errors[0]).toContain('未闭合');
    expect(parseCsv(',b\n1,2').errors.some((message) => message.includes('列名为空'))).toBe(true);
    expect(parseCsv('a,a\n1,2').errors.some((message) => message.includes('重复'))).toBe(true);
    expect(parseCsv('a,b\n1,2,3').errors.some((message) => message.includes('不一致'))).toBe(true);
    expect(parseCsv('').errors[0]).toContain('为空');
  });
});

describe('lib/csv：JSON 导入', () => {
  it('对象数组 → 行草稿（数字/布尔/null 归一为文本）', () => {
    const result = rowsFromJson('[{"名字":"张三","年龄":42,"启用":true,"备注":null},{"名字":"李四"}]');
    expect(result.errors).toEqual([]);
    expect(result.columns).toEqual(['名字', '年龄', '启用', '备注']);
    expect(result.rows[0]?.values).toEqual({ 名字: '张三', 年龄: '42', 启用: 'true', 备注: '' });
    expect(result.rows[1]?.values).toEqual({ 名字: '李四', 年龄: '', 启用: '', 备注: '' });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('非法 JSON、非数组、空数组、嵌套值给出错误', () => {
    expect(rowsFromJson('{oops}').errors[0]).toContain('JSON 解析失败');
    expect(rowsFromJson('{"名字":"张三"}').errors[0]).toContain('对象数组');
    expect(rowsFromJson('[]').errors[0]).toContain('至少需要一行');
    const nested = rowsFromJson('[{"名字":{"a":1}}]');
    expect(nested.errors[0]).toContain('字符串、数字、布尔或 null');
  });

  it('JSON 列名非法与超长单元格', () => {
    const invalidColumn = rowsFromJson('[{"{{列}}":"x"}]');
    expect(invalidColumn.errors[0]).toContain('不合法');
    const long = rowsFromJson(`[{"名字":"${'x'.repeat(8193)}"}]`);
    expect(long.errors[0]).toContain('8192');
  });
});

describe('lib/csv：CSV 导入与会话接口', () => {
  it('CSV → 行草稿', () => {
    const result = rowsFromCsv('名字,期望\n张三,你好\n');
    expect(result.errors).toEqual([]);
    expect(result.columns).toEqual(['名字', '期望']);
    expect(result.rows).toEqual([{ enabled: true, values: { 名字: '张三', 期望: '你好' } }]);
  });

  it('CSV 至少需要一行数据', () => {
    expect(rowsFromCsv('a,b\n').errors.some((message) => message.includes('至少需要一行数据'))).toBe(true);
  });

  it('预览矩阵与 JSON 文本', () => {
    const rows = [{ enabled: true, values: { 名字: '张三', 期望: '你好' } }];
    expect(draftRowsToMatrix(['名字', '期望'], rows)).toEqual([['张三', '你好']]);
    const preview = rowsToJsonPreview(['名字', '期望'], rows);
    expect(JSON.parse(preview)).toEqual([{ 名字: '张三', 期望: '你好' }]);
  });
});