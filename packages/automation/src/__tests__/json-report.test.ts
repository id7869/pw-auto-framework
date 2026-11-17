import { describe, expect, it } from 'vitest';

import { hashErrorMessage, normalizeErrorMessage, parseJsonReport, truncateUtf8 } from '../index.ts';
import { parseGeneratedRowTag, type JsonReport } from '../runner/jsonReport.ts';

const WORKSPACE = 'C:\\tmp\\ws';
const resolveAttachmentRelPath = (absolutePath: string): string | undefined => {
  const prefix = `${WORKSPACE}\\`;
  if (!absolutePath.startsWith(prefix)) return undefined;
  return absolutePath.slice(prefix.length).split('\\').join('/');
};

function buildReport(): JsonReport {
  return {
    config: {},
    stats: { startTime: '2026-11-11T00:00:00.000Z', duration: 1234.5, expected: 1, unexpected: 1, flaky: 1, skipped: 1 },
    errors: [],
    suites: [
      {
        title: 'case_1.spec.ts',
        specs: [
          {
            title: '演示用例 [row:0]',
            tests: [
              {
                projectName: 'pw-auto',
                status: 'expected',
                results: [
                  {
                    retry: 0,
                    status: 'passed',
                    duration: 120.4,
                    startTime: '2026-11-11T00:00:01.000Z',
                    steps: [{ title: '步骤 1/2：打开页面', duration: 30 }],
                    stdout: [],
                    stderr: [],
                    attachments: [],
                  },
                ],
              },
            ],
          },
          {
            title: '演示用例 [row:1]',
            tests: [
              {
                projectName: 'pw-auto',
                status: 'flaky',
                results: [
                  {
                    retry: 0,
                    status: 'failed',
                    duration: 300,
                    startTime: '2026-11-11T00:00:02.000Z',
                    errors: [
                      {
                        message: '\u001B[31mError: expect(locator).toHaveText failed\u001B[39m\nExpected: "你好"\nReceived: "错误"',
                        stack: 'stack line',
                        location: { file: 'spec.ts', line: 12, column: 7 },
                      },
                    ],
                    steps: [
                      {
                        title: '步骤 2/2：断言文本',
                        duration: 100,
                        error: { message: 'Error: expect(locator).toHaveText failed' },
                        steps: [{ title: '内层步骤', duration: 10 }],
                      },
                    ],
                    stdout: ['第一行', '第二行'],
                    stderr: ['错误输出'],
                    attachments: [
                      { name: 'trace', contentType: 'application/zip', path: `${WORKSPACE}\\test-results\\a\\trace.zip` },
                      { name: 'screenshot', contentType: 'image/png', path: `${WORKSPACE}\\test-results\\a\\test-failed-1.png` },
                      { name: 'body', contentType: 'text/plain', body: '不在磁盘' },
                      { name: 'outside', contentType: 'text/plain', path: 'C:\\Windows\\win.ini' },
                    ],
                  },
                  {
                    retry: 1,
                    status: 'passed',
                    duration: 50,
                    startTime: '2026-11-11T00:00:03.000Z',
                    stdout: ['x'],
                    stderr: [],
                    attachments: [],
                  },
                ],
              },
            ],
          },
          {
            title: '演示用例 [row:2]',
            tests: [
              {
                projectName: '',
                status: 'skipped',
                results: [{ retry: 0, status: 'skipped', duration: 0, startTime: '2026-11-11T00:00:04.000Z' }],
              },
            ],
          },
          {
            title: '演示用例 [row:3]',
            tests: [
              {
                projectName: 'pw-auto',
                status: 'unexpected',
                results: [
                  {
                    retry: 0,
                    status: 'timedOut',
                    duration: 60000,
                    startTime: '2026-11-11T00:00:05.000Z',
                    error: { message: 'Test timeout of 60000ms exceeded.' },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** 单 spec 报告：用于验证标题 row 标记解析策略。 */
function singleSpecReport(title: string): JsonReport {
  return {
    config: {},
    stats: { duration: 1, expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    errors: [],
    suites: [
      {
        title: 'case_1.spec.ts',
        specs: [
          {
            title,
            tests: [
              {
                projectName: 'pw-auto',
                status: 'expected',
                results: [
                  { retry: 0, status: 'passed', duration: 1, startTime: '2026-11-11T00:00:00.000Z', stdout: [], stderr: [], attachments: [] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('runner/jsonReport · 官方 JSON 报告解析', () => {
  it('stats / 逐项 outcome / itemKey / attempt / steps / 附件映射', () => {
    const parsed = parseJsonReport(buildReport(), {
      caseId: 'case_1',
      workspaceDir: WORKSPACE,
      resolveAttachmentRelPath,
      expectedRowIndexes: [0, 1, 2, 3],
      expectedItemKeys: ['case_1#row:0', 'case_1#row:1', 'case_1#row:2', 'case_1#row:3'],
    });
    expect(parsed.stats).toEqual({ expected: 1, unexpected: 1, flaky: 1, skipped: 1, durationMs: 1235 });
    expect(parsed.items.map((item) => item.itemKey)).toEqual([
      'case_1#row:0',
      'case_1#row:1',
      'case_1#row:2',
      'case_1#row:3',
    ]);
    expect(parsed.items.map((item) => item.outcome)).toEqual(['expected', 'flaky', 'skipped', 'unexpected']);
    expect(parsed.items.map((item) => item.rowIndex)).toEqual([0, 1, 2, 3]);
    expect(parsed.items[0]?.projectName).toBe('pw-auto');
    expect(parsed.items[2]?.projectName).toBeNull();

    const flaky = parsed.items[1];
    expect(flaky?.durationMs).toBe(350);
    expect(flaky?.attempts).toHaveLength(2);
    expect(flaky?.attempts.map((attempt) => attempt.attempt)).toEqual([0, 1]);
    expect(flaky?.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);
    expect(flaky?.attempts[0]?.error?.location).toEqual({ file: 'spec.ts', line: 12, column: 7 });
    expect(flaky?.attempts[0]?.errorHash).toMatch(/^[0-9a-f]{64}$/);
    expect(flaky?.attempts[0]?.steps[0]?.title).toBe('步骤 2/2：断言文本');
    expect(flaky?.attempts[0]?.steps[0]?.steps?.[0]?.title).toBe('内层步骤');
    expect(flaky?.attempts[0]?.stdout).toBe('第一行\n第二行');
    expect(flaky?.attempts[0]?.stderr).toBe('错误输出');
    expect(flaky?.attempts[0]?.truncated).toBe(false);
    expect(flaky?.attempts[0]?.attachments.map((attachment) => attachment.relPath)).toEqual([
      'test-results/a/trace.zip',
      'test-results/a/test-failed-1.png',
      undefined,
      undefined,
    ]);
    expect(parsed.attachmentItemKeys.get(`${WORKSPACE}\\test-results\\a\\trace.zip`)).toBe('case_1#row:1');
    expect(parsed.warnings.some((warning) => warning.includes('C:\\Windows\\win.ini'))).toBe(true);

    const timedOut = parsed.items[3]?.attempts[0];
    expect(timedOut?.status).toBe('timedOut');
    expect(timedOut?.error?.message).toContain('timeout');
  });

  it('重复标题追加 #idx:N，保持官方顺序', () => {
    const report = buildReport();
    const duplicated = report.suites?.[0]?.specs?.[0];
    if (duplicated !== undefined && report.suites?.[0]?.specs !== undefined) {
      report.suites[0].specs.push({ ...duplicated });
    }
    const parsed = parseJsonReport(report, {
      caseId: 'case_1',
      workspaceDir: WORKSPACE,
      resolveAttachmentRelPath,
      expectedRowIndexes: [0, 1, 2, 3],
      expectedItemKeys: ['case_1#row:0', 'case_1#row:1', 'case_1#row:2', 'case_1#row:3'],
    });
    expect(parsed.items.map((item) => item.itemKey)).toContain('case_1#row:0#idx:1');
  });

  it('case 名/code 模式标题自带 [row:N]：无编译期行上下文时绝不解析为数据行', () => {
    for (const title of ['演示用例 [row:9]', '原生用例 [row:7]', '带标签 [row:0] [row:5]']) {
      const report = singleSpecReport(title);
      const parsed = parseJsonReport(report, {
        caseId: 'case_1',
        workspaceDir: WORKSPACE,
        resolveAttachmentRelPath,
        expectedRowIndexes: [],
        expectedItemKeys: ['case_1'],
      });
      expect(parsed.items[0]?.rowIndex, title).toBeNull();
      expect(parsed.items[0]?.itemKey, title).toBe('case_1');
      expect(parsed.items[0]?.title, title).toBe(title);
    }
  });

  it('数据行模式只接受编译期行号集合内的“末尾”生成标记', () => {
    const inRange = parseJsonReport(singleSpecReport('数据驱动 [row:1]'), {
      caseId: 'case_1',
      workspaceDir: WORKSPACE,
      resolveAttachmentRelPath,
      expectedRowIndexes: [0, 1],
      expectedItemKeys: ['case_1#row:0', 'case_1#row:1'],
    });
    expect(inRange.items[0]?.rowIndex).toBe(1);
    expect(inRange.items[0]?.itemKey).toBe('case_1#row:1');

    const outOfRange = parseJsonReport(singleSpecReport('数据驱动 [row:2]'), {
      caseId: 'case_1',
      workspaceDir: WORKSPACE,
      resolveAttachmentRelPath,
      expectedRowIndexes: [0, 1],
      expectedItemKeys: ['case_1#row:0', 'case_1#row:1'],
    });
    expect(outOfRange.items[0]?.rowIndex).toBeNull();
    expect(outOfRange.items[0]?.itemKey).toBe('case_1');
    expect(outOfRange.warnings.some((warning) => warning.includes('未匹配编译期 [row:N]'))).toBe(true);

    const notTrailing = parseJsonReport(singleSpecReport('数据驱动 [row:1] 后缀'), {
      caseId: 'case_1',
      workspaceDir: WORKSPACE,
      resolveAttachmentRelPath,
      expectedRowIndexes: [0, 1],
    });
    expect(notTrailing.items[0]?.rowIndex).toBeNull();
  });

  it('ANSI 归一化与 errorHash 稳定性', () => {
    expect(normalizeErrorMessage('\u001B[31mError\u001B[39m\r\nnext  ')).toBe('Error\nnext');
    expect(hashErrorMessage('\u001B[31mError: 失败\u001B[39m')).toBe(hashErrorMessage('Error: 失败'));
    expect(hashErrorMessage('Error: 失败')).not.toBe(hashErrorMessage('Error: 另一个失败'));
    expect(hashErrorMessage(undefined)).toBe('');
  });

  it('stdout/stderr 按 8 KiB 截断并标记', () => {
    const long = 'a'.repeat(9000);
    const truncated = truncateUtf8(long);
    expect(truncated.truncated).toBe(true);
    expect(Buffer.byteLength(truncated.text, 'utf8')).toBeLessThanOrEqual(8192);
    const brief = truncateUtf8('中文');
    expect(brief).toEqual({ text: '中文', truncated: false });
  });

  it('parseGeneratedRowTag 只接受末尾且属于编译期行号集合的生成标记', () => {
    const context = { expectedRowIndexes: [0, 1], expectedItemKeys: ['case_1#row:0', 'case_1#row:1'] };
    expect(parseGeneratedRowTag('演示 [row:0]', 'case_1', context)).toBe(0);
    expect(parseGeneratedRowTag('演示 [row:0] ', 'case_1', context)).toBe(0);
    expect(parseGeneratedRowTag('演示', 'case_1', context)).toBeNull();
    expect(parseGeneratedRowTag('演示 [row:2]', 'case_1', context)).toBeNull();
    expect(parseGeneratedRowTag('演示 [row:0] 后缀', 'case_1', context)).toBeNull();
    expect(parseGeneratedRowTag('演示 [row:0]', 'case_1', { expectedRowIndexes: [] })).toBeNull();
    expect(
      parseGeneratedRowTag('演示 [row:0]', 'case_1', { expectedRowIndexes: [0], expectedItemKeys: ['case_other#row:0'] }),
    ).toBeNull();
  });

  it('非对象 / 缺 suites / 缺 stats → 抛错（由 runner 映射 ENGINE_ERROR）', () => {
    expect(() =>
      parseJsonReport(null, { caseId: 'case_1', workspaceDir: WORKSPACE, resolveAttachmentRelPath }),
    ).toThrow(/对象/);
    expect(() =>
      parseJsonReport({ stats: {} }, { caseId: 'case_1', workspaceDir: WORKSPACE, resolveAttachmentRelPath }),
    ).toThrow(/suites/);
    expect(() =>
      parseJsonReport({ suites: [] }, { caseId: 'case_1', workspaceDir: WORKSPACE, resolveAttachmentRelPath }),
    ).toThrow(/stats/);
  });
});