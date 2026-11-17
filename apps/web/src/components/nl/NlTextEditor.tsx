/**
 * NL 业务句子编辑器：行号 + 多行文本 + 数据集列插入。
 * 刻意不包含任何动作下拉（goto/click/fill），普通用户只写业务句子。
 */
import { useEffect, useRef, useState } from 'react';
import { insertNlVariable, splitNlLines } from '../../lib/nl.ts';

export interface NlTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  columns?: string[];
  maxChars?: number;
}

export function NlTextEditor({ value, onChange, disabled, columns = [], maxChars = 200000 }: NlTextEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [pendingCursor, setPendingCursor] = useState<number | null>(null);
  const lines = splitNlLines(value);

  useEffect(() => {
    if (pendingCursor === null) return;
    const element = textareaRef.current;
    if (element) {
      element.focus();
      element.setSelectionRange(pendingCursor, pendingCursor);
    }
    setPendingCursor(null);
  }, [pendingCursor, value]);

  const insertColumn = (column: string): void => {
    const element = textareaRef.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? start;
    const result = insertNlVariable(value, start, end, column);
    onChange(result.text);
    setPendingCursor(result.cursor);
  };

  return (
    <div className="nl-editor-wrap">
      <label className="field-label" htmlFor="nl-source-text">
        业务句子（一行一句，可用 <code>#</code> 注释）
      </label>
      <div className={`nl-editor${disabled ? ' is-disabled' : ''}`}>
        <div className="nl-gutter" ref={gutterRef} aria-hidden="true">
          {lines.map((_, index) => (
            <span key={`nl-line-${String(index + 1)}`}>{index + 1}</span>
          ))}
        </div>
        <textarea
          id="nl-source-text"
          ref={textareaRef}
          className="nl-textarea"
          value={value}
          disabled={disabled}
          spellCheck={false}
          aria-describedby="nl-editor-help nl-editor-count"
          placeholder={'打开 https://demo.example.com/login\n在「用户名」输入 {{用户名}}\n点击「登录」\n页面上应该出现「欢迎，{{用户名}}」'}
          onScroll={(event) => {
            if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <div className="nl-editor-meta">
        <span id="nl-editor-count">
          {lines.length} 行 · {value.length}/{maxChars} 字符
        </span>
        <span id="nl-editor-help">支持 {'{{列名}}'} 变量；以 # 开头为注释；不需要选择 goto/click/fill 等动作。</span>
      </div>
      {columns.length > 0 ? (
        <div className="nl-columns" aria-label="插入数据集列">
          <span className="label">插入数据集列：</span>
          {columns.map((column) => (
            <button
              key={column}
              type="button"
              className="button button-small"
              disabled={disabled}
              onClick={() => insertColumn(column)}
            >
              {`{{${column}}}`}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}