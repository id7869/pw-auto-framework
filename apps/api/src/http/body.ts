/**
 * 请求体读取：只接受 JSON，1 MiB 上限；非法/超限/类型错误分别映射固定错误码。
 */

import type { IncomingMessage } from 'node:http';
import { AppError } from '../errors.ts';

export async function readRawBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const contentLengthRaw = req.headers['content-length'];
  if (typeof contentLengthRaw === 'string') {
    const declared = Number(contentLengthRaw);
    if (Number.isFinite(declared) && declared > limitBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', `请求体超过上限 ${(limitBytes / 1024).toFixed(0)} KiB`);
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > limitBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', `请求体超过上限 ${(limitBytes / 1024).toFixed(0)} KiB`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function parseJsonBody(buffer: Buffer): unknown {
  if (buffer.byteLength === 0) return {};
  const text = buffer.toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

export function assertJsonContentType(req: IncomingMessage, hasBody: boolean): void {
  if (!hasBody) return;
  const contentType = req.headers['content-type'];
  const value = typeof contentType === 'string' ? contentType.toLowerCase() : '';
  if (!value.includes('application/json')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '请求体必须是 application/json');
  }
}