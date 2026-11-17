/**
 * 路径安全：受控根目录内的路径解析与越界防护。
 *
 * 规则（api-contract §10）：
 * - 绝对路径 / 盘符 / UNC / 含 `..` / 含 NUL → 400 INVALID_PATH；
 * - 解析后不在受控根内 → 403 PATH_FORBIDDEN；
 * - 禁止用请求参数直接拼磁盘路径（调用方必须先 resolveRelative 再校验）。
 */

import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppError } from './errors.ts';

function normalizeForCompare(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 判断 candidate 是否位于 root 内（含 root 本身） */
export function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep);
}

/** 断言 candidate 在 root 内，否则 403 PATH_FORBIDDEN */
export function assertWithinRoot(root: string, candidate: string, hint?: string): string {
  if (!isWithinRoot(root, candidate)) {
    throw new AppError('PATH_FORBIDDEN', hint ?? '请求的路径越出受控目录，已拒绝');
  }
  return resolve(candidate);
}

/** 危险路径形态检查（绝对路径/UNC/盘符/`..`/NUL） */
export function isPathShapedDangerous(input: string): boolean {
  if (input.length === 0) return true;
  if (input.includes('\0')) return true;
  if (isAbsolute(input)) return true;
  if (/^[A-Za-z]:/.test(input)) return true;
  if (input.startsWith('\\\\') || input.startsWith('//')) return true;
  return input.split(/[\\/]+/).some((segment) => segment === '..');
}

/**
 * 把「相对受控根的路径」解析为绝对路径。
 * 越界形态 → 400 INVALID_PATH；解析后越界 → 403 PATH_FORBIDDEN。
 */
export function resolveRelative(root: string, relativePath: string, hint?: string): string {
  if (isPathShapedDangerous(relativePath)) {
    throw new AppError('INVALID_PATH', hint ?? `路径参数非法：${relativePath}`);
  }
  const absolute = resolve(root, relativePath);
  return assertWithinRoot(root, absolute, hint);
}

/** 生成「相对受控根」的展示路径（POSIX 分隔符），用于响应与索引 */
export function toRelativePosix(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel.split(sep).join('/');
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 运行工作区：<dataDir>/runs/<runId> */
export function runWorkspaceDir(dataDir: string, runId: string): string {
  return join(dataDir, 'runs', runId);
}

/** Agent 脚手架受控根：<repoRoot>/agents/<scaffoldId> */
export function scaffoldTargetDir(repoRoot: string, scaffoldId: string): string {
  return join(repoRoot, 'agents', scaffoldId);
}

/** MCP 会话工作目录：<dataDir>/mcp/<sessionId> */
export function mcpSessionDir(dataDir: string, sessionId: string): string {
  return join(dataDir, 'mcp', sessionId);
}