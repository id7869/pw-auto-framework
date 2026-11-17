/**
 * ANSI 转义序列剥离（只用于「展示层」）。
 *
 * 背景：Playwright 官方 JSON 报告中的 error.message / stdout / stderr 可能保留终端
 * 颜色、光标控制等 ANSI 序列。浏览器里直接渲染会显示为原始控制符（F3）。
 *
 * 纪律：
 * - 只提供纯函数，供展示组件统一调用，不改写后端数据；
 * - 原始 message 仍保留在接口/产物中（UI 的「复制原始…」按钮复制原文）；
 * - 至少支持 CSI（ESC [ ... final）与 OSC（ESC ] ... BEL/ST），并兼容 C1（U+009B/U+009D）
 *   以及常见的 ESC 字符集/单字符序列。
 */

/**
 * 需要按顺序应用的 ANSI 序列：
 * OSC → 8-bit OSC → CSI → 8-bit CSI → ESC 字符集/单字符 → 残余 C1 引入符。
 * 顺序很重要：先处理 `ESC ]` / `ESC [`，避免被单字符规则提前吞掉。
 */
const ANSI_SEQUENCES: readonly RegExp[] = [
  // OSC：ESC ] ... (BEL | ST | C1 ST)
  /\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)/gu,
  // 8-bit OSC（C1）：U+009D ... (BEL | ST | C1 ST)
  /\u009D[\s\S]*?(?:\u0007|\u001B\\|\u009C)/gu,
  // CSI：ESC [ 参数(0x30-0x3F)* 中间(0x20-0x2F)* 终止(0x40-0x7E)
  /\u001B\[[0-?]*[ -/]*[@-~]/gu,
  // 8-bit CSI（C1）
  /\u009B[0-?]*[ -/]*[@-~]/gu,
  // ESC + 中间字节(0x20-0x2F) + 终止字节(0x30-0x7E)：字符集选择等（如 ESC ( B、ESC ) 0）
  /\u001B[ -/][0-~]/gu,
  // ESC + Fe 单字符（0x40-0x5F）：如 ESC 7、ESC 8、ESC =、ESC >、ESC \
  /\u001B[@-_]/gu,
  // ESC + 其它单字符序列（如 DECSC 的 ESC 7/ESC 8、RIS 的 ESC c）；仅剥离 ESC 引导的序列
  /\u001B[0-~]/gu,
  // 残余的 8-bit 引入符（未闭合序列的兜底）
  /\u009B|\u009D/gu,
];

function normalizeInput(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';
  return String(input);
}

/**
 * 剥离 ANSI 控制序列，返回可安全展示的纯文本。
 * 空值统一返回空字符串；非转义文本（含中文、emoji、换行、制表符）原样保留。
 */
export function stripAnsi(input: string | null | undefined): string {
  let output = normalizeInput(input);
  for (const pattern of ANSI_SEQUENCES) {
    output = output.replace(pattern, '');
  }
  return output;
}

/** 输入是否包含 ANSI 转义序列（用于测试/诊断；不参与展示） */
export function hasAnsi(input: string | null | undefined): boolean {
  const value = normalizeInput(input);
  return value !== '' && stripAnsi(value) !== value;
}

/** 展示别名：语义上强调「这是给 UI 看的文本」 */
export const toDisplayText = stripAnsi;