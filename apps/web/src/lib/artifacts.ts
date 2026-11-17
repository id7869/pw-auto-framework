/**
 * 附件 ↔ 产物匹配（纯函数）。
 *
 * 背景：官方 JSON 报告只给附件名/类型；后端登记产物时不一定能把 attachment.artifactId
 * 回填（F4）。因此在展示层按「itemKey + 附件名 + contentType」做保守匹配：
 * - artifactId 有值时优先精确命中；
 * - 否则只在同一 itemKey 的产物中按文件名匹配；同名多个时要求 contentType 唯一；
 * - 找不到或存在歧义时返回 undefined（宁可显示“未登记”，不误链到别人的 trace/截图）。
 */
import type { Artifact, RunItemAttachment } from '../api/types.ts';

function baseName(path: string): string {
  const normalized = path.replace(/\\/gu, '/');
  const parts = normalized.split('/');
  return (parts[parts.length - 1] ?? normalized).trim().toLowerCase();
}

function looselySameName(artifactFileName: string, attachmentName: string): boolean {
  const a = baseName(artifactFileName);
  const b = baseName(attachmentName);
  if (a === '' || b === '') return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`) || a.endsWith(b) || b.endsWith(a);
}

export function findAttachmentArtifact(
  attachment: RunItemAttachment,
  itemKey: string | null,
  artifacts: readonly Artifact[],
): Artifact | undefined {
  if (attachment.artifactId !== null && attachment.artifactId !== '') {
    const exact = artifacts.find((artifact) => artifact.id === attachment.artifactId);
    if (exact) return exact;
  }

  const attachmentName = baseName(attachment.name);
  // 没有附件名就无法做保守关联；不要仅凭 contentType 猜（可能是同类型的另一张截图）
  if (attachmentName === '') return undefined;

  const sameItem = itemKey === null ? artifacts : artifacts.filter((artifact) => artifact.itemKey === itemKey);
  // 若该结果项没有产物，再看看未绑定 itemKey 的运行级产物（如 json-report）
  const pool = sameItem.length > 0 ? sameItem : artifacts.filter((artifact) => artifact.itemKey === null);

  const byName = pool.filter((artifact) => looselySameName(artifact.fileName, attachment.name));
  const exactName = byName.find((artifact) => baseName(artifact.fileName) === attachmentName);
  if (exactName) return exactName;
  if (byName.length === 1) return byName[0];

  const withType = byName.filter((artifact) => artifact.contentType === attachment.contentType);
  if (withType.length === 1) return withType[0];

  // 名称未命中时，仅当同 itemKey 下该 contentType 唯一才降级匹配，避免多张截图误关联
  const byType = pool.filter((artifact) => artifact.contentType === attachment.contentType);
  if (byType.length === 1) return byType[0];

  return undefined;
}