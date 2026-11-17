import { describe, expect, it } from 'vitest';
import type { Artifact, RunItemAttachment } from '../api/types.ts';
import { findAttachmentArtifact } from './artifacts.ts';

function artifact(overrides: Partial<Artifact>): Artifact {
  return {
    id: 'art_1',
    runId: 'run_1',
    itemKey: 'case_1#row:1',
    kind: 'trace',
    fileName: 'trace.zip',
    sizeBytes: 2048,
    sha256: 'abcdef0123456789',
    contentType: 'application/zip',
    createdAt: '2026-11-11T02:00:04.000Z',
    ...overrides,
  };
}

function attachment(overrides: Partial<RunItemAttachment>): RunItemAttachment {
  return { name: 'trace.zip', contentType: 'application/zip', artifactId: null, ...overrides };
}

describe('lib/artifacts：附件与产物匹配（artifactId 为空时的降级）', () => {
  it('artifactId 有值时优先精确命中', () => {
    const target = artifact({ id: 'art_x', fileName: 'other.zip' });
    expect(findAttachmentArtifact(attachment({ artifactId: 'art_x' }), 'case_1#row:1', [artifact({}), target])?.id).toBe('art_x');
  });

  it('artifactId=null 时按 itemKey + 文件名匹配', () => {
    const target = artifact({ fileName: 'trace.zip' });
    expect(findAttachmentArtifact(attachment({ artifactId: null }), 'case_1#row:1', [target])?.id).toBe('art_1');
    // 报告里带目录、登记时只有文件名（或反之）也能匹配
    expect(findAttachmentArtifact(attachment({ name: 'nested/trace.zip' }), 'case_1#row:1', [target])?.id).toBe('art_1');
  });

  it('不同 itemKey 的同名产物不会被误关联', () => {
    const otherItem = artifact({ itemKey: 'case_1#row:2' });
    expect(findAttachmentArtifact(attachment({ artifactId: null }), 'case_1#row:1', [otherItem])).toBeUndefined();
  });

  it('文件名不一致但同 itemKey 下 contentType 唯一时降级匹配', () => {
    const screenshot = artifact({ id: 'art_shot', fileName: 'failure.png', kind: 'screenshot', contentType: 'image/png' });
    const matched = findAttachmentArtifact(
      attachment({ name: 'attachment.png', contentType: 'image/png', artifactId: null }),
      'case_1#row:1',
      [screenshot],
    );
    expect(matched?.id).toBe('art_shot');
  });

  it('同 itemKey 下同类型产物多于一个时保持未知（不猜）', () => {
    const first = artifact({ id: 'art_1', fileName: 'failure-1.png', kind: 'screenshot', contentType: 'image/png' });
    const second = artifact({ id: 'art_2', fileName: 'failure-2.png', kind: 'screenshot', contentType: 'image/png' });
    expect(
      findAttachmentArtifact(attachment({ name: 'unknown.png', contentType: 'image/png', artifactId: null }), 'case_1#row:1', [first, second]),
    ).toBeUndefined();
  });

  it('运行级（itemKey=null）产物可作为同 itemKey 无产物时的回退', () => {
    const report = artifact({ id: 'art_report', itemKey: null, fileName: 'report.json', kind: 'json-report', contentType: 'application/json' });
    const matched = findAttachmentArtifact(
      attachment({ name: 'report.json', contentType: 'application/json', artifactId: null }),
      'case_1#row:1',
      [report],
    );
    expect(matched?.id).toBe('art_report');
  });

  it('无候选时返回 undefined', () => {
    expect(findAttachmentArtifact(attachment({ artifactId: null }), 'case_1#row:1', [])).toBeUndefined();
    expect(findAttachmentArtifact(attachment({ name: '', artifactId: null }), null, [artifact({})])).toBeUndefined();
  });
});