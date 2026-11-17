/**
 * NL 纯函数单测（无 IO）：sourceHash、行视图、5 态派生（含 invalid 分支）。
 */

import { describe, expect, it } from 'vitest';
import { buildNlLines, deriveNlStatus, nlSourceHash } from '../nl/model.ts';

describe('nl/model', () => {
  it('sourceHash = sha256(text) 前 16 位，稳定且随文本变化', () => {
    expect(nlSourceHash('abc')).toMatch(/^[a-f0-9]{16}$/);
    expect(nlSourceHash('abc')).toBe(nlSourceHash('abc'));
    expect(nlSourceHash('abc')).not.toBe(nlSourceHash('abd'));
  });

  it('行视图：空行/注释/指令/步骤/未映射，stepOrigin 回填 stepId', () => {
    const lines = buildNlLines(
      ['', '# 注释', '打开 https://demo.example.com', '点击「登录」', '未识别的一行'].join('\n'),
      { s9: { nlLine: 4 } },
      new Set([5]),
    );
    expect(lines.map((line) => line.kind)).toEqual(['blank', 'comment', 'instruction', 'step', 'unmapped']);
    expect(lines[0]!.stepId).toBeNull();
    expect(lines[3]!.stepId).toBe('s9');
    expect(lines[4]!.stepId).toBeNull();
    expect(lines.map((line) => line.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it('5 态派生：draft/generating/generated/stale/invalid 全部可达', () => {
    const base = { text: '有文本', currentHash: 'aaaa', hasActive: false, acceptedHash: null, latestStatus: null };
    expect(deriveNlStatus({ ...base, text: '   ' })).toBe('draft');
    expect(deriveNlStatus({ ...base, hasActive: true })).toBe('generating');
    expect(deriveNlStatus({ ...base, acceptedHash: 'aaaa' })).toBe('generated');
    expect(deriveNlStatus({ ...base, acceptedHash: 'bbbb' })).toBe('stale');
    expect(deriveNlStatus({ ...base, latestStatus: 'failed' })).toBe('invalid');
    expect(deriveNlStatus(base)).toBe('draft');
  });
});