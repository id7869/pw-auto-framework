/**
 * SSE 输出（api-contract §0.4 可选增强）：事件 `run.updated` / `item.updated` / `run.log` / `heartbeat`。
 *
 * 纪律：SSE 只是「更快看到状态」，轮询端点始终是 MUST；断线不影响运行与状态一致性。
 */

import type { ServerResponse } from 'node:http';

export interface SseStream {
  send(event: string, data: unknown): void;
  /** 发送注释帧（用于 keep-alive 之外的调试） */
  comment(text: string): void;
  close(): void;
  readonly closed: boolean;
}

export function openSseStream(res: ServerResponse, requestId: string, onClose: () => void): SseStream {
  let closed = false;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': requestId,
  });
  res.write(': connected\n\n');
  res.write('retry: 2000\n\n');

  return {
    get closed(): boolean {
      return closed;
    },
    send(event: string, data: unknown): void {
      if (closed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // 客户端已断开：交给 close 处理
        closed = true;
        onClose();
      }
    },
    comment(text: string): void {
      if (closed) return;
      res.write(`: ${text}\n\n`);
    },
    close(): void {
      if (closed) return;
      closed = true;
      onClose();
      try {
        res.end();
      } catch {
        // 忽略重复关闭
      }
    },
  };
}