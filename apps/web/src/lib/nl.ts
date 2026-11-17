/**
 * NL-first 纯逻辑工具：行号、变量插入、生成状态与步骤来源映射。
 * 不依赖 DOM/React，便于 vitest 直接单测。
 */
import type {
  Case,
  NlGeneration,
  NlGenerationStatus,
  NlLine,
  NlSource,
  Step,
  StepOrigin,
} from '../api/types.ts';
import { STEP_ACTIONS } from '../api/types.ts';

/** 文本 → 行数组（保留空行；用于行号栏） */
export function splitNlLines(text: string): string[] {
  return text.split(/\r?\n/u);
}

/** 插入 `{{列名}}`：替换选区，返回新文本与光标位置 */
export function insertNlVariable(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  column: string,
): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  const token = `{{${column}}}`;
  return { text: `${text.slice(0, start)}${token}${text.slice(end)}`, cursor: start + token.length };
}

export function nlVariableToken(column: string): string {
  return `{{${column}}}`;
}

/** 某 NL 行号对应的原文（找不到返回空串） */
export function nlLineText(source: NlSource | null | undefined, line: number): string {
  return source?.lines.find((item) => item.line === line)?.text ?? '';
}

export function nlLineByNumber(source: NlSource | null | undefined, line: number): NlLine | undefined {
  return source?.lines.find((item) => item.line === line);
}

/** stepOrigin → 唯一、升序的 NL 行号 */
export function nlLinesFromStepOrigin(origin: StepOrigin | null | undefined): number[] {
  if (!origin) return [];
  const lines = new Set<number>();
  for (const value of Object.values(origin)) {
    if (Number.isInteger(value.nlLine) && value.nlLine >= 1) lines.add(value.nlLine);
  }
  return [...lines].sort((left, right) => left - right);
}

export function formatNlLines(lines: readonly number[]): string {
  if (lines.length === 0) return '—';
  return `第 ${lines.join('、')} 行`;
}

const STEP_ACTIONS_SET = new Set<string>(STEP_ACTIONS);

/**
 * 安全解析生成结果中的 steps：只保留 id/action 合法的对象，避免 UI 崩溃或伪造。
 * 其余字段由后端在 submit 时按 Step schema 校验，这里只做展示层防御。
 */
export function parseGeneratedSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return [];
  const steps: Step[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = record['id'];
    const action = record['action'];
    if (typeof id !== 'string' || typeof action !== 'string' || !STEP_ACTIONS_SET.has(action)) continue;
    steps.push(record as unknown as Step);
  }
  return steps;
}

export function isGenerationActive(status: NlGenerationStatus): boolean {
  return status === 'queued' || status === 'running';
}

export function isGenerationTerminal(status: NlGenerationStatus): boolean {
  return status === 'accepted' || status === 'rejected' || status === 'failed' || status === 'cancelled';
}

/** 生成结果是否与当前 NL 文本不一致（stale） */
export function isGenerationStale(generation: NlGeneration | null, source: NlSource | null | undefined): boolean {
  if (!generation) return false;
  if (source === null || source === undefined) return true;
  return generation.sourceHash !== source.sourceHash;
}

/** 当前 NL 是否可运行（门禁与 §12.4 对齐；stale 需 allowStaleNl） */
export function nlRunBlockReason(source: NlSource | null | undefined): string | null {
  if (!source) return '该用例没有 NL 源';
  if (source.status === 'draft') return 'NL 尚未生成，请先生成并接受步骤';
  if (source.status === 'generating') return 'NL 正在生成，请等待外部 agent 完成并接受';
  if (source.status === 'invalid') return 'NL 生成结果无效，请重新生成';
  if (source.status === 'stale') return 'NL 文本已修改，需重新生成并接受（或在运行选项勾选 allowStaleNl）';
  return null;
}

/** 步骤 → NL 行（无映射返回 null） */
export function nlLineForStep(stepId: string, origin: StepOrigin | null | undefined): number | null {
  const line = origin?.[stepId]?.nlLine;
  return typeof line === 'number' && line >= 1 ? line : null;
}

/** 生成结果中每个步骤的来源行（缺失为该步无映射） */
export function generatedStepSources(
  generation: NlGeneration,
): { step: Step; line: number | null; text: string | null }[] {
  const origin = generation.stepOrigin ?? null;
  const lines = splitNlLines(generation.nlText);
  return parseGeneratedSteps(generation.steps).map((step) => {
    const line = nlLineForStep(step.id, origin);
    return {
      step,
      line,
      text: line === null ? null : (lines[line - 1] ?? null),
    };
  });
}

/** 用例步骤 + NL 来源行（只读视图） */
export function caseStepSources(
  caseItem: Case | null | undefined,
): { step: Step; line: number | null; text: string | null }[] {
  if (!caseItem) return [];
  const steps = caseItem.steps ?? [];
  const source = caseItem.nl ?? null;
  return steps.map((step) => {
    const line = nlLineForStep(step.id, caseItem.stepOrigin ?? null);
    return { step, line, text: line === null ? null : nlLineText(source, line) };
  });
}