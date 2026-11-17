# 三 harness 放置矩阵（pw-auto-test）

> 单一通用 skill、静态资产、**无安装器/无安装 API**。用户自行把整个 `pw-auto-test/` 目录复制到目标 harness 的 skills 根目录。
> 框架只读展示推荐路径（`GET /api/v1/agents/harnesses`），不复制、不落盘、不记录安装状态。

## 1. 能力来源与边界

| 项 | 值 |
|---|---|
| 唯一执行承重 | `@playwright/test@1.65.0`（框架内 `playwright test` / `mcp` / `cli` / `init-agents`） |
| skill 与框架的通道 | 仅 `pw-auto-framework` HTTP API（默认 `http://127.0.0.1:8787`） |
| 是否需要 harness 配 MCP | **否**（`requiresMcp:false`）；浏览器事实由框架托管的 `playwright mcp` 提供 |
| 是否调用模型 | 否（模型在 harness 内；框架和 skill 脚本都不调模型端点） |
| 是否安装器 | **无**（没有 `install.mjs`、`manifest.json`、`.pw-auto-skill.json`、`/api/v1/skills*`） |

## 2. durable 入口裁定（t47）

- **唯一 agent 入口**：`GET /api/v1/agents/harnesses`（恰 3 项 `claude/codex/deepseek`；`deepseek.officialLoop:null`；全部 `requiresMcp:false`；含 `skillPaths`）。
- `GET`/`POST /api/v1/agents/loops` **已永久移除**（任意方法 → `404 NOT_FOUND`）；不要再探测/兼容旧 6 loop，也不要依赖 `meta.loops`。
- `/api/v1/skills*` **永久 404**；本包无安装器、无安装 manifest、无安装态（t36/t47 durable 裁定）。
- `verify.mjs` 会把上述 404 作为自检项；框架重启/升级后仍应成立。

## 3. 推荐放置路径（用户手动复制）

| entry | harness | `officialLoop` | 推荐路径（任一即可） | 说明 |
|---|---|---|---|---|
| `claude` | Claude Code | `claude` | 项目：`<repo>/.claude/skills/pw-auto-test/`；个人：`~/.claude/skills/pw-auto-test/` | Claude Code 的 skill 发现路径使用 `.claude/skills/<name>/SKILL.md` |
| `codex` | Codex CLI | `codex` | 个人：`~/.codex/skills/pw-auto-test/`；项目：`<repo>/.codex/skills/pw-auto-test/`；共享：`~/.agents/skills/pw-auto-test/` | Codex skills 发现依据 openai/codex 仓库源码；`.agents/skills` 运行时加载待复核 |
| `deepseek` | DeepSeek Harness | **`null`** | 个人：`~/.dsh/skills/pw-auto-test/`；共享：`<repo>/.agents/skills/pw-auto-test/` | 官方 6 loop **没有** deepseek；不得写 `officialLoop:"deepseek"` 或伪造 agent 定义 |

复制示例（只由用户执行，框架不执行）：

```bash
# 以仓库根为基准；目标为个人 Claude 目录
cp -R skills/pw-auto-test ~/.claude/skills/pw-auto-test

# Codex 个人目录
cp -R skills/pw-auto-test ~/.codex/skills/pw-auto-test

# DeepSeek Harness 个人目录
cp -R skills/pw-auto-test ~/.dsh/skills/pw-auto-test
```

Windows PowerShell：

```powershell
Copy-Item -Recurse skills/pw-auto-test "$env:USERPROFILE\.dsh\skills\pw-auto-test"
```

## 3. 放置后的只读自检

```bash
node scripts/verify.mjs --api-base=http://127.0.0.1:8787
```

检查内容：
- `GET /api/health` 为 `ok`；
- `GET /api/v1/meta` 的 `versions.playwrightSource === "cli"`（fallback 必须显式 `--allow-fallback` 且会被标注）；
- `GET /api/v1/agents/harnesses` 恰 3 项：`claude/codex/deepseek`，`deepseek.officialLoop === null`，所有 `requiresMcp === false`；
- 本 skill 文件齐全、`SKILL.md ≤ 400` 行、无 `install.mjs`/manifest；
- `GET /api/v1/skills` 为 `404`（设计裁定：无安装 API）。

`verify.mjs` **只读**：不复制、不写入任何文件，也不读写 harness 目录。

## 4. 官方依据（研究记录）

- Claude Code skills：`https://docs.anthropic.com/en/docs/claude-code/skills`（`SKILL.md` + `.claude/skills` / `~/.claude/skills`）
- Playwright 官方 6 loops：`https://playwright.dev/docs/test-agents`（`claude|codex|copilot|opencode|vscode|vscode-legacy`；**无 deepseek**）
- 官方 skill 先例（实测）：`npx playwright init-skills --loop=claude|agents`（把官方 3 个 skill 装到 `.claude/skills` / `.agents/skills`）
- Codex skills：`https://github.com/openai/codex` 源码中的 skills 发现逻辑（`$CODEX_HOME/skills`、`.codex/skills`、`.agents/skills`）
- DeepSeek Harness：`~/.dsh/skills` 与 `.agents/skills` 为本机实测/强相关路径；`officialLoop:null`。

> 版本漂移提示：`SKILL.md` 顶部 `playwrightVersion: 1.65.0`。框架升级后由用户自行重新复制并更新该标注；框架不管理版本一致性。
