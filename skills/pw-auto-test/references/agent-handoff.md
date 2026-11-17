# 官方 Agent 交接（planner / generator / healer）

> 官方定义：`https://playwright.dev/docs/test-agents`（Playwright 1.56 引入，1.65 在册）。
> 三个 Agent 是**静态指令 + MCP 工具白名单**，由外部 coding agent（本 skill 所在 harness）执行；
> 框架只提供生成任务、门禁与执行证据，**不调用模型**。

## 1. 三个 Agent 的职责

| Agent | 输入 | 输出 | 本 skill 中的落点 |
|---|---|---|---|
| 🎭 planner | 用户目标 + seed/页面探索 | `specs/<feature>.plan.md`（场景/步骤/期望/前置假设） | `templates/plan.md`；探索用框架 MCP 的 `browser_navigate/snapshot/find` |
| 🎭 generator | 测试计划中的 1 个场景 | 官方 `@playwright/test` 规格（每次只处理一个场景，串行） | `templates/generate.md`；生成 `steps` + `stepOrigin` 提交 |
| 🎭 healer | 失败测试 + 证据（trace/错误/截图） | 修复后的测试；无法修复时 `test.fixme()` + 说明 | `templates/heal.md`；读取 `errorHash`/artifacts 后重生成 |

官方推荐链路：planner → generator（逐场景、不并行）→ healer；三者可独立、可顺序、可循环。
`templates/coverage.md` 是官方 coverage 编排提示（planner→generator→healer 的 subagent 调用模板）。

## 2. 模板来源（官方 `init-agents --prompts` 同构）

`templates/` 下四个 `.md` 文件来自官方 `@playwright/test@1.65.0` 包内
`lib/agents/playwright-test-{plan,generate,heal,coverage}.prompt.md`（即 `npx playwright init-agents --loop=<loop> --prompts`
生成的文件内容），仅在文件末尾加了来源注释；`seed.spec.ts` 来自官方 init-agents 的 seed 产物。

| 文件 | 官方 agent | 用途 |
|---|---|---|
| `templates/plan.md` | `playwright-test-planner` | 生成测试计划 |
| `templates/generate.md` | `playwright-test-generator` | 把计划的一个场景转成测试 |
| `templates/heal.md` | `playwright-test-healer` | 运行并修复失败测试 |
| `templates/coverage.md` | coverage 编排 | planner→generator→healer 子代理模板 |
| `templates/seed.spec.ts` | seed | 提供 `page` 上下文的种子测试 |

官方 6 loops（`init-agents --loop`）：`claude | codex | copilot | opencode | vscode | vscode-legacy`。
**没有 `deepseek`**：本框架返回 `deepseek.officialLoop:null`，不得伪造；deepseek 用官方四模板 + 本 skill + 项目 README。

## 3. 本 skill 的执行方式（不调模型）

1. 触发 `POST /api/v1/cases/{id}/nl/generations {generator:"agent"}`，让框架进入 queued。
2. `GET /api/v1/nl/generations?status=queued` + `claim` 拿到任务快照（`nlText/caseName/datasetColumns/hints`）。
3. 若需页面事实：创建**框架 MCP** 会话（`POST /api/v1/mcp/sessions`），仅用 28 个白名单工具；
   不直连浏览器、不给 harness 配 MCP。
4. 把 `templates/*.md` 与 `nlText` 作为提示词交给**当前 harness 的模型**（由 harness 负责），
   得到 steps；把每个 step 映射到 NL 行号形成 `stepOrigin`。
5. `submit`（`generatorVersion:"pw-auto-test/1.0.0"`）→ `accept` → `validate` → `run`。
6. 若 run 失败：读 items 的 `errorHash`、`attempts[].error` 与 artifacts（trace/screenshot），用 healer 模板诊断 →
   重新 `POST generations {force:true}` → 重走 4–5；**只有新 run 通过才能说修复完成**。

## 4. 生成质量约束

- steps 只能是 17 个官方动作（见 `nl-to-case.md`）；断言用官方 Web-First 断言，不 sleep、不自造断言。
- target 用官方 locator 声明（role/testId/label/placeholder/text/alt/title/css），优先语义定位。
- `{{列}}` 必须原样保留；提交时带 `datasetId`，框架会按数据集列校验。
- 每步 `stepOrigin.nlLine` 必须落在 NL 文本行号范围；缺失/越界会 `422 NL_SUBMIT_INVALID`。
- 生成结果必须经 `accept` 才写入用例；`reject` 不会改用例。NL 文本生成后被改会 `409 NL_STALE`。
- 不确定的映射必须显式告警（`NL_LINE_UNMAPPED`/`NL_TARGET_AMBIGUOUS`/`NL_UNSUPPORTED_ACTION`/`NL_NO_ASSERTION`），不得猜。

## 5. 责任边界

| 谁 | 负责 | 不负责 |
|---|---|---|
| 当前 harness（Claude/Codex/DeepSeek） | 模型推理、生成/修复 steps、决定是否继续 | 执行浏览器、写框架数据库、直接跑 `playwright test` |
| pw-auto-framework | 生成任务状态机/租约、MCP/CLI 托管、validate/run、JSON 报告、产物、回归 | 内置 LLM、自动修复、自动规划 |
| 用户 | 目标任务、业务语义确认、危险能力开关、最终合并 | — |

## 6. 官方依据

- Agents：`https://playwright.dev/docs/test-agents`
- 参数化/数据驱动：`https://playwright.dev/docs/test-parameterize`
- 断言：`https://playwright.dev/docs/test-assertions`
- MCP 工具：`https://playwright.dev/mcp/tools/*`
- 官方 CLI：`https://playwright.dev/docs/test-cli`