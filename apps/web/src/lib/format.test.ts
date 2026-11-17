import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDeltaMs,
  formatDuration,
  formatRatio,
  runDurationMs,
  runStatusLabel,
  shortId,
  truncateText,
} from './format.ts';

describe('web/lib/format', () => {
  it('毫秒级时长', () => {
    expect(formatDuration(0)).toBe('0 毫秒');
    expect(formatDuration(432)).toBe('432 毫秒');
  });

  it('秒级与分级时长', () => {
    expect(formatDuration(1234)).toBe('1.2 秒');
    expect(formatDuration(65000)).toBe('1 分 5 秒');
    expect(formatDuration(120000)).toBe('2 分');
  });

  it('非法输入返回占位符', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });

  it('状态标签覆盖 6 态并兜底未知值', () => {
    expect(runStatusLabel('queued')).toBe('排队中');
    expect(runStatusLabel('passed')).toBe('通过');
    expect(runStatusLabel('cancelling')).toContain('未知状态');
  });

  it('时间格式化：合法 / 空 / 非法', () => {
    expect(formatDateTime('2026-11-11T02:03:04.567Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatDate('2026-11-11T02:03:04.567Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(formatDate(undefined)).toBe('—');
  });

  it('字节数格式化', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(-1)).toBe('—');
  });

  it('时长差值与比例', () => {
    expect(formatDeltaMs(0)).toBe('无变化');
    expect(formatDeltaMs(1200)).toBe('+1.2 秒');
    expect(formatDeltaMs(-500)).toBe('-500 毫秒');
    expect(formatDeltaMs(null)).toBe('—');
    expect(formatRatio(2, 3)).toBe('66.7%');
    expect(formatRatio(0, 0)).toBe('—');
  });

  it('短 id 与文本截断', () => {
    expect(shortId('short')).toBe('short');
    expect(shortId('run_1234567890abcdef', 8)).toBe('run_1234…');
    expect(truncateText('  a \n b  ')).toBe('a b');
    expect(truncateText('x'.repeat(20), 5)).toBe('xxxxx…');
  });

  it('运行耗时优先 stats，其次起止时间，再兜底 0', () => {
    expect(runDurationMs({ stats: { durationMs: 1234 } })).toBe(1234);
    expect(runDurationMs({ stats: { durationMs: Number.NaN }, startedAt: '2026-11-11T00:00:00.000Z', finishedAt: '2026-11-11T00:00:02.000Z' })).toBe(2000);
    expect(runDurationMs({})).toBe(0);
  });
});