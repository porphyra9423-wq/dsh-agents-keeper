# dsh-agents-keeper

[English](#english) · [中文](#中文)

---

## 中文

让工作区的 `AGENTS.md` 跟着项目一起长大、一起瘦身。

DeepSeek Harness 内置的 `@deepseek-ai/dsh-agent-instructions` 已经把 `AGENTS.md` / `CLAUDE.md` 送进每次会话——但它**只负责读，不负责维护**，而且内容超过预算时只会丢弃或截断，从不调用模型总结。`dsh-agents-keeper` 补上后半段：

1. **发现真实变更**：`git status` / `git diff` 优先，没有 git 时退回目录 mtime 指纹。
2. **后台起草**：起一个子代理读项目（README、manifest、目录结构、真实脚本、CI），把**完整的**新版 `AGENTS.md` 写进插件状态目录，不碰用户仓库。
3. **先看 diff 再写**：`agents_md_apply` 会先打印 unified diff，写入前自动备份，写入用临时文件 + rename 原子完成。
4. **随时回滚**：`agents_md_revert` 按备份索引恢复上一版。
5. **智能精简**：`compact` 模式让子代理重写成更短的版本，保留骨架与仍然为真的事实，删掉过时细节。

### 安装

```bash
# 在 DeepSeek Harness 的插件管理里安装本地目录，或
dsh plugin install dsh-agents-keeper
```

装上后插件会自动注册 4 个工具、4 条命令，并在设置页加一栏「工作区指南」。

### 工具（给模型用）

| 工具 | 作用 |
| --- | --- |
| `agents_md_status` | 报告 `AGENTS.md` 路径、大小/预算、上次同步时间、自那以后真实变更的文件、是否值得更新、是否有待审提案 |
| `agents_md_propose` | `mode: "update"` 合并新事实；`mode: "compact"` 精简重写。子代理把完整新文件写到 pending 路径，**不改** `AGENTS.md` |
| `agents_md_apply` | 打印 diff → 备份 → 原子写入 → 记录同步。只在用户于对话中确认后调用 |
| `agents_md_revert` | `index: 0` 恢复最近一次写入前的备份，`1` 再往前一份，以此类推 |

### 命令（给人用）

| 命令 | 作用 |
| --- | --- |
| `/agents-status` | 同上，纯文本报告，不打扰模型 |
| `/agents-sync` | 起草更新版（等价 `agents_md_propose mode=update`） |
| `/agents-compact` | 起草精简版（等价 `agents_md_propose mode=compact`） |
| `/agents-revert [index]` | 从备份恢复 |

### 设置页

「工作区指南」一栏显示当前文件、大小对预算、上次同步、工作树变化、待审提案，并提供刷新 / 查看提案 diff / 应用 / 撤销按钮。生成预览需要会话里的 agent，所以按钮会提示你回到对话里用 `/agents-sync` 或 `/agents-compact`——HTTP 平面没有 agent，插件不会偷偷绕过这一点。

### 状态与隐私

所有状态都放在 `$DSH_HOME/agents-keeper/projects/<路径哈希>/` 下：

```
state.json          上次同步时间、文件哈希、字节数
pending.md          子代理起草的完整新版
pending.json        提案元数据（模式、发起时间、子代理 id、变更数）
backups/            每次写入前的备份，保留最近 20 份
history/            每次应用的提案原件
```

**不会**往你的仓库里写任何东西，除了你确认应用的 `AGENTS.md` 本身。

### 配置

`cordis.patch.yml` 里的默认值：

```yaml
config:
  maxBytes: 65536          # 与内置加载器的预算一致，超过会提示精简
  minIntervalMinutes: 30   # 距上次同步多久才觉得"值得更新"
  minChangedFiles: 3       # 至少多少个文件变了才觉得"值得更新"
  targetFile: AGENTS.md    # 要维护的文件名
  provider: spawn          # 子代理 provider
  agentPreset: ""          # 给子代理用的 agent preset，空 = 继承
  note: ""                 # 每次提案都会带上的额外指令
```

### 行为边界

- 工作区里**没有** `AGENTS.md`：只报状态，不创建、不打扰。
- 只提醒、不自动改：判断「值得更新」后也只是给你一个信号，起草必须由你或模型显式发起。
- 写入前一定备份，diff 一定先给你看。
- 遵循内置加载器的口径：它读什么文件、按多少字节裁剪，这里就维护什么文件、按多少字节提醒。

---

## English

Keeps your workspace `AGENTS.md` in step with the project — and keeps it short.

DeepSeek Harness ships `@deepseek-ai/dsh-agent-instructions`, which loads `AGENTS.md` / `CLAUDE.md` into every session. That plugin **reads but never maintains**, and when content exceeds its byte budget it silently drops or truncates files instead of summarizing them. `dsh-agents-keeper` covers the other half:

- **Detect real changes** — `git status` / `git diff` first, mtime fingerprints when there is no git.
- **Draft in the background** — a subagent studies the project (README, manifest, directory layout, real scripts, CI) and writes a complete new `AGENTS.md` into the plugin state directory, never into your repo.
- **Diff before write** — `agents_md_apply` prints a unified diff, backs up the current file, then writes atomically via temp file + rename.
- **Revert anytime** — `agents_md_revert` restores any of the last 20 backups.
- **Compaction that understands content** — `compact` mode rewrites the file shorter, keeping the skeleton and every fact that is still true.

### Install

```bash
dsh plugin install dsh-agents-keeper
```

The bundle registers four tools, four commands, and a "Workspace guide" settings section.

### Tools

| Tool | Purpose |
| --- | --- |
| `agents_md_status` | Path, size vs. budget, last sync, files changed since then, whether an update is worth proposing, pending proposal |
| `agents_md_propose` | `update` merges new facts, `compact` rewrites shorter. Writes the full proposal to a pending path; never touches `AGENTS.md` |
| `agents_md_apply` | Diff → backup → atomic write → record sync. Call only after the user agreed in conversation |
| `agents_md_revert` | `index: 0` restores the most recent backup, `1` the one before, and so on |

### Commands

`/agents-status`, `/agents-sync`, `/agents-compact`, `/agents-revert [index]`.

### Settings section

Shows the file, size against budget, last sync, working-tree changes, and any pending proposal, with refresh / view diff / apply / revert buttons. Drafting needs a live agent, so the buttons point you back to `/agents-sync` or `/agents-compact` in the conversation instead of pretending an HTTP route can spawn one.

### State

Everything lives under `$DSH_HOME/agents-keeper/projects/<path-hash>/`: `state.json`, `pending.md`, `pending.json`, `backups/` (20 most recent), `history/`. Nothing is written into your repository except the `AGENTS.md` you explicitly apply.

### Config

```yaml
maxBytes: 65536
minIntervalMinutes: 30
minChangedFiles: 3
targetFile: AGENTS.md
provider: spawn
agentPreset: ""
note: ""
```

### Boundaries

- No `AGENTS.md` in the workspace? It reports that and does nothing else.
- It never auto-edits; "worth updating" only produces a signal.
- Every write is backed up and every diff is shown first.

## License

MIT
