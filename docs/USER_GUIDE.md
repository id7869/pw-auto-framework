# 用户指南（面向普通用户）

> 本指南按「打开页面 → 用中文业务句子写用例 → 生成并确认 → 跑起来 → 看结果 → 做回归」的顺序写，全部界面路径均对应真实实现。
> 技术细节与接口见 [README](../README.md) 与 [skill API cheatsheet](../skills/pw-auto-test/references/api-cheatsheet.md)。

---

## 1. 启动与打开

```bash
pnpm -C pw-auto-framework install --frozen-lockfile
pnpm -C pw-auto-framework run dev      # 同时启动后端 8787 与前端 5173
```

浏览器打开 <http://127.0.0.1:5173/> —— 默认进入「测试用例」页。

> 只启动前端不会工作：页面所有数据都来自后端 `http://127.0.0.1:8787`。
> 若端口被占用：后端会打印中文提示并退出码 3，改 `PW_PORT` 后重启即可。

页面清单（左侧导航）：

| 页面 | 地址 | 用途 |
|---|---|---|
| 测试用例 | `#/cases` | 新建（默认业务句子）、编辑、生成、运行 |
| 数据集 | `#/datasets` | 为用例维护数据行（数据驱动） |
| 套件 | `#/suites` | 用例分组、批量运行 |
| 运行记录 | `#/runs` | 实时状态、逐项结果、产物 |
| 回归对比 | `#/regression` | 基线、差异分析 |
| Agent 交接 | `#/agents` | 三 harness 入口、skill 推荐放置路径、MCP/CLI 面板 |
| 设置与健康 | `#/health` | 连接状态、执行环境、版本 |

---

## 2. 建一个用例（只写业务句子）

> 新建用例默认进入「业务句子」模式：**你不需要选择 goto / click / fill 等动作，也不用写定位器**。一行写一句中文即可。

1. 进入 `#/cases` → 点「新建用例」。
2. 填 **名称**（必填）与描述，然后在文本域里按行写业务步骤：

```text
打开 https://demo.example.com/login
在「用户名」输入 {{用户名}}
在「密码」输入 {{密码}}
点击「登录」
页面上应该出现「欢迎，{{用户名}}」
```

书写规则：

| 规则 | 说明 |
|---|---|
| 一行一句 | 空行忽略；`#` 开头是注释行 |
| 不选动作 | 用「打开/输入/点击/选择/勾选/悬停/按键/等待/应该看到/应该等于/截图」描述意图 |
| 变量 | 统一 `{{列名}}`（与数据集列同名），不要写 `${}` |
| 目标 | 用 `「」` 包住页面上的元素名/文案，例如「登录」「用户名」 |
| 断言 | 「页面上应该出现 X」「输入框里应该是 Y」「地址应该是 Z」 |

3. 点「保存」→ 再点「生成」（或「保存并生成」）：框架创建一个**生成任务**并等待外部 coding agent 领取。
   - 框架**不内置模型**，不会自己"猜"步骤；生成由外部 agent（Claude Code / Codex / DeepSeek Harness + 本框架 skill）完成。
4. 生成返回后，右侧会出现**步骤卡片预览**：每张卡显示来源行号、动作（中文标签）、定位器、值/期望、依据与未解析告警。
5. 检查无误后点「采纳」（accept）：此时才真正写入可执行步骤。不满意可「拒绝」并改句子后重新生成。
6. 点「编译校验」提前发现结构/列名问题（不执行浏览器）；再点「运行」。

> **三种视图**（同一份数据）：
> - **业务视图（默认）**：业务句子 + 步骤卡片，给普通用户；
> - **步骤视图**：只读 `steps[]`，给测试工程师核对定位器/参数；
> - **代码视图**：只读编译出的官方 `.spec.ts` 预览（`GET /cases/{id}/spec?preview=1`），可复制但不可编辑。
>
> 生成结果若被改动：文本改过但未重新生成时，用例变为 `stale`——校验会给 `NL_STALE` 警告，运行会被拒绝（`409 NL_STALE`），重新生成并采纳即可。

**生成失败怎么办**

| 现象 | 含意 | 处理 |
|---|---|---|
| 卡片上有「未识别动作」 | 该行没匹配到动作 | 改用「点击/输入/应该看到…」等动词开头 |
| 卡片上有「目标不明确」 | 同一句有多个候选元素 | 在候选里选一个，或把「」里的文案写更具体 |
| 用例状态 `invalid` | 生成失败（有行无法映射） | 按告警改句子后重新生成（不会产生猜测步骤） |
| 运行提示 `422 NL_NOT_GENERATED` | 还没生成/正在生成/生成失败 | 先完成生成并采纳 |
| 运行提示 `409 NL_STALE` | 文本已改但未重新生成 | 重新生成并采纳，或显式允许"用旧步骤跑" |

---

## 3. 高级：结构化步骤与原始代码模式

### 3.1 结构化步骤（等价能力，供需要精确控制的用户）

在用例编辑器切到「结构化步骤」，每步 = 一个动作 + 一个目标（定位）+ 可选参数：

| 动作 | 用途 | 必填 |
|---|---|---|
| `goto` | 打开网址 | `url`（支持 `{{列}}`；以 `{{列}}` 开头视为动态 origin，运行期由官方校验 http/https） |
| `click` / `dblclick` / `hover` | 点击/双击/悬停 | 目标 |
| `fill` | 输入文本 | 目标 + 值 |
| `press` | 按键（如 `Enter`） | `key`（目标可选） |
| `select` | 下拉选择 | 目标 + 值 |
| `check` / `uncheck` | 勾选/取消 | 目标 |
| `waitFor` | 等待元素状态；无目标时等待页面加载（仅 visible/attached） | 状态；目标可选（`hidden`/`detached` 必须给目标） |
| `expectVisible` | 断言元素可见（官方 Web-First 断言，自动重试） | 目标 |
| `expectText` | 断言文本（可勾选「精确匹配」） | 目标 + 期望文本 |
| `expectValue` | 断言输入框的值 | 目标 + 值 |
| `expectURL` / `expectTitle` | 断言地址 / 标题 | 值 |
| `screenshot` | 主动截图（进产物） | — |
| `setViewport` | 设置视口尺寸 | 宽 + 高 |

目标定位方式（推荐从好到差）：

| 定位方式 | 什么时候用 | 例 |
|---|---|---|
| `角色 role` | 按钮/标题/输入框等有语义的元素（**首选**） | 角色 `button` + 名称 `提交` |
| `testId` | 站点有 `data-testid` | `hello` |
| `label` / `placeholder` / `text` / `alt` / `title` | 表单与文案元素 | 标签 `用户名` |
| `css` | 兜底（不建议，容易随改版失效） | `#submit` |

> `waitFor` 无目标：`visible` → 官方 `page.waitForLoadState('load')`；`attached` → `page.waitForLoadState('domcontentloaded')`。`hidden`/`detached` 是元素状态，必须填写目标，否则返回 `422 INVALID_STEP`。

### 3.2 原始代码模式（进阶）

编辑器支持 `mode = code`：直接粘贴一段 `@playwright/test` 代码（`test()` 内可用 `page`、`expect`）。

- 适用：结构化步骤表达不了的复杂场景（网络拦截、多标签页、自定义 fixture 逻辑）。
- 风险：代码会**原样执行**（等价于运行任意脚本），仅在你信任内容时使用；不要粘贴来源不明代码。
- 校验：保存时只做结构与可编译性校验；真正的正确性由运行结果说话。

---

## 4. 数据驱动（一个用例跑多行数据）

### 4.1 建数据集

1. 进入 `#/datasets`（也可从用例编辑器跳转），选择目标用例。
2. 新建数据集，填名称与来源（`manual` 手工/`json` JSON/`csv` CSV）。
3. 逐行录入；每行是一组「列名 → 值」。列名会自动推导（`columns`），行可单独禁用（`enabled=false` 的行不执行）。
4. NL 编辑器下方会显示该用例的**列清单**，点列名即可插入 `{{列}}`。

边界：列 1..50 个、行 ≤500 行、单元格 ≤8192 字符；重复/空列名会被拒绝（`INVALID_DATASET`）。

### 4.2 在业务句子/步骤里引用列

把变量写进任意字符串：`{{列名}}`。例如：

- 业务句子：`在「用户名」输入 {{用户名}}`、`页面上应该出现「欢迎，{{用户名}}」`
- 结构化步骤：`goto` 的 `url`、`fill` 的值、`expectText` 的期望值都可写 `{{列}}`

> 引用不存在的列：带 `datasetId` 校验/生成提交会给出 `UNKNOWN_COLUMN` 并列出可用列；不带数据集校验时含 `{{列}}` 的用例必然 `ok:false`（没有列可对照，属预期）。

### 4.3 运行与逐行结果

在用例编辑器或运行页选择数据集后点「运行」：

- **一行数据 = 一个独立的 Playwright test**，标题带 `[row:N]`（N 从 0 开始）。
- 运行详情页有「逐行视图」：行号、状态、耗时、错误摘要、trace/截图链接。
- 若用例是 NL 用例，每行会**回标到业务句子行号**（`stepOrigin`），失败时能直接看到"哪一句错了"。
- `itemKey` 形如 `<caseId>#row:1`，跨运行稳定，便于做前后对比。

---

## 5. 套件（批量运行）

1. `#/suites` → 新建套件 → 选择若干用例（有序）。
2. 点「运行套件」：一次性按顺序执行套件内所有用例。
3. 套件运行**不使用数据集**（数据集是用例级绑定）：每个用例按其默认执行方式跑一次。
4. 套件成员的 NL 门禁逐成员检查：某成员未生成/失效会让该成员失败并给出对应错误码。

> 限制：套件内不允许重复用例（重复会返回 `422 UNKNOWN_CASE` 语义的校验失败）。

---

## 6. 运行与实时状态

点「运行」后跳到运行详情页，状态机共 6 态：

```
queued（排队中） → running（运行中） → passed / failed / cancelled / error
```

- 页面通过 SSE（`/api/v1/runs/{id}/events`）实时刷新，失败自动退回轮询。
- 顶部显示 `stats`：`expected`（通过）/`unexpected`（失败）/`flaky`（重试后通过）/`skipped`/总耗时。
- 「取消」：排队中直接取消；运行中会中止并强杀浏览器进程（已产出的结果保留）。
- 队列上限 32、并发默认 1（`PW_MAX_CONCURRENT_RUNS`，可设 1..2）；超限返回 `429 TOO_MANY_RUNS`。

运行详情里的诊断信息（`diagnostics`）包含：官方 CLI 路径、**官方命令 argv 回显**、编译出的 spec 路径、官方 JSON 报告路径、工作目录——用于复现问题。

---

## 7. 看结果：失败怎么读

「逐项结果」每条 = 一个 `itemKey`，含：

| 字段 | 含义 |
|---|---|
| `outcome` | `expected`（通过）/`unexpected`（失败）/`flaky`（重试后通过）/`skipped`/`missing`/`unknown` |
| `attempts[]` | 每次尝试：状态（`passed/failed/timedOut/skipped/interrupted`）、耗时、错误信息与位置 |
| `attachments[]` | trace / 截图 等附件 |
| `errorHash` | 错误指纹（用于对比「错误是否变化」，忽略颜色码与换行差异） |

**flaky 怎么理解**：首次失败、重试通过 → `outcome=flaky`，`attempts` 会有 2 条（第 1 条 failed、第 2 条 passed）。`stats.flaky > 0` 时页面顶部有告警条。若希望 flaky 也算失败，运行时勾选「flaky 视为失败」（`failOnFlaky`）。

**常见失败原因与排查**

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `locator not found` / 元素不存在 | 定位器过期、页面改版 | 用「元素探查」重新取快照，改用 role/testId 定位；或改业务句子后重新生成 |
| 断言文本不一致 | 期望值写错、动态文案 | 打开 trace 看实际文本；改用包含/正则匹配 |
| 操作超时（默认用例 60s） | 页面慢、等待条件不足 | 加等待步骤；调大运行选项 `timeoutMs` |
| `net::ERR_*` / 打不开页面 | 站点不可达、代理、证书 | 检查目标 URL；企业网用 `PW_BROWSER` + 代理配置（见运维手册） |
| 全部行都 skipped | 数据集行被禁用 | 在数据集页启用行 |
| 运行 `failed` 但 status 显示 0 失败 | `failOnFlaky` 开启且有 flaky | 看顶部的 flaky 告警条 |
| 运行 `error` | 引擎/环境失败（非用例失败） | 看 `Run.error` 与后端日志；常见为浏览器缺失或 CLI 路径异常 |

**产物**：失败默认保留 trace 与截图（`trace: retain-on-failure`、`screenshot: only-on-failure`）。点击产物可直接下载；trace 也可用官方命令打开：

```bash
node node_modules/@playwright/test/cli.js show-trace <下载下来的 trace.zip>
```

---

## 8. 回归：基线 + 对比

1. 先跑出一个 **passed** 的运行（只有通过的运行才能设基线）。
2. 在运行详情或 `#/regression` 里「设为基线」，命名（如「v1.2 基线」）。同一范围（用例/套件）可有多条基线，其中一条是「默认」。
3. 后续改动后再跑一次，选择基线与新运行 → 「生成对比」。

对比结果：

- `summary`：10 类差异计数 + `verdict`（`regression`/`improvement`/`unchanged`/`mixed`）。
- 逐项 `change`：`newly_failed`、`newly_passed`、`still_failed`、`still_passed`、`flaky`、`became_flaky`、`skipped`、`new_item`、`missing_item`、`unknown`。
- 每条还带：`errorChanged`（错误指纹是否变化）、`durationDeltaMs`、`artifactDelta`、`attribution`（失败归因，**推断**）。

> 页面会标注「依据：胶水层计算」——`verdict` 与差异分类是规则计算，不是 Playwright 官方结论；官方只给 `expected/unexpected/flaky/skipped` 三态。

**基线管理注意**：归档基线需二次确认（`confirm:true`）；切换默认基线会改变后续对比口径，属于人工决策。

---

## 9. Agent 交接页（三 harness + 通用 skill）

`#/agents` 只展示 **3 个 harness 入口**（没有 6 loop、没有安装按钮），并按 `GET /api/v1/agents/harnesses` 显示各自推荐 skill 路径：

| 入口 | 官方 loop | 推荐放置路径（自己复制） |
|---|---|---|
| `claude`（Claude Code） | `claude` | `<repo>/.claude/skills/pw-auto-test/` 或 `~/.claude/skills/pw-auto-test/` |
| `codex`（Codex CLI） | `codex` | `~/.codex/skills/pw-auto-test/` 或 `<repo>/.codex/skills/pw-auto-test/` 或 `~/.agents/skills/pw-auto-test/` |
| `deepseek`（DeepSeek Harness） | **无**（`officialLoop=null`） | `~/.dsh/skills/pw-auto-test/` 或 `<repo>/.agents/skills/pw-auto-test/` |

**怎么用 skill**：

1. 把仓库里的 `skills/pw-auto-test/` **整个目录**复制到上表某个路径（同一份 skill，框架不安装、也没有安装 API）。
2. 重开对应 harness 会话，问一句「列出可用 skill」应能看到 `pw-auto-test`。
3. 之后直接用自然语言让它「按 skill 跑一遍登录冒烟 / 用 2 行数据跑」即可；skill 只调用本框架 HTTP API，**不需要你额外配置 MCP**。
4. 只读自检：`node skills/pw-auto-test/scripts/verify.mjs`（不复制、不修改任何文件）。

页面上另外两块仍可用：

1. **MCP 会话**：启动官方 `playwright mcp` 子进程（默认 caps = `testing,storage,network`，实测 51 个工具），可查看工具清单、调用白名单工具。危险工具（`browser_run_code_unsafe`/`browser_evaluate`/坐标类）默认禁用。
2. **CLI 命令面板**：以子进程执行官方 `playwright cli` 白名单命令（如 `snapshot`、`screenshot`、`generate-locator`），展示 `--json` 输出与退出码。`install*`/`attach` 永久拒绝。
3. **官方 Agent 脚手架**：`claude`/`codex` 调用官方 `init-agents` 生成 planner/generator/healer 定义与 `specs/`、`seed.spec.ts`；`deepseek` 官方无该 loop，只写入官方 `--prompts` 同构模板。

**重要边界**：真正「规划、写用例、修复失败」的是你在 Claude Code / Codex / DeepSeek Harness 里的 coding agent；框架只提供脚手架、产物浏览与执行证据。**不存在**「一键 AI 自动修复」按钮。

---

## 10. 常见问题（FAQ）

**Q：前端页面空白/一直转圈？**
A：确认后端已在 8787 运行（打开 <http://127.0.0.1:8787/api/health> 应返回 JSON）；前端代理默认指向 8787，可用 `PW_API_BASE` 覆盖后重启 vite。

**Q：运行提示浏览器不存在？**
A：本机应有 `chromium-1254`。**不要**随手跑 `playwright install`（会 GC 掉其他项目浏览器），先看 [OPERATIONS.md §3](OPERATIONS.md)；无 CfT 时可设 `PW_BROWSER=chrome`/`msedge` 用系统浏览器。

**Q：点了「生成」但一直没结果？**
A：生成是**异步任务**，需要外部 coding agent（或本机模拟 agent）领取后提交。框架不会自己生成。可在 `#/agents` 按上表放置 skill 并用 harness 驱动，或先用确定性模拟 agent 验证链路：
`node skills/pw-auto-test/scripts/agent-loop.mjs --scenario=full --api-base=http://127.0.0.1:8787 --base-url=<被测站点>`。

**Q：为什么「编译校验」通过但运行还是失败？**
A：校验只覆盖结构/列名，不执行浏览器。文案、时序、网络等只有真实运行才能发现。

**Q：数据驱动用例的「编译校验」报 `UNKNOWN_COLUMN`，是列名写错了吗？**
A：分两种情况：
- **选了数据集**：校验会按启用行 + 数据集列做真实编译。若报 `UNKNOWN_COLUMN`，说明引用的列确实不在该数据集中（错误详情会指到第几步）；列都对则是 `ok:true` 并显示启用行数。
- **没选数据集**：此时没有列可对照，含 `{{…}}` 的用例必然显示 `ok:false` + `UNKNOWN_COLUMN`，**这是预期语义而非故障**——请选上数据集再校验，或直接运行看真实结果。

**Q：生成好了，为什么运行说 `422 NL_NOT_GENERATED` / `409 NL_STALE`？**
A：`NL_NOT_GENERATED` = 还没生成、正在生成或生成失败；`NL_STALE` = 生成后又改了业务句子。前者请完成"生成→采纳"，后者请重新生成并采纳（或显式允许用旧步骤跑）。

**Q：删除用例会连带删掉历史运行吗？**
A：不会。删除是软删除，历史运行已固化用例快照，仍可查看与对比。

**Q：为什么页面上看到的是干净的错误文字，但下载的日志/JSON 里有 `[2m`、`[31m`？**
A：官方 reporter 的原始输出带 ANSI 颜色控制符，接口与产物按原样保留（便于精确复现）。中文界面在展示时已统一剥离控制符，并提供「复制原始错误（含控制符）」入口；`errorHash` 计算前也已剥离，所以「错误是否变化」不受影响。

**Q：能多人同时用吗？**
A：当前是单机单用户、无鉴权设计；不要绑定到 `0.0.0.0` 或对外暴露。

**Q：数据存在哪里？怎么备份？**
A：默认 `<repo>/.data/`（`PW_DATA_DIR` 可改），含 `pw-auto.db`（运行历史/基线/NL 生成任务）与 `runs/<runId>/`（产物）。备份与恢复见 [OPERATIONS.md §6](OPERATIONS.md)。
