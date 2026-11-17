# NL 到官方用例（书写规则与动词映射）

> NL 是**生成输入**，最终执行的是官方 Playwright Test steps。模型（harness）负责把 NL 转成步骤；
> 框架负责校验、接受（accept）、编译和执行。不要伪造 `mode:"nl"`；`mode` 仍为 `steps|code`。

## 1. 一行一句

- 一行 = 一个可执行意图；空行、`#` 开头为注释（仍占 NL 行号）。
- 每行都必须能映射到一个官方动作；不能确定时生成 `NL_LINE_UNMAPPED`/`NL_UNSUPPORTED_ACTION` 告警，**不要猜**。
- 每个生成步骤必须写 `stepOrigin: { stepId: { nlLine: N } }`，N 为 1 基 NL 行号；submit 时框架会校验覆盖与范围。

## 2. 变量 `{{列}}`

- 任一字符串字段都可含 `{{列名}}`；列名来自数据集 `columns`（≤60 字符，1..50 列）。
- 允许出现的位置：`url`、`value`、`target.name/text`、`target.role` 等字符串字段。
- **不要**在 NL 或 steps 里把 `{{列}}` 替换成某一行字面值；逐行执行由官方 `forEach` 完成。
- 无数据集时步骤里不能出现 `{{列}}`（`UNKNOWN_COLUMN`）；数据驱动用例请先建数据集或用带 `datasetId` 的 validate。

## 3. 动作映射（17 个官方动作）

| NL 意图（示例） | 官方 action | 必填 |
|---|---|---|
| 打开/访问 `<url>` | `goto` | `url`（http/https；`{{列}}` 开头为动态 origin） |
| 点击「登录」 | `click` | `target` |
| 双击「…」 | `dblclick` | `target` |
| 在「用户名」输入 `{{用户名}}` / 填写 | `fill` | `target` + `value` |
| 按 `Enter` / 按 `Control+A` | `press` | `key`（target 可选） |
| 选择「选项」/ 下拉选择 | `select` | `target` + `value` |
| 勾选/取消勾选 | `check` / `uncheck` | `target` |
| 悬停「…」 | `hover` | `target` |
| 等待「…」出现/可见 | `waitFor` 或 `expectVisible` | 有 target；无 target 仅 `state=visible/attached`（页面加载等待） |
| 看到/应该出现文本「…」 | `expectText` | `target` + `value` |
| 输入框的值应为「…」 | `expectValue` | `target` + `value` |
| 地址应为 `…` / 标题应为「…」 | `expectURL` / `expectTitle` | `url`/`value` |
| 截图 | `screenshot` | 无 |
| 设置视口 `WxH` | `setViewport` | `width` + `height`（100..4096） |

**不支持**（不要生成）：拖拽 `drag`/`drop`、上传、iframe、多 tab、网络 mock、视觉坐标/鼠标 unsafe、任意 JS 执行。
这些能力不在 17 动作白名单内，出现应返回 `NL_UNSUPPORTED_ACTION`；确需时让用户改用 `mode:"code"`（官方 Test 代码，人工审阅）。

## 4. Target 书写

harness 通过框架 MCP 快照/查找获得页面事实后，把 target 写成官方 locator 声明：

```jsonc
{ "by": "role", "role": "button", "name": "登录", "exact": true }
{ "by": "testId", "testId": "hello" }
{ "by": "label", "text": "用户名" }
{ "by": "placeholder", "text": "请输入" }
{ "by": "text", "text": "提交", "exact": true }
{ "by": "alt", "text": "图片说明" }
{ "by": "title", "text": "提示" }
{ "by": "css", "selector": "#submit" }   // 兜底；UI 标注“不推荐”
```

优先级：role → testId → label/placeholder/text/alt/title → css。避免动态 class、nth-child、XPath。
断言必须是官方 Web-First 断言（`expect(locator).toBeVisible()/toHaveText()/toHaveValue()`）；不要 sleep，不要自造断言。

## 5. 生成产物的最小 shape

```jsonc
{
  "steps": [
    { "id": "s1", "action": "goto", "url": "http://127.0.0.1:4174/" },
    { "id": "s2", "action": "expectText", "target": { "by": "testId", "testId": "hello" }, "value": "你好，自动化" }
  ],
  "stepOrigin": { "s1": { "nlLine": 2 }, "s2": { "nlLine": 3 } },
  "generatorVersion": "pw-auto-test/1.0.0"
}
```

`stepOrigin` 每个 stepId 都必须有；行号必须落在 NL 文本行数范围内。submit 时若行号越界/缺失会 `422 NL_SUBMIT_INVALID`。

## 6. 告警码（来自服务端）

| code | 含义 | 处理 |
|---|---|---|
| `NL_LINE_UNMAPPED` | 某行未映射到步骤 | 补生成/标记为注释；不可忽略 |
| `NL_TARGET_AMBIGUOUS` | 定位器可能匹配多个元素 | 用框架 MCP snapshot 收紧 name/exact |
| `NL_UNSUPPORTED_ACTION` | 动作不在 17 白名单 | 改用支持动作或 `mode:code` 人工审阅 |
| `NL_NO_ASSERTION` | 只有操作、没有断言 | 至少补一条官方 expect |

## 7. 示例：数据驱动

NL：

```text
# 两行问候
打开 http://127.0.0.1:4174/?name={{名字}}
页面上应该出现「你好，{{名字}}」
```

数据行：`[{"名字":"自动化"},{"名字":"张三"}]`；生成后保留 `{{名字}}`，带 `datasetId` 运行 → 每行一个 item
（`itemKey=caseId#row:N`，`title` 含 `[row:N]`）。详见 `data-driven.md`。
