# API 速查（pw-auto-framework v1）

- Base：`http://127.0.0.1:8787`（`PW_PORT`/`PW_API_BASE` 可改）；仅本机、无鉴权，**不要**暴露公网。
- 成功信封：`{ "data": ... }`；分页：`{ "data": { "items": [], "nextCursor": null, "hasMore": false } }`。
- 错误信封：`{ "error": { "code": "NL_STALE", "message": "中文", "details": [...], "requestId": "..." } }`。
- 所有请求 `content-type: application/json`；UTF-8。
- 时间 UTC ISO-8601；`itemKey`：无数据集=`caseId`，有数据集=`caseId#row:N`。

## 1. 预检

```bash
curl -s $API/api/health
curl -s $API/api/v1/meta
curl -s $API/api/v1/agents/harnesses
```

`meta.versions` 关键字段：`playwright`（1.65.0）、`playwrightSource`（必须 `cli`）、`playwrightVersionError`（fallback 时非空）、`playwrightCliPath`。
`harnesses.items[]` 恰 3 项：`entry/label/officialLoop/requiresMcp/skillPaths/notes`；deepseek 的 `officialLoop` 为 `null`，全部 `requiresMcp:false`。

## 2. 用例与 NL

| 方法/路径 | 说明 |
|---|---|
| `POST /api/v1/cases` | `{name, description?, mode:"steps", steps:[], tags?, nl?:{text}}` → `201 Case` |
| `GET /api/v1/cases/{caseId}` | 返回完整 `Case`（含可选 `nl`/`stepOrigin`） |
| `PATCH /api/v1/cases/{caseId}` | 只改 name/description/mode/steps/code/tags/status；**不接受 nl/stepOrigin** |
| `GET /api/v1/cases/{caseId}/nl` | `200 NlSource` 或 `404` |
| `PUT /api/v1/cases/{caseId}/nl` | `{text}`；已有 accepted 生成 → `status:"stale"` |
| `DELETE /api/v1/cases/{caseId}/nl` | `204`（移除 nl/stepOrigin，保留 steps） |
| `POST /api/v1/cases/{caseId}/validate` | `{datasetId?}` → `{ok,stepsCount,rowsCount,warnings[]}`；不执行 |
| `GET /api/v1/cases/{caseId}/spec?preview=1` | 只读编译预览（必须 `preview=1`） |

```bash
# 创建 NL 用例
CASE=$(curl -s -X POST $API/api/v1/cases -H 'content-type: application/json' -d '{
  "name":"登录冒烟","mode":"steps","steps":[],"tags":["@smoke"],
  "nl":{"text":"打开 https://example.com/\n页面上应该出现「Example Domain」"}
}')
CASE_ID=$(echo "$CASE" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.id")

# 已有用例：只更新 NL
curl -s -X PUT $API/api/v1/cases/$CASE_ID/nl -H 'content-type: application/json' \
  -d '{"text":"打开 https://example.com/\n页面上应该看到标题「Example Domain」"}'
```

`NlSource`：`text/status(draft|generating|generated|stale|invalid)/sourceHash(16hex)/origin(agent|rule|null)/
generatorVersion/warnings[]/lines[]/updatedAt/generatedAt`。

## 3. 生成任务（7 态）

| 方法/路径 | 说明 |
|---|---|
| `POST /api/v1/cases/{caseId}/nl/generations` | `{generator:"agent",hints?,force?}` → `202` queued |
| `GET /api/v1/cases/{caseId}/nl/generations` | 按用例列任务（分页） |
| `GET /api/v1/cases/{caseId}/nl/generations/{id}` | 单任务 |
| `GET /api/v1/nl/generations?status=queued` | harness 队列（含 `caseName/nlText/datasetColumns/hints`） |
| `POST /api/v1/nl/generations/{id}/claim` | `{leaseSeconds?}` → `running + leaseId` |
| `POST /api/v1/nl/generations/{id}/submit` | `{leaseId,steps?,code?,warnings?,generatorVersion,stepOrigin?,datasetId?}` → ready |
| `POST /api/v1/cases/{c}/nl/generations/{id}/accept` | `{force?}` → `{case,generation}`；stale 需 force |
| `POST /api/v1/cases/{c}/nl/generations/{id}/reject` | `{reason}` |
| `POST /api/v1/cases/{c}/nl/generations/{id}/cancel` | 仅 queued/running |

```bash
GEN=$(curl -s -X POST $API/api/v1/cases/$CASE_ID/nl/generations -H 'content-type: application/json' \
  -d '{"generator":"agent","hints":{"skill":"pw-auto-test/1.0.0"}}')
GEN_ID=$(echo "$GEN" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.id")

# harness 领取
CLAIM=$(curl -s -X POST $API/api/v1/nl/generations/$GEN_ID/claim -H 'content-type: application/json' -d '{"leaseSeconds":120}')
LEASE=$(echo "$CLAIM" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.leaseId")

# 提交（steps + stepOrigin；数据驱动再加 datasetId）
curl -s -X POST $API/api/v1/nl/generations/$GEN_ID/submit -H 'content-type: application/json' -d "{
  \"leaseId\":\"$LEASE\",\"generatorVersion\":\"pw-auto-test/1.0.0\",
  \"steps\":[{\"id\":\"s1\",\"action\":\"goto\",\"url\":\"https://example.com/\"},
             {\"id\":\"s2\",\"action\":\"expectTitle\",\"value\":\"Example Domain\"}],
  \"stepOrigin\":{\"s1\":{\"nlLine\":1},\"s2\":{\"nlLine\":2}},
  \"warnings\":[]
}"

# 接受（唯一写 steps 的路径）
curl -s -X POST $API/api/v1/cases/$CASE_ID/nl/generations/$GEN_ID/accept \
  -H 'content-type: application/json' -d '{"force":false}'
```

- `202` 创建、`409 NL_GENERATION_CONFLICT` 已有活跃任务、`403 NL_RULE_FALLBACK_DISABLED`（规则兜底默认关）。
- claim 租约默认 120s；超时可重新 claim（最多 3 次，之后 `NL_GENERATION_TIMEOUT`）。
- `422 NL_SUBMIT_INVALID`：steps/列/stepOrigin 不合法；`409 NL_STALE`：NL 文本已改。
- `422 NL_NOT_GENERATED`：NL 未生成（validate/run 门禁）；`allowStaleNl:true` 可放行 stale（不推荐）。

## 4. 数据集与运行

| 方法/路径 | 说明 |
|---|---|
| `POST /api/v1/cases/{caseId}/datasets` | `{name,source:"manual|json|csv",rows:[{data,enabled?}]}` |
| `GET /api/v1/datasets/{id}` | 含 `columns/rowsCount/enabledRowsCount` |
| `GET /api/v1/datasets/{id}/rows` | 分页行（`rowIndex/data/enabled`） |
| `PUT /api/v1/datasets/{id}/rows` | 全量替换行 |
| `POST /api/v1/runs` | `{target:{kind:"case",caseId},datasetId?,options?,reason?}` |
| `GET /api/v1/runs/{runId}` | 轮询到 `passed|failed|cancelled|error` |
| `GET /api/v1/runs/{runId}/items` | 逐项结果（`itemKey/rowIndex/outcome/attempts[]`） |
| `GET /api/v1/runs/{runId}/artifacts` | 产物索引（trace/screenshot/video/json-report/…） |
| `GET /api/v1/runs/{runId}/artifacts/{artifactId}/content` | 下载（支持 Range） |

```bash
RUN=$(curl -s -X POST $API/api/v1/runs -H 'content-type: application/json' \
  -d "{\"target\":{\"kind\":\"case\",\"caseId\":\"$CASE_ID\"},\"reason\":\"skill\"}")
RUN_ID=$(echo "$RUN" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.id")
# 轮询 GET /api/v1/runs/$RUN_ID 直到终态；再取 items/artifacts
```

`Run` 关键字段：`status/stats{expected,unexpected,flaky,skipped,durationMs}/exitCode/environment/
diagnostics{command[],specPath,reportPath,workspaceDir,warnings[]}`。

## 5. 框架托管的 MCP（浏览器探索）

```bash
S=$(curl -s -X POST $API/api/v1/mcp/sessions -H 'content-type: application/json' \
  -d '{"caps":["testing","storage","network"],"headless":true,"isolated":true}')
SID=$(echo "$S" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.id")

curl -s -X POST $API/api/v1/mcp/sessions/$SID/calls -H 'content-type: application/json' \
  -d '{"tool":"browser_navigate","arguments":{"url":"https://example.com/"}}'
curl -s -X POST $API/api/v1/mcp/sessions/$SID/calls -H 'content-type: application/json' \
  -d '{"tool":"browser_snapshot","arguments":{}}'
curl -s -X DELETE $API/api/v1/mcp/sessions/$SID
```

- 只允许 **28 个合同白名单工具**；未知/未白名单 → `403 CAPABILITY_DISABLED`。
- unsafe 精确集合（8 个：`browser_run_code_unsafe`、`browser_evaluate`、`browser_mouse_*` down/up/wheel 等）需
  `PW_ENABLE_UNSAFE_TOOLS=1` + `confirm:true`；**本 skill 不使用**。
- 不修改 harness 的 MCP 配置；浏览器由框架子进程托管。

## 6. 常见错误码

| code | HTTP | 说明 |
|---|---|---|
| `NOT_FOUND` | 404 | 资源不存在/已删除 |
| `VALIDATION_FAILED` | 422 | zod 校验失败（看 `details[].path`） |
| `INVALID_STEP` / `UNKNOWN_COLUMN` | 422 | 步骤非法 / 变量列不存在 |
| `EMPTY_DATASET` | 422 | 数据集无启用行 |
| `NL_NOT_GENERATED` | 422 | NL 未生成（draft/generating/invalid） |
| `NL_STALE` | 409 | NL 文本已改，生成结果过期 |
| `NL_GENERATION_CONFLICT` | 409 | 已有活跃任务/租约失效/状态不允许 |
| `NL_GENERATION_TIMEOUT` | 500 | 生成任务排队/租约重试超限 |
| `NL_SUBMIT_INVALID` | 422 | 提交的 steps/列/stepOrigin 非法 |
| `NL_RULE_FALLBACK_DISABLED` | 403 | 规则兜底默认关闭 |
| `HARNESS_NOT_SUPPORTED` | 422 | 旧 loop/未知 entry（只接 claude/codex/deepseek） |
| `CAPABILITY_DISABLED` | 403 | MCP/CLI 白名单、unsafe 未开启 |
| `CONFIRM_REQUIRED` | 428 | 危险操作缺 confirm |
| `RUN_TIMEOUT` / `ENGINE_ERROR` | 500 | 执行超时/引擎失败（看 diagnostics） |

## 7. Node 客户端用法

```js
import { PwAutoApi } from './scripts/api.mjs';
const api = new PwAutoApi({ baseUrl: process.env.PW_API_BASE });
const meta = await api.meta();
const created = await api.createCase({ name: 'demo', mode: 'steps', steps: [], nl: { text: '打开 https://example.com/' } });
const gen = await api.createGeneration(created.id, { generator: 'agent' });
const claimed = await api.claimGeneration(gen.id, 120);
await api.submitGeneration(gen.id, { leaseId: claimed.leaseId, generatorVersion: 'pw-auto-test/1.0.0', steps: [...], stepOrigin: {...} });
await api.acceptGeneration(created.id, gen.id);
const validated = await api.validateCase(created.id);
const run = await api.createRun({ target: { kind: 'case', caseId: created.id } });
const done = await api.waitForRun(run.id);
```

## 8. 官方依据

- CLI/Test：`https://playwright.dev/docs/test-cli`
- MCP：`https://playwright.dev/mcp`
- Agents：`https://playwright.dev/docs/test-agents`
- 本框架接口：以项目根 `README.md` 的 NL/API 摘要与本文为准（`docs/` 按要求仅保留用户指南）。
