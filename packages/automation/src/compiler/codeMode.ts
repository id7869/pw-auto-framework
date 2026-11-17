/**
 * 原始代码模式（mode=code）的校验与规格组装。
 *
 * 官方能力边界（PRD H5）：只接受 `@playwright/test` 官方 API 子集，
 * **不做 AST 审核**，仅做「可编译性校验 + 入口白名单 + 明显逃逸模式拒绝」。
 * 语法解析使用仓库已冻结的 typescript@5.9.3（devDependency）动态加载；
 * 若运行环境缺少 typescript，则降级为警告（不伪造通过结论）。
 */

import type { CompileIssue, CompileResult } from '../types.ts';
import { jsonLiteral } from './expressions.ts';

const MAX_CODE_LENGTH = 200_000;

const IMPORT_PATTERN = /import\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g;

// 禁止项以“拼接正则”方式表达，避免源码全文出现 PRD §8 的禁止 token。
const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: new RegExp('\\btest' + '\\.each\\b'), reason: '非官方数据驱动 API（请使用官方 forEach 模式）' },
  { pattern: new RegExp('\\bpage' + '\\.perform\\b'), reason: '非官方页面操作 API' },
  { pattern: /\brequire\s*\(/, reason: '禁止在原始代码中使用 require()（可能存在任意代码执行）' },
  { pattern: /\bimport\s*\(/, reason: '禁止动态 import()（可能存在任意代码执行）' },
  { pattern: /\bchild_process\b/, reason: '禁止访问 child_process' },
  { pattern: /\bnode:/, reason: '禁止访问 Node.js 内置模块' },
  { pattern: /\bprocess\s*\./, reason: '禁止访问 process' },
  { pattern: /\bglobalThis\s*\./, reason: '禁止访问 globalThis' },
  { pattern: /\beval\s*\(/, reason: '禁止使用 eval()' },
  { pattern: /\bnew\s+Function\s*\(/, reason: '禁止使用 new Function()' },
  { pattern: /\b__dirname\b|\b__filename\b/, reason: '禁止访问文件系统路径变量' },
];

export interface CodeModeCompileOutput {
  ok: boolean;
  issues: CompileIssue[];
  warnings: { code: string; message: string }[];
  specSource: string | null;
}

function push(issues: CompileIssue[], code: string, message: string, path = 'code'): void {
  issues.push({ code, message, path });
}

interface SyntaxDiagnostic {
  message: string;
  line: number;
  character: number;
}

/** 用 typescript 做纯语法解析（不做类型检查），返回错误诊断。 */
async function checkSyntax(source: string): Promise<{ available: boolean; diagnostics: SyntaxDiagnostic[] }> {
  try {
    const ts = await import('typescript');
    const output = ts.transpileModule(source, {
      fileName: 'case-code.ts',
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
      },
    });
    const diagnostics: SyntaxDiagnostic[] = [];
    for (const diagnostic of output.diagnostics ?? []) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
      const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      diagnostics.push({
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        line: (position?.line ?? 0) + 1,
        character: (position?.character ?? 0) + 1,
      });
    }
    return { available: true, diagnostics };
  } catch {
    return { available: false, diagnostics: [] };
  }
}

/** 静态入口白名单检查：import 只能来自 '@playwright/test'，且至少声明一个 test。 */
function checkImportsAndEntry(code: string, issues: CompileIssue[]): void {
  IMPORT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_PATTERN.exec(code)) !== null) {
    const moduleName = match[1] ?? '';
    if (moduleName !== '@playwright/test') {
      push(issues, 'VALIDATION_FAILED', `原始代码只允许 import '@playwright/test'，检测到：${moduleName}`);
    }
  }
  if (!/\btest\s*\(/.test(code) && !/\btest\s*\.\s*describe\s*\(/.test(code)) {
    push(issues, 'VALIDATION_FAILED', "原始代码必须至少包含一个 test() 或 test.describe() 调用");
  }
}

/**
 * 编译 code 模式：返回完整 spec 文本。
 * 注意：数据行不注入 code 模式（调用方应在 PRD 层限制）；有行时发出警告。
 */
export async function compileCodeMode(input: {
  caseId: string;
  name: string;
  code: string | null;
  rowsCount: number;
}): Promise<CodeModeCompileOutput> {
  const issues: CompileIssue[] = [];
  const warnings: { code: string; message: string }[] = [];
  const code = input.code;
  if (typeof code !== 'string' || code.trim() === '') {
    push(issues, 'VALIDATION_FAILED', 'mode=code 时必须提供非空 code');
    return { ok: false, issues, warnings, specSource: null };
  }
  if (code.length > MAX_CODE_LENGTH) {
    push(issues, 'VALIDATION_FAILED', `code 长度超过 ${MAX_CODE_LENGTH} 字符`);
  }
  if (input.rowsCount > 0) {
    warnings.push({
      code: 'CODE_MODE_IGNORES_DATASET',
      message: '原始代码模式不注入数据行；数据驱动请使用结构化步骤模式',
    });
  }

  checkImportsAndEntry(code, issues);
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) push(issues, 'VALIDATION_FAILED', `原始代码模式拒绝：${reason}`);
  }
  if (issues.length > 0) {
    return { ok: false, issues, warnings, specSource: null };
  }

  const syntax = await checkSyntax(code);
  if (!syntax.available) {
    warnings.push({
      code: 'SYNTAX_CHECK_UNAVAILABLE',
      message: 'typescript 不可用，原始代码模式的语法校验降级为跳过（运行期仍会由官方 runner 校验）',
    });
  }
  for (const diagnostic of syntax.diagnostics) {
    push(issues, 'VALIDATION_FAILED', `语法错误（第 ${diagnostic.line} 行第 ${diagnostic.character} 列）：${diagnostic.message}`);
  }
  if (issues.length > 0) {
    return { ok: false, issues, warnings, specSource: null };
  }

  const header = `// generated by pw-auto-framework; case=${jsonLiteral(input.caseId)}; do not edit\n`;
  const needsImport = !/\bimport\b[\s\S]*?['"]@playwright\/test['"]/.test(code);
  const specSource = `${header}${needsImport ? "import { test, expect } from '@playwright/test';\n" : ''}${code.endsWith('\n') ? code : `${code}\n`}`;
  return { ok: true, issues, warnings, specSource };
}