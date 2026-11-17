# 数据驱动测试（数据集、`{{列}}`、逐行结果）

> 官方 Playwright 没有 `test.each`；框架用官方 `forEach` 模式：**一行数据 = 一个独立 `test()`**。
> 逐行结果来自官方 JSON 报告，`itemKey = caseId#row:N`，标题包含 `[row:N]`。

## 1. 建数据集

```bash
# manual（UI/agent 逐行）
DS=$(curl -s -X POST $API/api/v1/cases/$CASE_ID/datasets -H 'content-type: application/json' -d '{
  "name":"两行问候",
  "source":"manual",
  "rows":[
    {"data":{"名字":"自动化"}},
    {"data":{"名字":"张三"}}
  ]
}')
DS_ID=$(echo "$DS" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.id")
```

- `source` 可选 `manual|json|csv`；`json`/`csv` 的解析由 API 完成，最终仍存成行。
- 每行 `data` 的值只允许 `string|number|boolean|null`；字符串单元格 ≤ 8192 字符。
- 行数 ≤ 500、列数 ≤ 50；`enabled:false` 的行不执行。
- 响应字段：`columns[]`（服务端从行推导）、`rowsCount`、`enabledRowsCount`。
- 全行 disabled：`422 EMPTY_DATASET`；重复/空表头：`422 INVALID_DATASET`。

## 2. NL 与 `{{列}}`

```text
# 两行问候
打开 http://127.0.0.1:4174/?name={{名字}}
页面上应该出现「你好，{{名字}}」
```

- 生成后的 `steps` **保留** `{{列}}`；不要替换成某行字面值。
- 生成任务的 `datasetColumns` 是创建任务时的快照（默认数据集列）；submit 时传 `datasetId` 会按该数据集列做真实校验。
- 列不存在 → `UNKNOWN_COLUMN`（编译）或 `422 NL_SUBMIT_INVALID`（提交）。

## 3. 提交与接受

```bash
# 1) 先在用例下创建数据集（见上）
# 2) 创建生成任务（快照 datasetColumns）
# 3) claim 后 submit 带 datasetId
curl -s -X POST $API/api/v1/nl/generations/$GEN_ID/submit -H 'content-type: application/json' -d "{
  \"leaseId\":\"$LEASE\",\"generatorVersion\":\"pw-auto-test/1.0.0\",
  \"steps\":[
    {\"id\":\"s1\",\"action\":\"goto\",\"url\":\"http://127.0.0.1:4174/?name={{名字}}\"},
    {\"id\":\"s2\",\"action\":\"expectText\",\"target\":{\"by\":\"testId\",\"testId\":\"hello\"},\"value\":\"你好，{{名字}}\"}
  ],
  \"stepOrigin\":{\"s1\":{\"nlLine\":2},\"s2\":{\"nlLine\":3}},
  \"warnings\":[],
  \"datasetId\":\"$DS_ID\"
}"
# 4) accept 后 validate 也带 datasetId
curl -s -X POST $API/api/v1/cases/$CASE_ID/validate -H 'content-type: application/json' -d "{\"datasetId\":\"$DS_ID\"}"
```

`validate` 语义：带 `datasetId` 时按**启用行 + 数据集列**真实编译；合法 → `200 ok:true` + `rowsCount`；
未知列 → `422 UNKNOWN_COLUMN`；全禁用 → `422 EMPTY_DATASET`。不带 `datasetId` 时含 `{{列}}` 会得到 `ok:false`（没有列可对照，属预期）。

## 4. 带数据集运行

```bash
RUN=$(curl -s -X POST $API/api/v1/runs -H 'content-type: application/json' -d "{
  \"target\":{\"kind\":\"case\",\"caseId\":\"$CASE_ID\"},
  \"datasetId\":\"$DS_ID\",
  \"options\":{\"retries\":0,\"trace\":\"retain-on-failure\",\"screenshot\":\"only-on-failure\"},
  \"reason\":\"skill data-driven\"
}")
```

运行终态后取 `GET /api/v1/runs/$RUN_ID/items`。逐行结果：

| 字段 | 说明 |
|---|---|
| `itemKey` | `caseId#row:N`（N 为数据集原始 `rowIndex`，跨运行稳定） |
| `rowIndex` | 数据行号（0 基）；NL 行号在 `stepOrigin`/详情里回标 |
| `title` | 官方 test 标题，结尾含 `[row:N]` |
| `outcome` | `expected/unexpected/flaky/skipped`（官方 JSON 报告原值） |
| `attempts[]` | 每次尝试的状态/错误/`errorHash`/steps/attachments |
| 产物 | `kind=trace/screenshot`，含 `itemKey` 关联 |

## 5. 逐行报告（必须输出）

```text
行 | itemKey            | 状态      | 耗时   | 首错 fingerprint | 证据
0  | case_1#row:0       | expected  | 1.2s   | -                 | trace/screenshot
1  | case_1#row:1       | unexpected| 0.8s   | 3f2a…            | trace/screenshot
汇总：expected=1 unexpected=1 flaky=0 skipped=0
```

- 失败行要同时给 `errorHash` 与可点击/可下载的 trace/截图；不要把 ANSI 原文当摘要。
- `stats` 直接取自官方报告；不要自算通过率冒充官方结论。行级通过率若展示必须标注“胶水层计算”。

## 6. 边界与排查

- 变更数据集行会改变 `rowIndex` 映射；历史运行仍按当时的 `itemKey` 可读。
- `422 EMPTY_DATASET`：确认有 `enabled:true` 的行。
- `UNKNOWN_COLUMN`：检查 NL/steps 中的列名是否与 `columns` 完全一致（大小写/中文/空格）。
- `ROW_TOO_LARGE`：单元格 ≤ 8192 字符。
- `itemKey` 不匹配：先看 `GET /runs/{id}/diagnostics` 的 warnings（是否 `[row:N]` 被改写）；再核对数据集快照。
