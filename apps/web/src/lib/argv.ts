/**
 * CLI 参数分词：UI 只接受「一条命令 + 参数」输入，切分后作为 argv 数组提交，
 * 后端以 spawn(exe, argv, { shell:false }) 执行（架构 §8：禁止 shell 拼接）。
 * 支持单/双引号包裹与反斜杠转义；引号未闭合时报中文错误。
 */

export interface TokenizeResult {
  tokens: string[];
  error: string | null;
}

export function tokenizeArgv(input: string): TokenizeResult {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === undefined) continue;

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }

    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += '\\';
  if (quote !== null) {
    return { tokens, error: '引号未闭合，请检查命令参数' };
  }
  if (current !== '') tokens.push(current);
  return { tokens, error: null };
}

/** 把 argv 数组还原为可复制的命令行（仅用于展示；执行仍走数组） */
export function formatArgv(argv: readonly string[]): string {
  return argv
    .map((part) => (/[\s"']/u.test(part) ? `"${part.replace(/"/gu, '\\"')}"` : part))
    .join(' ');
}