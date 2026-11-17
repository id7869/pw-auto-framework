/**
 * 中文标签与文案映射（单一来源）：状态、结果、回归差异、产物类型、错误码。
 * 取值枚举严格来自 docs/api-contract.md 与 packages/contracts。
 */
import type {
  AgentEntry,
  ArtifactKind,
  BaselineCreator,
  BaselineScope,
  CaseMode,
  ComparisonChange,
  DatasetSource,
  FailureCategory,
  ItemOutcomeValue,
  NlGenerationStatus,
  NlStatus,
  NlWarningCode,
  RunStatus,
} from '../api/types.ts';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: '排队中',
  running: '运行中',
  passed: '通过',
  failed: '失败',
  cancelled: '已取消',
  error: '错误',
};

export const RUN_STATUS_TONES: Record<RunStatus, Tone> = {
  queued: 'neutral',
  running: 'info',
  passed: 'success',
  failed: 'danger',
  cancelled: 'warning',
  error: 'danger',
};

export const OUTCOME_LABELS: Record<ItemOutcomeValue, string> = {
  expected: '通过',
  unexpected: '失败',
  flaky: '偶发失败（重试通过）',
  skipped: '跳过',
  missing: '缺失',
  unknown: '未知',
};

export const OUTCOME_TONES: Record<ItemOutcomeValue, Tone> = {
  expected: 'success',
  unexpected: 'danger',
  flaky: 'warning',
  skipped: 'neutral',
  missing: 'warning',
  unknown: 'neutral',
};

export const COMPARISON_CHANGE_LABELS: Record<ComparisonChange, string> = {
  newly_failed: '新增失败',
  newly_passed: '由失败转通过',
  still_failed: '仍失败',
  still_passed: '仍通过',
  flaky: '偶发失败',
  became_flaky: '变为偶发失败',
  skipped: '跳过',
  new_item: '新增结果项',
  missing_item: '缺失结果项',
  unknown: '无法判定',
};

export const COMPARISON_CHANGE_TONES: Record<ComparisonChange, Tone> = {
  newly_failed: 'danger',
  newly_passed: 'success',
  still_failed: 'danger',
  still_passed: 'success',
  flaky: 'warning',
  became_flaky: 'warning',
  skipped: 'neutral',
  new_item: 'info',
  missing_item: 'warning',
  unknown: 'neutral',
};

export const VERDICT_LABELS: Record<string, string> = {
  regression: '回归（出现新增失败）',
  improvement: '改善（出现由失败转通过）',
  unchanged: '无变化',
  mixed: '混合（存在偶发失败）',
};

export const VERDICT_TONES: Record<string, Tone> = {
  regression: 'danger',
  improvement: 'success',
  unchanged: 'neutral',
  mixed: 'warning',
};

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  trace: 'Trace（官方追踪）',
  screenshot: '截图',
  video: '录屏',
  'json-report': '官方 JSON 报告',
  stdout: '标准输出日志',
  stderr: '标准错误日志',
  spec: '编译生成的规格文件',
  snapshot: '页面快照',
  console: '浏览器控制台日志',
  other: '其它产物',
};

export const BASELINE_SCOPE_LABELS: Record<BaselineScope, string> = {
  case: '用例',
  suite: '套件',
};

export const BASELINE_CREATOR_LABELS: Record<BaselineCreator, string> = {
  user: '用户',
  agent: 'Agent',
  system: '系统',
};

export const CASE_MODE_LABELS: Record<CaseMode, string> = {
  steps: '结构化步骤',
  code: '原始 Test 代码',
};

export const DATASET_SOURCE_LABELS: Record<DatasetSource, string> = {
  manual: '手工录入',
  json: 'JSON 导入',
  csv: 'CSV 导入',
};

export const ATTEMPT_STATUS_LABELS: Record<string, string> = {
  passed: '通过',
  failed: '失败',
  timedOut: '超时',
  skipped: '跳过',
  interrupted: '中断',
};

/** 合同 §10 的固定错误码 → 中文解释（错误信封自带 message 时优先展示 message） */
export const ERROR_CODE_LABELS: Record<string, string> = {
  INVALID_JSON: '请求体不是合法 JSON',
  INVALID_PATH: '路径参数非法',
  PATH_FORBIDDEN: '路径越出受控目录',
  CAPABILITY_DISABLED: '能力未启用或命令不在白名单',
  NOT_FOUND: '资源不存在或已删除',
  METHOD_NOT_ALLOWED: '接口不支持该请求方法',
  PAYLOAD_TOO_LARGE: '请求体超过 1 MiB 上限',
  UNSUPPORTED_MEDIA_TYPE: '请求内容类型不受支持',
  VERSION_CONFLICT: '版本冲突：该资源已被其他窗口修改',
  IDEMPOTENCY_CONFLICT: '幂等键冲突：同键请求体不同',
  BASELINE_SCOPE_MISMATCH: '仅通过的运行可设为基线',
  COMPARISON_SCOPE_MISMATCH: '基线与目标运行的归属不一致',
  SESSION_NOT_READY: 'MCP 会话尚未就绪',
  CONFIRM_REQUIRED: '该操作需要二次确认',
  VALIDATION_FAILED: '提交内容未通过校验',
  INVALID_STEP: '步骤配置不合法',
  UNKNOWN_COLUMN: '步骤引用了不存在的数据列',
  INVALID_DATASET: '数据集结构不合法',
  EMPTY_DATASET: '数据集所有行均已禁用，无法运行',
  ROW_LIMIT_EXCEEDED: '数据行超过 500 行上限',
  ROW_TOO_LARGE: '单元格内容超过 8192 字符',
  UNKNOWN_CASE: '套件引用了不存在的用例',
  RUN_NOT_TERMINAL: '运行结束后才能进行对比',
  TOO_MANY_RUNS: '排队运行过多，请稍后再试',
  TOO_MANY_MCP_SESSIONS: 'MCP 会话数超过上限（2）',
  NOT_IMPLEMENTED: '该能力尚未实现',
  SUBPROCESS_ERROR: '官方子进程启动或握手失败',
  ENGINE_ERROR: '执行引擎内部错误',
  TOOL_TIMEOUT: 'MCP 工具调用超时',
  RUN_TIMEOUT: '运行级超时',
  RUN_INTERRUPTED: '后端重启导致运行中断',
  INTERNAL_ERROR: '未分类的服务器内部错误',
  NETWORK_ERROR: '无法连接后端服务',
  TIMEOUT: '请求超时',
  CANCELLED: '请求已取消',
  INVALID_RESPONSE: '后端返回了非 JSON 响应',
  UNKNOWN_ERROR: '未知错误',
  NL_NOT_GENERATED: 'NL 尚未生成并接受，不能校验或运行',
  NL_GENERATION_CONFLICT: '该用例已有活跃的 NL 生成任务',
  NL_RULE_FALLBACK_DISABLED: '规则兜底解析未启用',
  NL_SUBMIT_INVALID: '生成结果未通过服务端校验',
  NL_STALE: 'NL 文本已修改，生成结果已过期',
  HARNESS_NOT_SUPPORTED: '仅支持 claude/codex/deepseek 三个 harness 入口',
};

export function errorCodeLabel(code: string): string {
  return ERROR_CODE_LABELS[code] ?? code;
}

/** 回归结论来源声明（api-contract §6.2 要求回显 verdictBasis=computed） */
export const VERDICT_BASIS_NOTE = '结论依据：胶水层计算（基于官方 JSON 报告逐项结果归一化，非官方输出）';

/** 运行汇总的通过率说明（PRD R4.3 要求标注为胶水层计算） */
export const PASS_RATE_NOTE = '行级通过率由框架按 enabled 行数与官方结果统计，属胶水层计算';

export function agentLoopLabel(loop: string): string {
  const labels: Record<string, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    copilot: 'GitHub Copilot（VS Code）',
    opencode: 'OpenCode',
    vscode: 'VS Code',
    'vscode-legacy': 'VS Code（legacy）',
  };
  return labels[loop] ?? loop;
}

/** 失败原因分类（PRD R3.5；由后端胶水层推断，UI 必须标注"推断"） */
export const FAILURE_CATEGORY_LABELS: Record<FailureCategory, string> = {
  locator_not_found: '元素未找到',
  timeout: '超时',
  assertion_mismatch: '断言不匹配',
  navigation_error: '导航错误',
  network_error: '网络错误',
  data_error: '数据问题',
  environment_error: '环境问题',
  unknown: '无法归因',
};

/** 兼容旧命名（历史调用点）；新代码优先用 FAILURE_CATEGORY_LABELS */
export const ATTRIBUTION_CATEGORY_LABELS = FAILURE_CATEGORY_LABELS;

export function failureCategoryLabel(category: string | null | undefined): string {
  if (!category) return '无失败分类';
  return FAILURE_CATEGORY_LABELS[category as FailureCategory] ?? category;
}

export const ATTRIBUTION_CONFIDENCE_LABELS: Record<string, string> = {
  low: '低置信度',
  medium: '中等置信度',
  high: '高置信度',
};

export const ATTRIBUTION_DISCLAIMER = '失败归因由框架按规则推断，非官方结论；请结合 trace / 截图 / 官方错误定位自行确认。';

// ── NL-first（§12）与三 harness（§13）────────────────────────────────────
export const NL_STATUS_LABELS: Record<NlStatus, string> = {
  draft: '草稿（尚未生成）',
  generating: '生成中',
  generated: '已生成（可运行）',
  stale: '文本已修改（需重新生成）',
  invalid: '生成结果无效',
};

export const NL_STATUS_TONES: Record<NlStatus, Tone> = {
  draft: 'neutral',
  generating: 'info',
  generated: 'success',
  stale: 'warning',
  invalid: 'danger',
};

export const NL_GENERATION_STATUS_LABELS: Record<NlGenerationStatus, string> = {
  queued: '排队中（等待外部 agent）',
  running: '生成中',
  ready: '待验收',
  accepted: '已接受',
  rejected: '已拒绝',
  failed: '失败',
  cancelled: '已取消',
};

export const NL_GENERATION_STATUS_TONES: Record<NlGenerationStatus, Tone> = {
  queued: 'neutral',
  running: 'info',
  ready: 'success',
  accepted: 'success',
  rejected: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
};

export const NL_WARNING_CODE_LABELS: Record<NlWarningCode, string> = {
  NL_LINE_UNMAPPED: '该行未能映射为步骤',
  NL_TARGET_AMBIGUOUS: '目标定位不唯一',
  NL_UNSUPPORTED_ACTION: '不支持的动作',
  NL_NO_ASSERTION: '缺少断言',
};

export const NL_LINE_KIND_LABELS: Record<string, string> = {
  blank: '空行',
  comment: '注释',
  instruction: '指令',
  step: '步骤',
  unmapped: '未映射',
};

export const AGENT_ENTRY_LABELS: Record<AgentEntry, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  deepseek: 'DeepSeek Harness',
};

export function agentEntryLabel(entry: string): string {
  return AGENT_ENTRY_LABELS[entry as AgentEntry] ?? entry;
}

export const HARNESS_SCOPE_LABELS: Record<string, string> = {
  project: '项目级',
  user: '用户级',
  shared: '共享级',
};

/** NL 生成按钮下方的固定说明（不内置模型；生成由外部 coding agent/skill 完成） */
export const NL_EXTERNAL_AGENT_NOTE =
  '生成由外部 coding agent（Claude Code / Codex / DeepSeek Harness）按 skills/pw-auto-test 执行；本框架不内置模型、不伪造生成结果。';

/** 将未知值兜底为中文标签 */
export function labelOf(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return '—';
  return map[key] ?? key;
}