# pw-auto-framework

> 面向普通用户的中文 Web 自动化测试平台：**用中文业务句子写用例（NL-first，不选动作），保存/生成/运行全部在浏览器里完成**。底层把「用例 + 数据集」确定性编译成官方 `@playwright/test` 规格并执行，把官方 JSON 报告与产物沉淀为**运行历史、回归基线与失败归因**；同时把官方 **MCP / CLI / planner·generator·healer 三 Agent** 以「可交接、可审计」的方式交由外部 coding agent（**仅 claude / codex / deepseek 三入口**）驱动。
>
> NL→steps 的转化**由外部 agent 完成**（一份静态通用 skill `skills/pw-auto-test/`，用户自行复制到 harness 的 skills 目录，框架不安装、无安装 API、无 MCP 手工配置）；框架只负责用例存储、生成任务、校验、执行、证据与回归。
>
> 文档导航：[用户指南](docs/USER_GUIDE.md) · [项目架构图](ARCHITECTURE.html) · [通用 skill 架构图](SKILL_ARCHITECTURE.html) · [官方 Playwright 套件架构](PLAYWRIGHT_SUITE_ARCHITECTURE.html) · [通用 skill](skills/pw-auto-test/SKILL.md)。
>
> **本框架不内置任何 LLM**：用例规划、用例生成、失败修复由**外部** coding agent（Claude Code / Codex / DeepSeek Harness 三个入口）依据官方 Agent 定义完成；本框架负责**执行、证据与回归**。

---

## 1. 官方能力边界（唯一承重）

| 官方能力 | 本框架用法 | 来源 |
|---|---|---|
| **Playwright Test**（`playwright test`） | 执行回归：编译产物是官方规格（`test.describe`/`test`/`test.step`/`expect`），`--reporter json` 为唯一入库契约 | <https://playwright.dev/docs/test-cli> |
| **Playwright CLI**（`playwright cli`） | 运行期动作/取证（`snapshot`/`click`/`generated-locator` 等），经白名单子进程调用 | <https://playwright.dev/agent-cli/introduction> |
| **Playwright MCP**（`playwright mcp`） | 探索/取证工具面（`browser_*`），后端以 stdio 子进程托管，工具白名单 + unsafe 默认关闭 | <https://playwright.dev/mcp/introduction> |
| **三个原生 Agent**（`playwright init-agents`） | 生成官方 planner/generator/healer 定义与 `specs/`、`seed.spec.ts` 脚手架，交给外部 coding agent；**后端只暴露 3 个 harness 入口**（`claude`/`codex`/`deepseek`），`deepseek` 无官方 loop（`officialLoop=null`，用官方 `--prompts` 同构模板） | <https://playwright.dev/docs/test-agents> |
| **Trace**（`playwright trace`） | 失败证据（trace 产物入库，可按需用官方 `show-trace` 打开） | <https://playwright.dev/docs/trace-viewer> |

版本：`@playwright/test@1.65.0`（单一依赖，内置上述全部子命令）；Node **>=24 <25**；pnpm 11.22.0。

**框架自有资产（非官方能力）**：`skills/pw-auto-test/` 是一份**静态**通用 skill（`SKILL.md` + 6 篇 references + 3 个 scripts + 5 个官方 `--prompts` 同构模板）。框架**不安装、不复制、不落盘**该 skill；用户按 `GET /api/v1/agents/harnesses` 返回的 `skillPaths` 自行复制到 harness 技能目录（`scripts/verify.mjs` 只做只读自检）。

**明确不使用**：`playwright-cli@0.262.0`（npm 已弃用空壳、无 bin）、单独安装的 `@playwright/mcp` / `@playwright/cli`（会引入 `playwright-core@1.66.0-alpha`，造成双 core 与双浏览器 registry）、`test.each`（官方不存在）、`page.perform` / `--run-agents`（官方 API 参考与类型声明均无）、`--only-changed`（官方仅支持 Git，本工作区非 git）。

---

## 2. 架构概览

```
浏览器（React 19 + Vite 8，中文 UI）
        │  HTTP /api/v1（JSON）
后端 apps/api（node:http 自研路由 + zod 校验 + node:sqlite 持久化）
        │  进程内接口 ExecutionEngine
执行引擎 packages/automation（编译器 / 官方 CLI 执行 / JSON 报告解析 / MCP / CLI / Agents 适配）
        ├── 子进程：官方 playwright test（回归执行）
        ├── 子进程：官方 playwright mcp（stdio 工具面）
        ├── 子进程：官方 playwright cli（白名单命令）
        └── 子进程：官方 init-agents（Agent 脚手架）
共享：packages/contracts（zod schema / 类型 / 错误码 / 常量）
外部：harness（Claude Code / Codex / DeepSeek Harness）+ 静态 skill skills/pw-auto-test/（用户自行放置）
```

硬边界：只有 `packages/automation` 允许 spawn 官方子进程；只有 `apps/api` 读写数据库；只有 `packages/contracts` 定义 schema。

---

## 3. 快速开始（从零到跑通一个用例）

### 3.1 依赖与浏览器

```bash
# 工作区依赖（冻结安装，禁止改 lockfile）
pnpm -C pw-auto-framework install --frozen-lockfile

# 浏览器：本机已有 chromium-1254，无需下载
# 若缺失，才执行一次（先确认不会 GC 掉其他项目浏览器，见 §7）
# npx playwright install chromium
```

验证官方入口可用：

```bash
node node_modules/@playwright/test/cli.js --version   # 期望 Version 1.65.0
```

### 3.2 构建与启动

```bash
# 构建（后端 dist + 前端 dist）
pnpm -C pw-auto-framework run build

# 开发模式：同时启动 API(8787) 与 Web(5173)
pnpm -C pw-auto-framework run dev
```

启动后访问：

| 地址 | 说明 |
|---|---|
| <http://127.0.0.1:5173/#/cases> | 前端入口（用例列表） |
| <http://127.0.0.1:8787/api/health> | 后端健康检查 |
| <http://127.0.0.1:8787/api/v1/meta> | 版本/能力/限制元信息 |

生产单进程形态（同一端口托管前端静态产物）：

```bash
pnpm -C pw-auto-framework run build
PW_STATIC_DIR=pw-auto-framework/apps/web/dist node pw-auto-framework/apps/api/src/main.ts
# 然后访问 http://127.0.0.1:8787/
```

### 3.3 NL-first 最小示例（推荐：只写业务句子）

> 普通用户不需要选择 goto/click/fill。新建用例默认就是「业务句子」模式（`#/cases/new`），一行一句，可含 `{{列名}}`。

```bash
API=http://127.0.0.1:8787

# ① 建 NL 用例（nl.text 一行一句；不出现任何原子动作）
CASE=$(curl -s -X POST $API/api/v1/cases -H 'content-type: application/json' -d '{
  "name": "登录后看到欢迎语", "mode": "steps",
  "nl": { "text": "打开 https://demo.example.com/login\n在「用户名」输入 {{用户名}}\n点击「登录」\n页面上应该出现「欢迎，{{用户名}}」" }
}')
CASE_ID=$(echo "$CASE" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.id")

# ② 创建生成任务（默认 generator=agent；框架不调模型）
curl -s -X POST $API/api/v1/cases/$CASE_ID/nl/generations -H 'content-type: application/json' -d '{"generator":"agent"}'

# ③ 外部 agent（或本机确定性模拟 agent）领取 → 提交 → 接受
node skills/pw-auto-test/scripts/agent-loop.mjs --scenario=full --api-base=$API --base-url=https://demo.example.com

# ④ 校验（数据驱动用例请带 datasetId）+ 运行
curl -s -X POST $API/api/v1/cases/$CASE_ID/validate -H 'content-type: application/json' -d '{}'
curl -s -X POST $API/api/v1/runs -H 'content-type: application/json' \
  -d "{\"target\":{\"kind\":\"case\",\"caseId\":\"$CASE_ID\"}}"
```

- 生成成功但未 `accept` 前用例**不可运行**：`validate`/`run` 返回 `422 NL_NOT_GENERATED`；文本改过则 `409 NL_STALE`（`options.allowStaleNl=true` 放行）。
- 真实执行仍是官方 `playwright test`；`accept` 之后执行真相是 `steps[]`，NL 原文只用于展示/重生成/失败回标。

### 3.4 最小示例（API 三步跑通，结构化步骤）

> 示例目标为公网站点 `https://playwright.dev/`；离网环境请换成本地站点（如 `http://127.0.0.1:4174/` 之类可访问地址）。

```bash
# 1) 建用例（结构化步骤）
curl -s -X POST http://127.0.0.1:8787/api/v1/cases \
  -H 'content-type: application/json' \
  -d '{"name":"冒烟-示例站","mode":"steps","steps":[
        {"id":"s1","action":"goto","url":"https://playwright.dev/"},
        {"id":"s2","action":"expectVisible","target":{"by":"role","role":"heading","name":"Playwright"}}]}'

# 2) 运行（返回 202 + runId）
curl -s -X POST http://127.0.0.1:8787/api/v1/runs \
  -H 'content-type: application/json' -H 'Idempotency-Key: demo-1' \
  -d '{"target":{"kind":"case","caseId":"<上一步的 id>"}}'

# 3) 轮询到终态，再看逐项结果与产物
curl -s http://127.0.0.1:8787/api/v1/runs/<runId>
curl -s http://127.0.0.1:8787/api/v1/runs/<runId>/items
curl -s http://127.0.0.1:8787/api/v1/runs/<runId>/artifacts
```

更完整的 curl 流程（数据驱动、基线、对比、MCP/CLI/Agents 交接）见 [用户指南](docs/USER_GUIDE.md) 与 [skill API cheatsheet](skills/pw-auto-test/references/api-cheatsheet.md)。

---

## 4. 五条验收命令（交付门禁）

```bash
pnpm -C pw-auto-framework install --frozen-lockfile
pnpm -C pw-auto-framework run typecheck
pnpm -C pw-auto-framework run build
pnpm -C pw-auto-framework run test:unit
pnpm -C pw-auto-framework run test:e2e
```

| 命令 | 覆盖内容 |
|---|---|
| `install --frozen-lockfile` | 依赖冻结一致性（实现期禁改 `package.json` / `pnpm-lock.yaml`） |
| `typecheck` | 5 个包 `tsc --noEmit` |
| `build` | `packages/*` + `apps/api` → `dist`，`apps/web` → `vite build` |
| `test:unit` | 全包 vitest（contracts / automation / api / web） |
| `test:e2e` | 官方 Playwright 验收套件：`tests/e2e/specs/` 下 **19 个 spec / 50 个用例（A0~A18）**，覆盖 UI 主流程、API 合同、数据驱动、回归/flaky、官方 MCP/CLI/Agents、安全抽查与修复回归。配置固定 `testDir: './specs'` + `testIgnore: ['**/.tmp/**']`，临时数据目录在系统 temp（不写入仓库）；验收产物写入 `tests/e2e/test-results/`（运行期生成，不随交付） |

---

## 5. 目录结构

```
pw-auto-framework/
├─ apps/api/               # 后端：node:http 路由、zod 校验、node:sqlite 持久化、运行编排、回归对比
├─ apps/web/               # 前端：React 页面（用例/数据集/套件/运行/回归/Agent/健康）
├─ packages/automation/    # 执行引擎与官方能力适配（编译器、runner、MCP/CLI/Agents、进程树）
├─ packages/contracts/     # 共享合同（zod schema、类型、错误码、枚举、中文文案常量）
├─ tests/e2e/              # 官方 @playwright/test 验收套件（19 spec / 50 用例，A0~A18；fixtures + support + 快速开始脚本）
├─ docs/                   # 用户指南（本工程仅保留 README + 用户指南）
├─ ARCHITECTURE.html       # 可交互项目架构图（浏览器打开）
├─ SKILL_ARCHITECTURE.html # 通用 skill 架构图（浏览器打开）
├─ PLAYWRIGHT_SUITE_ARCHITECTURE.html # 官方 Playwright 套件架构图（浏览器打开）
├─ skills/pw-auto-test/     # 静态通用 skill（15 文件；用户自行复制到 harness，框架不安装）
├─ .data/                  # 运行时数据（git 忽略）：pw-auto.db、runs/<runId>/、mcp/
└─ agents/                 # Agent 脚手架输出（git 忽略）：agents/<scaffoldId>/
```

| 包 | 名称 | 职责 |
|---|---|---|
| `apps/api` | `@pw-auto/api` | HTTP API / 持久化 / 运行编排 / 回归 |
| `apps/web` | `@pw-auto/web` | 中文 UI |
| `packages/automation` | `@pw-auto/automation` | 唯一允许触碰 Playwright 与子进程的层 |
| `packages/contracts` | `@pw-auto/contracts` | 前后端共享合同（唯一 schema 来源） |
| `tests/e2e` | `pw-auto-e2e` | 官方 Playwright 验收套件 |

> 工作区包暴露 `./src/index.ts` 作为入口（`main`/`types`/`exports`），因此 `dev` 与 e2e 可源码直跑，不依赖先 `build`。

---

## 6. 已实现能力一览

| 能力 | 状态 | 入口 |
|---|---|---|
| 用例 CRUD（结构化步骤 / 原始 Test 代码双模式） | ✅ | `#/cases`、`/api/v1/cases` |
| **NL-first 用例**（业务句子、行号/注释/`{{列}}`、无动作下拉） | ✅ | `#/cases/new`、`/api/v1/cases/{id}/nl` |
| **NL 生成任务**（7 态 + 租约 + 超时 + 单例互斥；claim/submit/accept/reject/cancel） | ✅ | `/api/v1/nl/generations`、`/cases/{id}/nl/generations` |
| NL 门禁（未生成 422、stale 409/警告、只读 spec 预览） | ✅ | `POST /validate`、`POST /runs`、`GET /cases/{id}/spec?preview=1` |
| 编译校验（不执行） | ✅ | `POST /api/v1/cases/{id}/validate` |
| 数据驱动（manual/json/csv；一行一个 test；标题 `[row:N]`） | ✅ | `#/datasets`、`POST /api/v1/runs {datasetId}` |
| 套件批量运行 | ✅ | `#/suites` |
| 运行编排（6 态状态机、并发上限、取消、超时、队列上限） | ✅ | `#/runs`、`POST /api/v1/runs` |
| 逐项/逐行结果与 attempts（flaky 可见） | ✅ | `GET /api/v1/runs/{id}/items` |
| 产物索引与下载（trace/截图/JSON 报告/日志/spec 等 10 类） | ✅ | `GET /api/v1/runs/{id}/artifacts` |
| 回归基线（仅 passed 运行可设、默认基线、归档） | ✅ | `#/regression`、`/api/v1/baselines` |
| 回归对比（10 类差异 + 归因 + `verdictBasis:"computed"`） | ✅ | `POST /api/v1/comparisons` |
| 运行进度推送（SSE + 轮询兜底） | ✅ | `GET /api/v1/runs/{id}/events` |
| Agent 交接：MCP 会话（工具白名单）/ CLI（命令白名单）/ init-agents 脚手架 | ✅ | `#/agents`、`/api/v1/mcp/*`、`/api/v1/cli/*`、`/api/v1/agents/*` |
| **三 harness 入口**（`claude`/`codex`/`deepseek`；`deepseek.officialLoop=null`） | ✅ | `GET /api/v1/agents/harnesses`（`/agents/loops` 已移除，任意方法返回 404） |
| **静态通用 skill**（`SKILL.md`+references+scripts+templates；用户自行放置） | ✅ | `skills/pw-auto-test/`、`scripts/verify.mjs`（只读自检） |
| 健康与元信息（版本、限制、能力开关） | ✅ | `#/health`、`/api/v1/meta` |

---

## 7. 依赖冻结与浏览器安装禁令（最高优先级纪律）

1. `package.json` 依赖段、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.base.json` 已冻结；**后续变更必须先报告 captain**，不得擅自安装或改动。
2. 禁止 `latest` / `^` / `~` 版本范围；禁止全局安装；代码内不写 `npx`（用 `createRequire().resolve('@playwright/test/cli.js')` 定位官方 CLI）。
3. **浏览器路径策略：沿用共享缓存 `%LOCALAPPDATA%\ms-playwright`（`chromium-1254` + `chromium_headless_shell-1254`）**，不设 `PLAYWRIGHT_BROWSERS_PATH`。
4. ⚠️ **禁止再执行 `playwright install` / `install-browser`**：官方安装器会 GC 掉「当前 registry 认为未使用」的浏览器目录（实测曾删除其他项目的 `chromium-1252`）。确需安装时先报告 captain，并在安装前后核对 `ms-playwright` 目录清单。
5. 无网/无 CfT 时可改用系统浏览器通道：`PW_BROWSER=chrome` 或 `msedge`（本机 Chrome/Edge 157 已安装）。

---

## 8. 已知限制（诚实清单）

| # | 限制 | 影响 / 说明 |
|---|---|---|
| L1 | Agent 页（`#/agents`）的脚手架提交**每次生成新的幂等键**（t27 复审 Low） | `POST /api/v1/agents/scaffolds` 若已成功但响应丢失，重试会创建第二个脚手架（额外文件写入），而不是幂等重放；运行对话框（`RunDialog`）已用稳定幂等键。非阻断项，下一轮统一 key 生命周期 |
| L2 | 单机单用户，**没有鉴权** | 默认只绑定 `127.0.0.1` + CORS 白名单；不要暴露到公网 |
| L3 | 不内置 LLM / 不做服务端自动规划修复 | 官方 Agent 定义本就不含模型调用；本框架只生成脚手架与提示词 |
| L4 | 未启用视觉基线（`toHaveScreenshot`） | 回归口径为「运行结果对比」；像素基线需同源环境基准，列入后续 |
| L5 | `--only-changed` 不可用 | 官方仅支持 Git；本工作区非 git 仓库 |
| L6 | MCP 只实现 `tools` 能力 | 官方服务端 `resources`/`prompts` 返回 `-32601`，本框架同样只做 `tools` |
| L7 | 前端构建有 >500 KB chunk 警告 | 非失败；后续按路由懒加载优化 |
| L8 | NL 生成需要外部 agent 领取任务；框架不产生 steps，也不评判业务语义 | 只校验结构与数据集列；未生成/生成中/失败时 `validate`/`run` 返回 `422 NL_NOT_GENERATED`。可用 `skills/pw-auto-test/scripts/agent-loop.mjs` 作确定性模拟 agent 跑通数据路径 |
| L9 | 对比接口返回「对比 + 首页 items」超集 | 便于前端一次拿全；分页取更多 items 走 `GET /api/v1/comparisons/{id}` |
| L10 | `meta.env.staticDir` 未启用静态托管时为空串 | 前端类型按合同为 string，不虚构路径 |
| L11 | 数据驱动用例**不带 `datasetId`** 做编译校验时，变量列无从校验 | 不带 `datasetId` 的 `POST /api/v1/cases/{id}/validate` 会返回 `ok:false` + `UNKNOWN_COLUMN`（因为此时没有任何列可对照，属预期语义，不是缺陷）；**带上 `datasetId` 即按启用行列做真实编译校验**（合法列 → `ok:true`；未知列 → `422 UNKNOWN_COLUMN`；全禁用 → `422 EMPTY_DATASET`）。修复前「带 `datasetId` 也误报」的问题已修 |
| L12 | 失败信息在**接口与产物中**保留 ANSI 转义序列 | 官方 reporter 输出原样入库（`\u001b[…m`），便于精确复现与粘贴；`errorHash` 计算前已剥离颜色码，因此指纹比较不受影响。**中文 Web UI 展示层已统一剥离**并提供「复制原始错误（含控制符）」入口；脚本/agent 消费时请自行 strip |

---

## 9. 安全提示

- 所有 API 响应**不含密钥**；产物下载走「DB 登记 + 工作区前缀 + 磁盘存在」三重校验，不支持任意路径读取。
- 请求体上限 1 MiB；CORS 精确白名单；子进程一律 `spawn(argv)`（`shell:false`），不做字符串拼接。
- 危险能力默认关闭：MCP **精确 unsafe 8 项**（`browser_run_code_unsafe`、`browser_evaluate`、`browser_mouse_move_xy`、`browser_mouse_click_xy`、`browser_mouse_drag_xy`、`browser_mouse_down`、`browser_mouse_up`、`browser_mouse_wheel`）与 CLI `run-code` / `eval` 需 `PW_ENABLE_UNSAFE_TOOLS=1` **且**请求体 `confirm:true`；集合之外的形似名字（如 `browser_mouse_teleport_xy`）一律 403，不按前缀放行。
- CLI 显式拒绝：`install`、`install-browser`、`attach`、`config-print`（副作用或未证实）。
- 官方原话提醒：Playwright MCP **不是**安全边界，`--allowed-origins` 不防重定向，`--secrets` 只是输出脱敏。本框架的安全边界在 API 层（本机绑定 + 白名单 + 受控目录），不依赖 MCP 自身。
- Windows 查看中文日志请用 `Get-Content <file> -Encoding UTF8`（PowerShell 5.1 默认按 ANSI 读取会乱码）。

---

## 10. 相关文档

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 本文件：定位、官方边界、启动与验收 |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | 普通用户完整操作流与失败排查 |
| [ARCHITECTURE.html](ARCHITECTURE.html) | 可交互项目架构图（NL-first + 三 harness + 静态 skill） |
| [SKILL_ARCHITECTURE.html](SKILL_ARCHITECTURE.html) | 通用 skill 架构图（SKILL.md 编排、脚本/模板、框架 API 与官方套件） |
| [PLAYWRIGHT_SUITE_ARCHITECTURE.html](PLAYWRIGHT_SUITE_ARCHITECTURE.html) | 官方 Playwright 套件能力架构图（Test / API / MCP / CLI / Agents / 证据） |
| [skills/pw-auto-test/SKILL.md](skills/pw-auto-test/SKILL.md) | 通用 agent skill：NL→官方 Agent→执行与回归 |