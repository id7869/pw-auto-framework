/**
 * 官方产物索引：trace / 截图 / 视频 / JSON 报告 / stdout / stderr / 规格文件。
 *
 * 只读 workspaceDir；不解析 stdout 冒充结果。产物 sha256 用于回归对比的“产物变化”证据。
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { EngineArtifactKind, EngineRunArtifact } from '../types.ts';

export interface ArtifactIndexInput {
  workspaceDir: string;
  reportPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  specsDir: string;
  htmlReportDir?: string;
  /** 官方附件绝对路径 → itemKey（来自 JSON 报告 results[].attachments[].path）。 */
  attachmentItemKeys: Map<string, string>;
}

export interface ArtifactIndexResult {
  artifacts: EngineRunArtifact[];
  warnings: string[];
}

/** Windows 路径大小写不敏感，统一 key。 */
export function pathKey(absolutePath: string): string {
  const normalized = path.resolve(absolutePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function toPosixRelative(rootDir: string, absolutePath: string): string {
  const relative = path.relative(rootDir, absolutePath);
  return relative.split(path.sep).join('/');
}

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function classify(absolutePath: string, input: ArtifactIndexInput): { kind: EngineArtifactKind; contentType: string } {
  const rel = toPosixRelative(input.workspaceDir, absolutePath);
  const lower = rel.toLowerCase();
  const baseName = path.basename(lower);
  if (pathKey(absolutePath) === pathKey(input.reportPath)) {
    return { kind: 'json-report', contentType: 'application/json' };
  }
  if (pathKey(absolutePath) === pathKey(input.stdoutLogPath)) return { kind: 'stdout', contentType: 'text/plain' };
  if (pathKey(absolutePath) === pathKey(input.stderrLogPath)) return { kind: 'stderr', contentType: 'text/plain' };
  if (lower.startsWith(toPosixRelative(input.workspaceDir, input.specsDir).toLowerCase()) && lower.endsWith('.spec.ts')) {
    return { kind: 'spec', contentType: 'text/plain' };
  }
  const ext = path.extname(baseName);
  if (baseName === 'trace.zip' || (ext === '.zip' && lower.includes('trace'))) {
    return { kind: 'trace', contentType: 'application/zip' };
  }
  if (IMAGE_CONTENT_TYPES[ext] !== undefined) {
    return { kind: 'screenshot', contentType: IMAGE_CONTENT_TYPES[ext] as string };
  }
  if (ext === '.webm') return { kind: 'video', contentType: 'video/webm' };
  if (ext === '.mp4') return { kind: 'video', contentType: 'video/mp4' };
  if (ext === '.pdf') return { kind: 'other', contentType: 'application/pdf' };
  if (lower.startsWith('.playwright-cli/')) {
    if (baseName.startsWith('page-') && (ext === '.yml' || ext === '.yaml')) {
      return { kind: 'snapshot', contentType: 'application/yaml' };
    }
    if (baseName.startsWith('console-')) return { kind: 'console', contentType: 'text/plain' };
  }
  if (baseName === 'error-context.md') return { kind: 'other', contentType: 'text/markdown' };
  if (baseName === '.last-run.json') return { kind: 'other', contentType: 'application/json' };
  if (ext === '.html') return { kind: 'other', contentType: 'text/html' };
  if (ext === '.json') return { kind: 'other', contentType: 'application/json' };
  if (ext === '.log') return { kind: 'console', contentType: 'text/plain' };
  if (ext === '.yml' || ext === '.yaml') return { kind: 'snapshot', contentType: 'application/yaml' };
  return { kind: 'other', contentType: 'application/octet-stream' };
}

async function hashFile(absolutePath: string, sizeBytes: number): Promise<string> {
  if (sizeBytes <= 8 * 1024 * 1024) {
    return createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex');
  }
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

interface WalkEntry {
  absolutePath: string;
  itemKey: string | null;
}

function buildDirectoryItemKeys(attachmentItemKeys: Map<string, string>): Map<string, string> {
  const byDirectory = new Map<string, string>();
  for (const [absolutePath, itemKey] of attachmentItemKeys.entries()) {
    const dir = pathKey(path.dirname(absolutePath));
    if (!byDirectory.has(dir)) byDirectory.set(dir, itemKey);
  }
  return byDirectory;
}

function resolveItemKey(absolutePath: string, byDirectory: Map<string, string>, attachmentItemKeys: Map<string, string>): string | null {
  const direct = attachmentItemKeys.get(pathKey(absolutePath));
  if (direct !== undefined) return direct;
  const directExact = attachmentItemKeys.get(absolutePath);
  if (directExact !== undefined) return directExact;
  let current = path.dirname(absolutePath);
  for (let depth = 0; depth < 8; depth += 1) {
    const found = byDirectory.get(pathKey(current));
    if (found !== undefined) return found;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function walkFiles(rootDir: string, warnings: string[]): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      warnings.push(`无法读取目录：${current}（${(error as Error).message}）`);
      continue;
    }
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.cache') continue;
        stack.push(absolutePath);
        continue;
      }
      if (entry.isFile()) files.push(absolutePath);
    }
  }
  return files;
}

/**
 * 索引本次 run 的全部产物。
 * @throws Error 仅当无法读取文件系统；目录读失败记录 warning 并继续。
 */
export async function indexRunArtifacts(input: ArtifactIndexInput): Promise<ArtifactIndexResult> {
  const warnings: string[] = [];
  const files = await walkFiles(input.workspaceDir, warnings);
  const byDirectory = buildDirectoryItemKeys(input.attachmentItemKeys);
  const seen = new Set<string>();
  const artifacts: EngineRunArtifact[] = [];

  for (const absolutePath of files) {
    const key = pathKey(absolutePath);
    if (seen.has(key)) continue;
    seen.add(key);
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch (error) {
      warnings.push(`无法读取产物：${toPosixRelative(input.workspaceDir, absolutePath)}（${(error as Error).message}）`);
      continue;
    }
    if (!stat.isFile()) continue;
    const classified = classify(absolutePath, input);
    let sha256: string;
    try {
      sha256 = await hashFile(absolutePath, stat.size);
    } catch (error) {
      warnings.push(`无法计算哈希：${toPosixRelative(input.workspaceDir, absolutePath)}（${(error as Error).message}）`);
      continue;
    }
    artifacts.push({
      itemKey: resolveItemKey(absolutePath, byDirectory, input.attachmentItemKeys),
      kind: classified.kind,
      relPath: toPosixRelative(input.workspaceDir, absolutePath),
      fileName: path.basename(absolutePath),
      sizeBytes: stat.size,
      sha256,
      contentType: classified.contentType,
      createdAt: stat.mtime.toISOString(),
    });
  }

  artifacts.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { artifacts, warnings };
}