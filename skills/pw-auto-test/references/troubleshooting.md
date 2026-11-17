# 故障排查（只读诊断优先）

> 原则：先读 health/meta/diagnostics/items/artifacts，再改输入；不要靠猜、不要伪造成功。
> 所有命令默认 `API=http://127.0.0.1:8787`；脚本路径相对于本 skill 根目录。

## 1. 框架不可达

| 现象 | 检查 | 处理 |
|---|---|---|
| `NETWORK_ERROR`/`ECONNREFUSED` | 框架是否启动；端口是否一致 | `node apps/api/src/main.ts`；`PW_PORT` 与 `PW_API_BASE` 对齐；`curl $API/api/health` |
| `health.status != ok` | `data.db` | DB 不可用；看 API 日志；重启服务 |
| 401/403 不该出现（本机无鉴权） | 是否误连公网/代理 | 只连 `127.0.0.1`/`localhost`；不要对外暴露 |

## 2. 版本/环境

`GET /api/v1/meta`：

```jsonc
{ "versions": { "playwright": "1.65.0", "playwrightSource": "cli|fallback",
                "playwrightCliPath": "…/cli.js", "playwrightVersionError": "仅 fallback" } }
```

- `playwrightSource` 必须为 `cli`；`fallback` 表示 `node <cli.js> --version` 非零/超时/信号/spawn 失败/输出不匹配，
  `playwright` 只是冻结常量，**不得**当作真实探测结论。修复依赖后重启框架。
- `playwrightVersionError` 非空时先解决它，再跑 NL/生成/运行。

## 3. 生成任务相关

| code | 原因 | 处理 |
|---|---|---|
| `409 NL_GENERATION_CONFLICT` | 同用例已有 queued/running/ready 任务；或 claim 非 queued；或 lease 失效 | 等待/accept/reject；或创建时 `force:true`；lease 失效则重新 claim |
| `409 NL_STALE` | 生成后 NL 文本被改 | 重新生成；只有确认接受旧结果才 `force:true` |
| `422 NL_NOT_GENERATED` | NL 状态 draft/generating/invalid；validate/run 门禁 | 完成 submit+accept；或 `allowStaleNl`（stale 时） |
| `422 NL_SUBMIT_INVALID` | steps 不合 17 动作 schema、列不存在、stepOrigin 缺失/越界、空结果 | 按 `details[].path` 修；重新 claim+submit |
| `403 NL_RULE_FALLBACK_DISABLED` | `generator:"rule"` 默认关闭 | 用 `generator:"agent"`；或管理员显式开启规则兜底 |
| `NL_GENERATION_TIMEOUT` | 排队/租约重试超限 | 重新创建任务；检查 harness 是否及时 claim/submit |
| `HARNESS_NOT_SUPPORTED` | 旧 loop/未知 entry | 只支持 claude/codex/deepseek |

轮询：`GET /api/v1/cases/{caseId}/nl/generations/{id}`；终态 `ready|accepted|rejected|failed|cancelled`。租约默认 120s。

## 4. MCP / CLI

- `403 CAPABILITY_DISABLED`：工具/命令不在白名单，或 unsafe 工具未开 `PW_ENABLE_UNSAFE_TOOLS` + `confirm`。
  **本 skill 不使用 unsafe**；只走 `browser_navigate/snapshot/find/verify_*` 等 28 个白名单工具。
  注意：MCP/CLI 未授权统一为 `403 CAPABILITY_DISABLED`（无其他状态码）。
- MCP 会话上限 2（`TOO_MANY_MCP_SESSIONS`）：关闭不用的会话 `DELETE /mcp/sessions/{id}`。
- `TOOL_TIMEOUT`：缩小 snapshot 深度或减少探索；重试一次；仍失败则报告框架 API 不可用。
- MCP 启动失败：`502 SUBPROCESS_ERROR`；不要伪造工具清单，按官方 `playwright mcp --help` 自检。
- CLI 仅用于‘动作回放/取证’，不能用于生成测试；`install/install-browser/attach/config-print` 永久拒绝；
  `run-code/eval` 需安全开关+confirm，本 skill 不使用。

## 5. 运行/报告

| 现象 | 检查 |
|---|---|
| run 长期 `queued/running` | `GET /runs/{id}` 的 `queuePosition`；并发上限；`cancel` 后重试 |
| `RUN_TIMEOUT` | 用例超时/运行超时；减少步骤或调大 `options.timeoutMs`（API 上限 3600000） |
| `status=error` | `diagnostics.command/specPath/reportPath/workspaceDir/warnings`；错误码：`ENGINE_ERROR/SUBPROCESS_ERROR/NOT_IMPLEMENTED` |
| `status=failed` | 先看 `stats.unexpected` 与 items；失败 item 的 `attempts[0].errorHash` 用于比较是否同错 |
| API 报错文字含 ANSI | 官方 reporter 原样保留颜色；展示时自行 strip `\u001b\[[0-?]*[ -/]*[@-~]`，比较用 `errorHash` |
| 产物下载 404 | 只用 `artifacts` 列表里的 id；内容端点只读已登记产物 |
| `[row:N]`/itemKey 不符 | `diagnostics.warnings` 是否含 `[row:N]` 改写；数据集是否在生成后被替换（rowIndex 快照） |

## 6. 编码与平台

- 所有 JSON 用 UTF-8；PowerShell 5.1 直接读 UTF-8 中文会乱码，交给 Node `JSON.parse` 或 `node scripts/api.mjs`。
- Windows 路径不要作为 CLI 位置参数（官方 CLI 会按目标/正则解析）；文件使用相对 workDir 的路径。
- 本 skill 不修改 harness 的文件；`verify.mjs` 只读，`agent-loop.mjs` 只清理自己创建的用例（`--keep` 可保留）。

## 7. 快速自检

```bash
node scripts/verify.mjs --api-base=http://127.0.0.1:8787
node scripts/agent-loop.mjs --scenario=full --base-url=http://127.0.0.1:4174/
```

- `verify` 失败项会逐条列出；`--allow-fallback` 仅用于临时诊断，不能证明版本真实。
- `agent-loop` 预检要求 `playwrightSource=cli` 且 3 harness 齐全；失败会打印原因并以 2 退出。
- 需要真实被测页面：`node tests/e2e/fixtures/server.mjs --port 4174`（仓库内离线 fixture），或传 `--base-url` 指向你的站点。