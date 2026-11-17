---
name: pw-auto-test
description: 通过本机 pw-auto-framework API 用自然语言驱动 Playwright 测试：预检→NL 用例→生成任务→官方 planner/generator/healer→submit/accept→validate→run→逐行与产物报告。Use when the user wants to create, run, or repair Playwright tests in a local pw-auto-framework workspace.
version: 1.0.0
playwrightVersion: 1.65.0
entrypoints: [claude, codex, deepseek]
requiresMcp: false
---

# pw-auto-test · 自然语言驱动 Playwright 测试

本 skill 是**外部 coding agent 的驱动程序**：模型由你所在 harness 提供，框架本身**不内置 LLM、不调用任何模型端点**。
你只通过本机 `pw-auto-framework` HTTP API 操作（默认 `http://127.0.0.1:8787`，`PW_API_BASE` 可改）；不直连浏览器、不直接运行
`playwright test`、不修改 harness 的 MCP 配置。MCP 浏览器由框架托管，你只调用框架的 MCP 会话 API。

- 框架版本钉住：`@playwright/test@1.65.0`；`GET /api/v1/meta` 的 `versions.playwrightSource` 必须为 `cli`（否则先报错，不要假装已校验版本）。
- 官方能力边界：Test / MCP / CLI / Agents 都只在框架内使用；本 skill **不**伪造官方 loop，`deepseek` 的 `officialLoop` 为 `null`。
- 无鉴权、仅本机：仅连接 `127.0.0.1`/`localhost`，不要把框架暴露到公网，不要在 skill 里保存任何密钥。

## 0. 先放置（用户手动，框架不安装）

同一份目录可放到任一 harness 的 skills 根目录（推荐路径如下；无需 MCP 配置，`requiresMcp: false`）：

| entry | harness | 推荐放置路径（复制整个 `pw-auto-test/` 目录） | officialLoop |
|---|---|---|---|
| `claude` | Claude Code | `<repo>/.claude/skills/pw-auto-test/` 或 `~/.claude/skills/pw-auto-test/` | `claude` |
| `codex` | Codex CLI | `~/.codex/skills/pw-auto-test/` 或 `<repo>/.codex/skills/pw-auto-test/`（共享 `~/.agents/skills/pw-auto-test/`） | `codex` |
| `deepseek` | DeepSeek Harness | `~/.dsh/skills/pw-auto-test/` 或 `<repo>/.agents/skills/pw-auto-test/` | `null`（官方无 deepseek loop，不伪造） |

`GET /api/v1/agents/harnesses` 只读返回上述 `skillPaths`；框架不复制、不记录“是否已安装”。放置后重开 harness 会话，
或运行只读自检：`node scripts/verify.mjs`。详见 `references/harness-matrix.md`。

## 1. 输入与输出

**输入**：用户的一句/多行自然语言用例（可含 `{{列}}` 变量），可选数据集（手工行 / JSON / CSV），以及被测页面 URL。
**输出**：可执行的官方 Playwright Test 步骤 + `stepOrigin`（步骤→NL 行号）+ 真实运行结果 + 逐行/产物/回归证据 + 中文摘要。
NL 是**生成输入**，不是第三种 `mode`：`POST /cases` 仍创建 `steps|code` 用例，NL 通过 `nl` 字段或 `PUT …/nl` 附加；
只有 `accept` 才把生成的 steps 写入用例。

## 2. 全自动编排（默认无需人工；`--review` 在 accept 前停）

按顺序执行；每一步失败都要**显式报告**（错误码 + 中文原因 + 已产生的 id），不得跳过或伪造成功。

1. **预检**：`GET /api/health` → `GET /api/v1/meta`（`playwrightSource === "cli"`）→ `GET /api/v1/agents/harnesses`（恰 3 项）。
2. **创建/更新 NL 用例**：`POST /api/v1/cases`（`mode:"steps"`, `steps:[]`, `nl:{text}`）或对已有用例 `PUT /api/v1/cases/{caseId}/nl`。
   注意：`PATCH /cases/{id}` 不接受 `nl`；NL 只能走 `/nl` 专用端点。
3. **数据集（可选）**：`POST /api/v1/cases/{caseId}/datasets`（`source:"manual|json|csv"`, `rows`）→ 读取返回的 `columns`。
   `{{列名}}` 必须在列中存在；列不存在会在编译/提交阶段得到 `UNKNOWN_COLUMN`/`NL_SUBMIT_INVALID`。
4. **创建生成任务**：`POST /api/v1/cases/{caseId}/nl/generations`，`{generator:"agent", hints?, force?}` → `202` + `NlGeneration`（`status=queued`）。
   同用例已有活跃任务会 `409 NL_GENERATION_CONFLICT`；确需重来用 `force:true`（取消旧任务）。
5. **领取**：`GET /api/v1/nl/generations?status=queued` → `POST /api/v1/nl/generations/{id}/claim {leaseSeconds}` → 使用返回的 `leaseId`。
   租约默认 120s，超时可重新 claim（同一任务最多 3 次）。
6. **探索（可选但推荐）**：创建框架 MCP 会话 `POST /api/v1/mcp/sessions`（默认 caps `testing,storage,network`，headless）→ 只用
   **28 个官方白名单工具**（`browser_navigate`/`browser_snapshot`/`browser_find`/`browser_click`/`browser_verify_*` 等）→ 关闭会话。
   **禁止** `browser_run_code_unsafe`、`browser_evaluate`、任何 `*_xy`/mouse unsafe 工具（需 `PW_ENABLE_UNSAFE_TOOLS=1` + `confirm`，本 skill 一律不用）。
7. **生成 steps（模型由 harness 提供）**：按 `references/agent-handoff.md` 使用官方模板：
   `templates/plan.md`（planner）→ `templates/generate.md`（generator）→ `templates/heal.md`（healer）；覆盖度用 `templates/coverage.md`。
   页面事实只来自框架 MCP 的 snapshot/console/network 结果；定位器只使用官方 locator（优先 role/testId/label/placeholder/text），
   **不要**写 sleep、不要自造断言。每个结构化步骤必须映射到 NL 行号（1 基）→ `stepOrigin`。
8. **提交**：`POST /api/v1/nl/generations/{id}/submit`，请求必须含：
   `leaseId`、`generatorVersion:"pw-auto-test/1.0.0"`、`steps`（可含 `{{列}}`）、`stepOrigin`、可选 `datasetId`；`warnings` 可为空数组。
   `422 NL_SUBMIT_INVALID` 表示 steps schema/列/行号不合法；`409` 表示租约失效，重新 claim。
9. **接受**：默认自动 `POST /api/v1/cases/{caseId}/nl/generations/{id}/accept {force:false}`；只有 ready 可接受。
   NL 文本在生成后改过会 `409 NL_STALE`：先确认是否接受旧结果，确需接受才 `force:true`。`--review` 时打印 caseId/generationId 后停，等人工确认。
10. **校验与运行**：`POST /api/v1/cases/{caseId}/validate {datasetId?}` → `POST /api/v1/runs`
    （`target:{kind:"case",caseId}`, `datasetId?`, `options:{allowStaleNl:false}`）→ 轮询 `GET /api/v1/runs/{runId}` 到终态。
11. **结果与报告**：`GET /api/v1/runs/{runId}/items`、`GET /api/v1/runs/{runId}/artifacts`；按 `references/data-driven.md` 输出逐行报告。
12. **失败修复**：读取失败 item 的 `attempts[].errorHash`、`error`、`artifacts`（trace/screenshot）→ 用 healer 模板诊断 →
    `POST …/nl/generations {generator:"agent", force:true}` 重走 5–11；只有新 run 通过后才能说已修复。

## 3. API 速查（完整样例见 references/api-cheatsheet.md）

```bash
API=${PW_API_BASE:-http://127.0.0.1:8787}

curl -s $API/api/health
curl -s $API/api/v1/meta
curl -s $API/api/v1/agents/harnesses

# NL 用例
CASE=$(curl -s -X POST $API/api/v1/cases -H 'content-type: application/json' \
  -d '{"name":"登录冒烟","mode":"steps","steps":[],"nl":{"text":"打开 https://example.com/\n页面上应该出现「Example Domain」"}}')
CASE_ID=$(echo "$CASE" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.id")

# 触发生成 → 领取
GEN=$(curl -s -X POST $API/api/v1/cases/$CASE_ID/nl/generations -H 'content-type: application/json' -d '{"generator":"agent"}')
GEN_ID=$(echo "$GEN" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.id")
curl -s -X POST $API/api/v1/nl/generations/$GEN_ID/claim -H 'content-type: application/json' -d '{"leaseSeconds":120}'
```

> 直接调用可用 `node scripts/api.mjs GET /api/v1/meta`；脚本会把成功信封解包为 `data`。

## 4. 数据驱动（`{{列}}`）

- 数据集创建后返回 `columns`；生成任务的 `datasetColumns` 是创建时快照。提交时传入 `datasetId` 会按该数据集列做真实校验。
- NL 文本与生成的 steps 都**保留** `{{列}}`；不要在 skill 里替换成某一行的字面值。
- 带 `datasetId` 运行；结果每个数据行一个 item：`itemKey = caseId#row:N`、`title` 含 `[row:N]`。
- 报告必须逐行输出 `rowIndex/itemKey/outcome/durationMs/errorHash`，并汇总 `stats.expected/unexpected/flaky/skipped`。
- 全行 disabled → `422 EMPTY_DATASET`；列不存在 → `UNKNOWN_COLUMN`；单元格超长 → `ROW_TOO_LARGE`。

## 5. 三 harness 交接

同一份静态目录，无安装器、无 manifest、无安装 API。放置后：

- **Claude Code**：skill 出现在 `.claude/skills/` catalog；项目内可直接读取 `SKILL.md`。
- **Codex**：按 codex 的 skills 发现路径放置（`~/.codex/skills` 或项目 `.codex/skills`/`~/.agents/skills`）。
- **DeepSeek Harness**：`~/.dsh/skills/` 或 `<repo>/.agents/skills/`；`officialLoop:null`，能力来自官方四模板 + 本 skill + 项目 README。
- 三者都 `requiresMcp:false`：**不要**给 harness 配 `playwright mcp`；需要浏览器事实时调用框架的 `/mcp/sessions`。

详细矩阵/依据：`references/harness-matrix.md`。

## 6. 模式与参数

```bash
node scripts/verify.mjs                    # 只读：health/meta/harnesses + skill 文件 + 无安装 API
node scripts/agent-loop.mjs --scenario=full  # 确定性模拟 agent 跑通 NL→claim→submit→accept→validate→run
node scripts/agent-loop.mjs --scenario=data  # 2 行数据集 + 逐行报告
node scripts/agent-loop.mjs --scenario=all --base-url=http://127.0.0.1:4174/
node scripts/agent-loop.mjs --scenario=full --review   # 停在 accept 前，人工确认
```

- `--base-url`：被测页面；默认 `http://127.0.0.1:4174/`（可用 `tests/e2e/fixtures/server.mjs --port 4174` 启动）。
- `--api-base`：框架地址；默认 `$PW_API_BASE` 或 `http://127.0.0.1:8787`。
- `--review`：默认全自动；加此参数在 accept 前停，保留用例现场（不自动删除）。
- `--skip-mcp`：跳过框架 MCP 探索（仍走 NL→run 全链路）；正常验收不要跳过。
- `agent-loop.mjs` 是**确定性模拟**，不调用模型、不生成“聪明”步骤；它的 steps 只用于验证 skill/框架链路。

## 7. 失败与诊断（详见 references/troubleshooting.md）

| 现象 | 处理 |
|---|---|
| health 失败 | 框架未启动/端口不对；`PW_PORT` 与 `PW_API_BASE` 对齐 |
| `meta.playwrightSource=fallback` | 版本探测失败；看 `playwrightVersionError`，修复依赖后重启框架；不要声称已校验版本 |
| `409 NL_GENERATION_CONFLICT` | 已有活跃任务；等待/accept/reject，或 `force:true` |
| `409 NL_STALE` | NL 文本已改；重新生成，或明确接受旧结果才 `force:true` |
| `422 NL_SUBMIT_INVALID` | steps schema/列/`stepOrigin` 行号不合法；按 details 修正后重新 submit |
| `422 NL_NOT_GENERATED` | NL 还是 draft/generating/invalid；先完成 accept |
| `403 CAPABILITY_DISABLED`（MCP/CLI） | 工具/命令不在白名单或 unsafe 未开；本 skill 不使用 unsafe |
| run `error`/`failed` | 看 `diagnostics.command/reportPath`、items 的 `errorHash`、artifacts（trace）；按 healer 修复 |
| 中文 JSON 乱码 | 一律用 UTF-8 解析（Node `JSON.parse`），不要在 PowerShell 里手工拼接中文 |

## 8. 硬性边界（不可协商）

- 不调用模型端点、不在脚本/模板里放 API Key/Token/Cookie。
- 不直连浏览器、不直接运行 `playwright test`、不修改 harness 的 MCP 配置文件；浏览器只由框架 MCP 子进程托管。
- 不伪造 `deepseek` 官方 loop；不声称框架内置 AI/自动修复；只有真实 run 通过才算修复。
- 只使用已文档化官方能力与框架 API；unsafe 工具（run-code/evaluate/视觉坐标）一律拒绝。
- 统一用中文摘要；引用版本以 `GET /api/v1/meta` 为准（`@playwright/test@1.65.0`）。

## 9. 参考文件

- `references/nl-to-case.md`：NL 书写规则/动词映射/告警码
- `references/api-cheatsheet.md`：端点、请求体、错误码
- `references/data-driven.md`：数据集、逐行报告
- `references/agent-handoff.md`：planner/generator/healer 与官方模板来源
- `references/harness-matrix.md`：三 harness 放置与边界
- `references/troubleshooting.md`：常见错误与离线诊断
- `templates/`：官方 `--prompts` 同构模板（带来源注释）