/**
 * 运行事件流（SSE，api-contract §0.4 可选增强）合同。
 *
 * 事件名固定；`data` 为 JSON 序列化的稳定负载：
 * - `run.updated`：完整 `Run`
 * - `item.updated`：完整 `RunItem`
 * - `run.log`：`{ message: string }`
 * - `heartbeat`：`{ at: string }`
 */

export const RUN_EVENT_NAMES = ['run.updated', 'item.updated', 'run.log', 'heartbeat'] as const;
export type RunEventName = (typeof RUN_EVENT_NAMES)[number];

export interface RunLogPayload {
  message: string;
}

export interface HeartbeatPayload {
  at: string;
}

export interface SseFrame {
  event: RunEventName;
  data: unknown;
}