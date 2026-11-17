/**
 * 通用工具：时间、哈希、文本截断、JSON 安全解析。
 * 说明：错误哈希用于「同一失败是否变化」的对比（api-contract §5.2 errorHash）。
 */

import { createHash } from 'node:crypto';

export function isoNow(): string {
  return new Date().toISOString();
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 去掉 ANSI 颜色、行首尾空白、连续空白，得到「稳定」的错误文本 */
export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/[ \t]+/g, ' ');
}

/** 错误指纹：无错误时为空串（不伪造哈希） */
export function hashError(message: string | null | undefined): string {
  if (message === null || message === undefined || message.trim() === '') return '';
  return sha256Hex(normalizeErrorMessage(message));
}

/** 按 UTF-8 字节截断（不切断多字节字符），用于 stdout/stderr 落库限长 */
export function truncateUtf8(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(input, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: input, truncated: false };
  let end = maxBytes;
  // 回退到字符边界（UTF-8 续字节形如 10xxxxxx）
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

export function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** 逻辑时钟：保证同一毫秒内多次写入也有稳定顺序（配合 id 兜底） */
export function nextTimestamp(previous: string | null | undefined): string {
  const now = Date.now();
  if (!previous) return new Date(now).toISOString();
  const previousMs = Date.parse(previous);
  if (!Number.isFinite(previousMs) || previousMs < now) return new Date(now).toISOString();
  return new Date(previousMs + 1).toISOString();
}