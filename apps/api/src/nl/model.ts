/**
 * NL 领域纯函数（无 IO）：sourceHash、行视图、5 态派生。
 * 口径来源：docs/NL_AGENT_SKILL_DESIGN.md §1.2 / §2.1、api-contract §12.1。
 */

import { createHash } from 'node:crypto';
import type { NlLine, NlSourceRecord, NlStatus, NlWarning, StepOrigin } from '@pw-auto/contracts';

export function nlSourceHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** 服务端只读行视图：空行/注释/指令行/步骤行/未映射行 */
export function buildNlLines(
  text: string,
  stepOrigin: StepOrigin | null,
  unmappedLines: ReadonlySet<number> = new Set<number>(),
): NlLine[] {
  const stepIdByLine = new Map<number, string>();
  if (stepOrigin) {
    for (const [stepId, origin] of Object.entries(stepOrigin)) {
      if (typeof origin?.nlLine === 'number') stepIdByLine.set(origin.nlLine, stepId);
    }
  }
  return text
    .split(/\r?\n/)
    .slice(0, 1000)
    .map((raw, index) => {
      const line = index + 1;
      const trimmed = raw.trim();
      if (trimmed === '') return { line, text: raw, kind: 'blank' as const, stepId: null };
      if (/^(#|\/\/)/.test(trimmed)) return { line, text: raw, kind: 'comment' as const, stepId: null };
      const mapped = stepIdByLine.get(line);
      if (mapped !== undefined) return { line, text: raw, kind: 'step' as const, stepId: mapped };
      if (unmappedLines.has(line)) return { line, text: raw, kind: 'unmapped' as const, stepId: null };
      if (/^(打开|访问|goto|navigate|open)\b/i.test(trimmed) || /https?:\/\//i.test(trimmed)) {
        return { line, text: raw, kind: 'instruction' as const, stepId: null };
      }
      return { line, text: raw, kind: 'step' as const, stepId: null };
    });
}

/**
 * 5 态派生（服务端唯一口径）：
 * 空文本→draft；有活跃任务→generating；最近 accepted 哈希==当前→generated；!=→stale；
 * 无 accepted 且最近一次任务 failed→invalid；否则 draft。
 */
export function deriveNlStatus(input: {
  text: string;
  currentHash: string;
  hasActive: boolean;
  acceptedHash: string | null;
  latestStatus: string | null;
}): NlStatus {
  if (input.text.trim() === '') return 'draft';
  if (input.hasActive) return 'generating';
  if (input.acceptedHash !== null) return input.acceptedHash === input.currentHash ? 'generated' : 'stale';
  if (input.latestStatus === 'failed') return 'invalid';
  return 'draft';
}

export function warningsOf(record: NlSourceRecord | null): NlWarning[] {
  return record?.warnings ?? [];
}
