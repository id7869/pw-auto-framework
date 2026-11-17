import { describe, expect, it } from 'vitest';
import { hasAnsi, stripAnsi, toDisplayText } from './ansi.ts';

describe('lib/ansi：展示层 ANSI 剥离', () => {
  it('CSI 颜色/样式：16 色、组合参数、256 色、光标控制', () => {
    expect(stripAnsi('\u001b[31m失败\u001b[0m')).toBe('失败');
    expect(stripAnsi('\u001b[1;32m通过\u001b[0m：\u001b[38;5;196m断言\u001b[0m')).toBe('通过：断言');
    expect(stripAnsi('\u001b[2K\u001b[1G进度 100%')).toBe('进度 100%');
    expect(stripAnsi('\u001b[?25l隐藏光标\u001b[?25h')).toBe('隐藏光标');
  });

  it('OSC：BEL、ST、C1 ST 三种终止符与超链接', () => {
    expect(stripAnsi('\u001b]8;;https://example.com\u0007链接\u001b]8;;\u0007')).toBe('链接');
    expect(stripAnsi('\u001b]0;窗口标题\u001b\\正文')).toBe('正文');
    expect(stripAnsi('\u001b]8;;https://example.com\u009c带标签\u001b]8;;\u009c')).toBe('带标签');
  });

  it('多段/嵌套转义：断言错误 message 剥离后保留可读文本', () => {
    const message =
      '\u001b[1m\u001b[31mexpect(locator).toHaveText\u001b[0m\n' +
      '\u001b[2mExpected:\u001b[0m \u001b[32m"你好，张三"\u001b[0m\n' +
      '\u001b[2mReceived:\u001b[0m \u001b[33m"错误文本"\u001b[0m';
    const stripped = stripAnsi(message);
    expect(stripped).toContain('expect(locator).toHaveText');
    expect(stripped).toContain('Expected: "你好，张三"');
    expect(stripped).toContain('Received: "错误文本"');
    expect(stripped.includes('\u001b')).toBe(false);
    expect(stripped.includes('\u0007')).toBe(false);
    expect(stripped.split('\n')).toHaveLength(3);
  });

  it('无转义文本原样保留（中文、emoji、换行、字面 [31m]）', () => {
    const plain = '断言失败：数组[31m] 不是 ANSI 序列\n步骤 2/3 ✅';
    expect(stripAnsi(plain)).toBe(plain);
  });

  it('空值：空串 / null / undefined / 仅转义序列', () => {
    expect(stripAnsi('')).toBe('');
    expect(stripAnsi(null)).toBe('');
    expect(stripAnsi(undefined)).toBe('');
    expect(stripAnsi('\u001b[31m\u001b[0m\u001b]0;title\u0007')).toBe('');
  });

  it('8-bit C1 CSI / OSC 与常见 ESC 单字符序列', () => {
    expect(stripAnsi('\u009b31mC1 文本\u009b0m')).toBe('C1 文本');
    expect(stripAnsi('\u009d0;标题\u0007C1 OSC')).toBe('C1 OSC');
    expect(stripAnsi('\u001b(0\u001b7文本\u001b8\u001b>')).toBe('文本');
  });

  it('换行与制表符保留（不误删可读空白）', () => {
    expect(stripAnsi('a\n\tb')).toBe('a\n\tb');
  });

  it('hasAnsi 精确判定，toDisplayText 为 stripAnsi 的展示别名', () => {
    expect(hasAnsi('\u001b[31m红\u001b[0m')).toBe(true);
    expect(hasAnsi('普通错误')).toBe(false);
    expect(hasAnsi('')).toBe(false);
    expect(hasAnsi(null)).toBe(false);
    expect(toDisplayText('\u001b[32mOK\u001b[0m')).toBe('OK');
  });
});