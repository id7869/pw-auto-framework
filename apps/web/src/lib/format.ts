/**
 * 纯逻辑工具函数：不依赖 DOM，可被 vitest 直接单测。
 */

/** 把毫秒格式化为中文可读时长，例如 1234 → "1.2 秒"、65000 → "1 分 5 秒" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${Number(totalSeconds.toFixed(1))} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}

/** 运行状态的中文标签（与 docs/api-contract.md §0.5 的 6 态一一对应） */
export function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: '排队中',
    running: '运行中',
    passed: '通过',
    failed: '失败',
    cancelled: '已取消',
    error: '错误',
  };
  return labels[status] ?? `未知状态（${status}）`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** UTC ISO-8601 → 本地可读时间（非法/空值返回占位符） */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/** 仅本地日期部分 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 字节数 → 人类可读（B/KB/MB/GB） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Number(kb.toFixed(1))} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${Number(mb.toFixed(1))} MB`;
  return `${Number((mb / 1024).toFixed(1))} GB`;
}

/** 时长差值（回归对比）→ "+1.2 秒" / "-500 毫秒" / "无变化" */
export function formatDeltaMs(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return '—';
  if (delta === 0) return '无变化';
  const sign = delta > 0 ? '+' : '-';
  return `${sign}${formatDuration(Math.abs(delta))}`;
}

/** 比例（0..1）→ 百分比文本；分母为 0 时返回占位符 */
export function formatRatio(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return '—';
  const ratio = (numerator / denominator) * 100;
  return `${Number(ratio.toFixed(1))}%`;
}

/** 长 id 的表格展示形式 */
export function shortId(id: string, head = 10): string {
  if (id.length <= head + 1) return id;
  return `${id.slice(0, head)}…`;
}

/** 文本截断（用于错误摘要） */
export function truncateText(text: string, max = 160): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

/** 运行总耗时：优先 stats.durationMs，缺失时用起止时间推导 */
export function runDurationMs(run: {
  stats?: { durationMs?: number } | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}): number {
  const fromStats = run.stats?.durationMs;
  if (typeof fromStats === 'number' && Number.isFinite(fromStats) && fromStats >= 0) return fromStats;
  if (run.startedAt && run.finishedAt) {
    const start = new Date(run.startedAt).getTime();
    const end = new Date(run.finishedAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  }
  return 0;
}