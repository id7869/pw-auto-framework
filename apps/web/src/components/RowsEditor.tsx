/**
 * 数据集行编辑器：列管理 + 逐行单元格编辑 + 启用/删除 + 追加行。
 * 提交时由页面转换为 api-contract §3 的 rows 形态（PUT 全量替换）。
 */
import { useState } from 'react';
import type { DatasetRowDraft } from '../lib/validation.ts';
import { Field } from './ui.tsx';

export interface RowsEditorProps {
  columns: string[];
  rows: DatasetRowDraft[];
  onChange: (columns: string[], rows: DatasetRowDraft[]) => void;
  disabled?: boolean;
}

export function RowsEditor({ columns, rows, onChange, disabled }: RowsEditorProps) {
  const renameColumn = (index: number, nextName: string): void => {
    const oldName = columns[index] ?? '';
    const nextColumns = columns.map((column, current) => (current === index ? nextName : column));
    const nextRows = rows.map((row) => {
      const values: Record<string, string> = {};
      for (const column of nextColumns) {
        values[column] = row.values[column === nextName ? oldName : column] ?? '';
      }
      return { ...row, values };
    });
    onChange(nextColumns, nextRows);
  };

  const removeColumn = (index: number): void => {
    const removed = columns[index];
    if (removed === undefined) return;
    const nextColumns = columns.filter((_, current) => current !== index);
    const nextRows = rows.map((row) => {
      const values: Record<string, string> = {};
      for (const column of nextColumns) values[column] = row.values[column] ?? '';
      return { ...row, values };
    });
    onChange(nextColumns, nextRows);
  };

  const addColumn = (name: string): void => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    const nextColumns = [...columns, trimmed];
    const nextRows = rows.map((row) => ({ ...row, values: { ...row.values, [trimmed]: row.values[trimmed] ?? '' } }));
    onChange(nextColumns, nextRows);
  };

  const updateCell = (rowIndex: number, column: string, value: string): void => {
    const nextRows = rows.map((row, current) =>
      current === rowIndex ? { ...row, values: { ...row.values, [column]: value } } : row,
    );
    onChange(columns, nextRows);
  };

  const toggleRow = (rowIndex: number, enabled: boolean): void => {
    const nextRows = rows.map((row, current) => (current === rowIndex ? { ...row, enabled } : row));
    onChange(columns, nextRows);
  };

  const removeRow = (rowIndex: number): void => {
    onChange(
      columns,
      rows.filter((_, current) => current !== rowIndex),
    );
  };

  const addRow = (): void => {
    const values: Record<string, string> = {};
    for (const column of columns) values[column] = '';
    onChange(columns, [...rows, { enabled: true, values }]);
  };

  return (
    <div className="rows-editor">
      <div className="columns-editor">
        <p className="label">数据列（由数据推导，列名会作为 {'{{列名}}'} 变量名）</p>
        <div className="column-list">
          {columns.map((column, index) => (
            <div className="column-item" key={`${column}:${String(index)}`}>
              <input
                className="input mono"
                value={column}
                aria-label={`第 ${String(index + 1)} 列的列名`}
                disabled={disabled}
                onChange={(event) => renameColumn(index, event.target.value)}
              />
              <button
                type="button"
                className="button button-small button-danger"
                disabled={disabled}
                onClick={() => removeColumn(index)}
                aria-label={`删除列 ${column === '' ? String(index + 1) : column}`}
              >
                删除列
              </button>
            </div>
          ))}
          {columns.length === 0 ? <p className="muted">还没有列。请添加列或在下方导入 JSON/CSV。</p> : null}
        </div>
        <ColumnAdder onAdd={addColumn} disabled={disabled} />
      </div>

      <div className="rows-table-wrap">
        <table className="table rows-table">
          <caption className="sr-only">数据行编辑表</caption>
          <thead>
            <tr>
              <th scope="col">行号</th>
              {columns.map((column, index) => (
                <th scope="col" key={`${column}:${String(index)}`}>
                  {column === '' ? `列 ${String(index + 1)}` : column}
                </th>
              ))}
              <th scope="col">启用</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`row-${String(rowIndex)}`}>
                <th scope="row">{rowIndex + 1}</th>
                {columns.map((column, columnIndex) => (
                  <td key={`${column}:${String(columnIndex)}`}>
                    <input
                      className="input cell-input"
                      value={row.values[column] ?? ''}
                      aria-label={`第 ${String(rowIndex + 1)} 行「${column}」`}
                      disabled={disabled}
                      onChange={(event) => updateCell(rowIndex, column, event.target.value)}
                    />
                  </td>
                ))}
                <td>
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    aria-label={`第 ${String(rowIndex + 1)} 行启用`}
                    disabled={disabled}
                    onChange={(event) => toggleRow(rowIndex, event.target.checked)}
                  />
                </td>
                <td>
                  <button type="button" className="button button-small button-danger" disabled={disabled} onClick={() => removeRow(rowIndex)}>
                    删除行
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 3}>
                  <span className="muted">还没有数据行。</span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="rows-actions">
        <button type="button" className="button" onClick={addRow} disabled={disabled || columns.length === 0}>
          添加一行
        </button>
        <span className="muted">共 {rows.length} 行，启用 {rows.filter((row) => row.enabled).length} 行</span>
      </div>
    </div>
  );
}

function ColumnAdder({ onAdd, disabled }: { onAdd: (name: string) => void; disabled?: boolean }) {
  const [name, setName] = useState('');
  return (
    <Field id="dataset-new-column" label="添加列" hint="列名 1~60 字符，不能包含 {{ 或 }}">
      <div className="add-column-row">
        <input
          id="dataset-new-column"
          className="input mono"
          value={name}
          placeholder="例如 名字"
          disabled={disabled}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="button"
          className="button"
          disabled={disabled || name.trim() === ''}
          onClick={() => {
            onAdd(name);
            setName('');
          }}
        >
          添加列
        </button>
      </div>
    </Field>
  );
}

export function EnabledSummary({ rows }: { rows: readonly DatasetRowDraft[] }) {
  const enabled = rows.filter((row) => row.enabled).length;
  if (enabled === rows.length) return <span className="muted">全部行启用</span>;
  return (
    <span className="field-warning">
      有 {rows.length - enabled} 行未启用；若全部禁用，运行会被后端拒绝（422 EMPTY_DATASET）。
    </span>
  );
}