# 零散信息捕获系统 · 方案 v2

> 目标：把每天在手机、电脑、各个 AI 平台上产生的想法和看到的内容，用最低摩擦的方式收进同一个地方。不丢失、以后找得到，而且会被定期回看。
>
> 相对 v1 的主要变化：
> 1. 存储从「一天一页」改为「一条记录一行」
> 2. 新增手机分享菜单、AI 对话两类入口
> 3. 定时任务改用 Cloudflare Workers 自带的 Cron Triggers
> 4. 新增每周回顾
> 5. 修复 v1 代码里的安全和数据丢失问题
> 6. AI 总结和语音转录统一改用 Cloudflare Workers AI（免费额度），不再需要外部 API Key
>
> 已确认：手机为 iOS；时区 Asia/Shanghai；日报每天 08:00、周报周一 08:30。

---

## 1. 总体架构

```
 捕获入口                              中间件                               存储（Notion）
 ─────────                            ──────                              ────────────
 Telegram Bot（文字/语音/转发） ──┐                                      ┌─> 📥 Entries（每条记录一行）
 iOS 分享菜单 / 听写快捷指令 ─────┤                                      │
 终端 note 命令 ──────────────────┼──> Cloudflare Worker ────────────────┤
 浏览器书签脚本 ──────────────────┤    · 鉴权 / 去重 / 失败回报           │
 Claude Code /note 命令 ──────────┘    · 粗分类型、切分长文本              │
                                                                         │
                                       Cron Triggers（同一个 Worker）     │
                                       · 每天 08:00 → 打标签 + 日总结 ───┼─> 📅 Daily
                                       · 每周一 08:30 → 周回顾 ──────────┴─> 🗓 Weekly
                                                    │
                                                    └─> Telegram 推送到手机
```

原则：
- **入口越少越好**：所有入口都只调用同一个接口 `/api/capture`，Telegram 也只是在 Worker 内部转成同样的格式。
- **整理交给 AI，判断留给自己**：分类、标签、总结由 AI 在夜间完成；「这个想法要不要做」在每周回顾时由你决定。
- **失败必须让你看得见**：任何一个入口保存失败，都要明确提示，或者留在本地队列里等待重发。

---

## 2. Notion 数据结构

### 2.1 📥 `Entries`（所有原始记录）

| 属性 | 类型 | 谁来填 | 说明 |
|---|---|---|---|
| `标题` | Title | Worker → AI 改写 | Worker 先取第一行前 60 字；夜间 AI 改写成一句精炼的标题 |
| `时间` | Date（含时间） | Worker | 记录发生的时间，时区 Asia/Shanghai |
| `来源` | Select | Worker | `telegram` `ios-share` `ios-voice` `terminal` `browser` `claude-code` `chatgpt` `claude` `gemini` … |
| `类型` | Select | Worker 粗分 → AI 修正 | `想法` `链接` `摘录` `AI对话` `技术` `待办` `语音` |
| `URL` | URL | Worker | 内容里有链接时提取第一个 |
| `内容` | Text | Worker | 原文的前 2000 字，供 AI 批量读取（查询一次就能拿到，不用逐页读正文） |
| `Tags` | Multi-select | AI | 只能从固定清单中选（见 2.4） |
| `状态` | Select | 你（周回顾时） | `未处理`（默认）`已归档` `转为行动` `丢弃` |
| `AI已处理` | Checkbox | AI | 是否已经打过标签、算进日总结 |
| `日总结` | Relation → Daily | AI | 由 Daily 那边写入的双向关联 |
| `外部ID` | Text | Worker | `tg:<update_id>` 或客户端生成的 uuid，用来去重 |

**页面正文**存完整原文：长文本按 2000 字切成多个 paragraph；Telegram 转发的消息会附上原始来源。

### 2.2 📅 `Daily`（每日总结）

| 属性 | 类型 | 说明 |
|---|---|---|
| `日期` | Title | `2026-11-01` |
| `Date` | Date | |
| `记录` | Relation → Entries | 当天所有记录（双向） |
| `条数` | Rollup | count(记录) |
| `摘要` | Text | 总结的纯文本版，供周回顾直接读取 |
| `周回顾` | Relation → Weekly | |

正文：AI 生成的总结（核心产出 / 技术沉淀 / 想法 / 待办）。

### 2.3 🗓 `Weekly`（每周回顾）

| 属性 | 类型 | 说明 |
|---|---|---|
| `周` | Title | `2026-W44` |
| `开始` / `结束` | Date | |
| `每日` | Relation → Daily | 关联 7 个 Daily 页（不直接关联 Entries，因为一周可能超过 100 条，超出 API 单次写入关联的上限） |

正文：周回顾内容（见 5.2）。

#### 2.4 Tag 固定清单（初稿，请修改）

`AI` `编程` `运维` `前端` `产品` `项目A` `学习` `阅读` `健康` `生活` `财务` `灵感孵化`

规则：AI 只能从清单中选，每条 0–3 个。清单写在 Worker 的配置里，每月回顾一次再调整。

### 2.5 Notion 视图

| 视图 | 所在库 | 设置 | 用途 |
|---|---|---|---|
| 今天 | Entries | List，`时间 = 今天`，时间升序 | 替代 v1 的「流水记录」 |
| 收件匣 | Entries | `状态 = 未处理`，时间降序 | 周回顾时清理 |
| 链接库 | Entries | Gallery，`类型 = 链接` | |
| 技术笔记 | Entries | `类型 = 技术` | 查「上次那个坑怎么解的」 |
| 按主题 | Entries | Board，按 `Tags` 分组 | 看每个主题积累了多少 |
| 日记 | Daily | 日期降序 | 每天的回顾 |

---

## 3. 捕获入口

### 3.0 通用约定

**统一接口** `POST /api/capture`，header 带 `X-Auth-Token`：

```json
{
  "text":   "内容（必填，除非有 url）",
  "url":    "可选",
  "title":  "可选，浏览器传网页标题",
  "source": "terminal",
  "type":   "可选，强制指定类型",
  "id":     "可选，客户端生成的 uuid，用于去重和安全重发"
}
```

**类型前缀**（所有入口通用）：内容以 `#待办` `#技术` `#想法` 等开头时，直接设为对应类型，并去掉这个前缀。

**Worker 粗分规则**（AI 夜间会修正）：语音 → `语音`；有类型前缀 → 按前缀；有 URL 且文字很短 → `链接`；其余 → `想法`。

### 3.1 📱 Telegram Bot

适合：手机上随手记、语音、从其他 App 转发消息给 Bot。

| 消息类型 | 处理方式 |
|---|---|
| 文字 | 直接记录；从 entities 里提取 URL |
| 语音 | Workers AI 的 Whisper（`@cf/openai/whisper-large-v3-turbo`，`language=zh`）转录，类型设为 `语音` |
| 转发的消息 | 正文开头注明「转发自：xxx」 |
| 图片 / 文件 + caption | 第一阶段：记下 caption，并标注 `[图片]`；第二阶段：通过 Notion 文件上传 API 存原图 |
| 其他类型 | 回复「暂不支持该类型」，不静默丢弃 |

Bot 回复示例：`✓ 想法 · 新项目移动端入口先做 TG Bot` 或 `❌ 保存失败：Notion 401，请重发`

### 3.2 📱 iOS 分享菜单（快捷指令）

适合：在 Safari、X、小红书、ChatGPT/Claude App 等任何能「分享」的地方，一键存下链接或文字。

**快捷指令 A「存到日志」**（在共享表单中显示，接收 URL、文本、Safari 网页）：
1. 「获取快捷指令输入中的 URL」→ 变量 `链接`
2. 「要求输入」：文本，提示「批注（可留空）」→ 变量 `批注`
3. 「文本」：`批注` + 换行 + `快捷指令输入`
4. 「获取 URL 的内容」：
   - URL：`https://<worker>/api/capture`，方法 POST
   - 头部：`Content-Type: application/json`、`X-Auth-Token: <token>`
   - 请求体 JSON：`text` = 第 3 步的文本，`url` = `链接`，`source` = `ios-share`
5. 「如果」请求失败 →「显示提醒」保存失败；否则 →「显示通知」✓ 已保存

**快捷指令 B「语音速记」**：
「听写文本」→ POST（`source` = `ios-voice`）→ 通知。
可以绑定到操作按钮、轻点背面或锁屏小组件，**不用解锁、不用打开任何 App**。iOS 自带听写就能识别中文，不需要服务器转录，也不消耗 Workers AI 额度。

> 微信内的文章没有系统分享入口：先点「复制链接」再分享，或者转发给 Telegram Bot。

### 3.3 💻 终端：`note` 命令

做成**独立脚本**，而不是 zsh 函数。这样 Claude Code、Cursor、cron 等任何地方都能调用。

`~/.local/bin/note`（记得 `chmod +x`）：

```bash
#!/usr/bin/env bash
# 用法：note "内容"  |  cmd | note  |  note -t 技术 "内容"
set -euo pipefail
: "${NOTE_ENDPOINT:?未设置 NOTE_ENDPOINT}" "${NOTE_TOKEN:?未设置 NOTE_TOKEN}"

type=""
if [ "${1:-}" = "-t" ]; then type="$2"; shift 2; fi
if [ $# -gt 0 ]; then content="$*"; elif [ ! -t 0 ]; then content="$(cat)"; else content=""; fi
[ -z "$content" ] && { echo "用法：note [-t 类型] <内容>  或  cmd | note" >&2; exit 1; }

payload=$(jq -n --arg t "$content" --arg ty "$type" \
  --arg s "${NOTE_SOURCE:-terminal}" --arg id "$(uuidgen)" \
  '{text: $t, source: $s, id: $id} + (if $ty == "" then {} else {type: $ty} end)')

# 后台发送，失败的写进本地队列
( curl -sf -m 15 -X POST "$NOTE_ENDPOINT/api/capture" \
    -H "Content-Type: application/json" -H "X-Auth-Token: $NOTE_TOKEN" \
    -d "$payload" >/dev/null \
  || printf '%s\n' "$payload" >> "$HOME/.note_failed.jsonl" ) &
echo "✓ queued"
```

`~/.local/bin/note-retry`（重发失败的记录。带着原来的 id 重发，所以不会重复）：

```bash
#!/usr/bin/env bash
set -uo pipefail
f="$HOME/.note_failed.jsonl"; [ -s "$f" ] || { echo "没有待重发的记录"; exit 0; }
tmp=$(mktemp)
while IFS= read -r line; do
  curl -sf -m 15 -X POST "$NOTE_ENDPOINT/api/capture" \
    -H "Content-Type: application/json" -H "X-Auth-Token: $NOTE_TOKEN" \
    -d "$line" >/dev/null || printf '%s\n' "$line" >> "$tmp"
done < "$f"
mv "$tmp" "$f"
echo "剩余失败：$(wc -l < "$f" | tr -d ' ') 条"
```

在 `~/.zshenv` 中设置环境变量（不要提交到 dotfiles 仓库）：

```bash
export NOTE_ENDPOINT="https://<worker>.workers.dev"
export NOTE_TOKEN="<token>"
```

可以在 `~/.zshrc` 里加一行：终端启动时如果 `~/.note_failed.jsonl` 不为空，就提醒你运行 `note-retry`。

### 3.4 🌐 浏览器书签脚本

选中文字（可选）→ 点击书签 → 输入批注 → 保存。遇到 CSP 严格、会拦截请求的网站（GitHub、X 等），自动改为打开 Worker 自己的中转页面来提交。

```javascript
javascript:(function(){
  const EP = "https://<worker>.workers.dev", TK = "<token>";
  const sel = getSelection().toString().trim();
  const note = prompt("批注（可留空）：", "");
  if (note === null) return;
  const p = {
    text: [note, sel && "> " + sel].filter(Boolean).join("\n\n") || document.title,
    url: location.href, title: document.title, source: "browser"
  };
  fetch(EP + "/api/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Token": TK },
    body: JSON.stringify(p)
  }).then(r => { if (!r.ok) throw 0; alert("✓ 已保存"); })
    .catch(() => window.open(EP + "/capture#" + encodeURIComponent(JSON.stringify({ ...p, token: TK }))));
})();
```

`GET /capture` 由 Worker 返回一个极简页面：读取 URL `#` 后面的数据（hash 不会发送到服务器，也不会进日志），再同源 POST 到 `/api/capture`，并显示结果。

> 书签会随浏览器账号同步，相当于 token 也存在了浏览器账号里。这个风险可以接受；如果 token 泄露，换一个即可。

### 3.5 🤖 AI 对话

AI 对话的价值在**结论**，而不是整段聊天记录。所以策略是：**结论进 Notion，原始记录做冷备份**。

**① 网页版或 App（ChatGPT / Claude / Gemini 等）**
1. 对话结束时，让 AI 帮你整理：
   ```text
   把这次对话整理成一条笔记：开头一句话说结论，然后是关键要点、命令或代码、还没解决的问题。不超过 15 行，不要寒暄。
   ```
2. 复制它的回复：
   - **手机**：通过分享菜单走快捷指令 A，或者粘贴给 Telegram Bot
   - **电脑**：在聊天页选中这段回复，点书签脚本，会自动带上对话的 URL
3. 内容以 `#AI对话` 开头即可强制归类。

**小技巧**：把上面的 prompt 设成手机的「文本替换」（例如输入 `zzjl` 自动展开），在任何 AI App 里都能一秒调出来。

**② Claude Code**

`~/.claude/commands/note.md`：

```markdown
---
description: 把本次对话的结论记到个人日志
---
把本次会话中值得长期保留的内容整理成一条笔记：开头一句话说结论，然后是关键要点、命令或代码、还没解决的问题。不超过 15 行。
$ARGUMENTS

然后用 Bash 执行（用 heredoc 传入，避免引号问题）：
NOTE_SOURCE=claude-code note -t AI对话 <<'EOF'
<整理好的内容>
EOF
```

在会话中输入 `/note` 或 `/note 重点记一下数据库选型的理由` 即可。
**Cursor**：在终端里直接用 `note`，或者让 Agent 执行同样的命令。

**③ 每月冷备份**（防止平台删除记录或账号出问题，不导入 Notion）
- ChatGPT：设置 → 数据控制 → 导出数据
- Claude：设置 → 隐私 → 导出数据
- Gemini：Google Takeout
- 统一存到一个文件夹（或 R2），每月 1 号由 Daily 推送顺便提醒你一次

---

## 4. Worker 设计

### 4.1 路由

| 路由 | 方法 | 鉴权 | 作用 |
|---|---|---|---|
| `/api/capture` | POST / OPTIONS | `X-Auth-Token` | 统一捕获接口，带 CORS 头 |
| `/capture` | GET | 无（页面本身不含数据） | 书签脚本的中转页面 |
| `/webhook/telegram` | POST | `X-Telegram-Bot-Api-Secret-Token` | Telegram 消息 |
| `/api/run` | POST | `X-Auth-Token` | 手动触发日任务 / 周任务，用于测试和补跑 |
| `scheduled()` | Cron | — | 根据 `event.cron` 区分日任务和周任务 |

### 4.2 代码结构（用 wrangler 部署）

> 已实现，代码就在本仓库，部署步骤见 `README.md`。实际结构比下面多了 `prompts.js`、`time.js`、`capture-page.js` 和 `clients/` 目录。

```
driftnote/
├── wrangler.toml
└── src/
    ├── index.js      # 路由 + scheduled 分发
    ├── capture.js    # 规范化输入、类型粗分、去重、写入 Entries
    ├── telegram.js   # 解析消息、语音转录、回复
    ├── notion.js     # Notion API 封装（统一检查错误、切分长文本、Markdown 转 block）
    ├── llm.js        # Workers AI 封装（env.AI.run，解析 JSON 输出）
    ├── daily.js      # 日任务
    ├── weekly.js     # 周任务
    └── config.js     # Tag 清单、时区、prompt
```

`wrangler.toml` 的 Workers AI 绑定和定时任务部分：

```toml
[ai]
binding = "AI"    # 代码中通过 env.AI.run(model, input) 调用，不需要 API Key

[vars]
LLM_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8"
STT_MODEL = "@cf/openai/whisper-large-v3-turbo"

[triggers]
crons = [
  "0 0 * * *",    # 每天 UTC 00:00 = 北京 08:00 → 日任务
  "30 0 * * 1"    # 每周一 UTC 00:30 = 北京 08:30 → 周任务
]
```

### 4.3 环境变量（用 `wrangler secret put` 设置）

| 变量 | 说明 |
|---|---|
| `NOTION_API_KEY` | Notion Internal Integration Token |
| `NOTION_ENTRIES_DB` / `NOTION_DAILY_DB` / `NOTION_WEEKLY_DB` | 三个数据库的 ID |
| `AUTH_TOKEN` | `/api/capture` 的鉴权 token（`openssl rand -hex 24` 生成） |
| `TG_BOT_TOKEN` | Telegram Bot Token |
| `TG_WEBHOOK_SECRET` | 设置 webhook 时传入的 secret_token |
| `MY_TG_USER_ID` | 你的 Telegram ID（同时也是推送消息的 chat_id） |


`LLM_MODEL`、`STT_MODEL` 不是机密，写在 `wrangler.toml` 的 `[vars]` 里即可。Workers AI 通过 `[ai]` 绑定调用，不需要 API Key。

### 4.4 Workers AI 的使用

**额度**：免费版每天 10,000 Neurons，每天 UTC 00:00（北京 08:00）重置。按 Qwen3-30B-A3B 大约每百万输入 token 4,625 Neurons、每百万输出 token 30,475 Neurons 估算：

| 任务 | 估算用量 | 每次 Neurons |
|---|---|---|
| 日总结 | 40 条，输入约 2 万 token，输出约 3 千 token | 约 200 |
| 周回顾 | 输入约 1.5 万 token，输出约 3 千 token | 约 160 |
| 语音转录 | 每分钟语音 | 几十 |

所以日常使用只会用到额度的几个百分点。计费单位和价格以 [官方定价页](https://developers.cloudflare.com/workers-ai/platform/pricing/) 为准。

**模型选择**：
- 默认用 `@cf/qwen/qwen3-30b-a3b-fp8`：中文能力好，速度快，消耗低。
- 如果对总结效果不满意，可以改 `LLM_MODEL` 换成更大的模型（例如 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`，但中文偏弱、消耗更高）。部署前先在 Cloudflare 后台的模型列表确认模型名还可用。

**注意事项**：
- **上下文窗口有限**：日任务给 LLM 的每条记录截取前 500 字，周任务只给标题和 Tags，避免超出上下文。
- **输出不一定是合法 JSON**：Qwen3 可能先输出 `<think>…</think>` 思考内容。prompt 末尾加 `/no_think`，解析时去掉 `<think>` 块，再提取第一个 `{…}`；解析失败就重试一次，仍然失败时只发送纯文本总结，不更新标签（这些记录第二天会被补上）。
- **额度用完**：调用失败时，日任务推送「⚠️ AI 额度不足，今日总结跳过」。因为只查询 `AI已处理 = false` 的记录，第二天会自动补处理。

### 4.5 可靠性和安全

- **鉴权**：capture 接口校验 token；Telegram 接口校验 secret header，并且只接受 `MY_TG_USER_ID`。
- **错误处理**：Notion、Telegram 的每个请求都检查 `res.ok`，Workers AI 调用用 try/catch，失败就抛错。capture 接口返回 5xx 和错误原因；Telegram 回复 ❌ 和原因。
- **去重**：写入前按 `外部ID` 查询一次，已存在就直接返回成功。所以 Telegram 重试、`note-retry` 重发都是安全的。
- **Telegram 超时**：先完成写入再返回 200；转录或写入很慢时，用 `ctx.waitUntil` 先返回 200，结果通过回复消息告诉你。
- **长度限制**：Notion 单段 2000 字自动切分；Telegram 回复超过 4096 字截断。
- **时间**：统一用 `Intl.DateTimeFormat` + `timeZone: "Asia/Shanghai"` + `hourCycle: "h23"`。

---

## 5. 定时任务

### 5.1 日任务（每天北京 08:00）

处理**前一天**（北京时间 00:00–24:00）的全部记录。早上 8 点处理，不会漏掉深夜的记录，而且早上看回顾比半夜看更有用。

1. **查询** Entries：`时间` 在昨天范围内（只读属性，`内容` 字段已包含原文，不需要逐页读正文）。
2. **调用 LLM**，返回 JSON：
   ```json
   {
     "entries": [{ "id": "...", "title": "...", "type": "技术", "tags": ["运维"] }],
     "summary": {
       "highlights": ["核心产出 / 解决的问题"],
       "tech":       ["技术踩坑、关键命令或参数"],
       "ideas":      ["值得继续想的想法"],
       "todos":      ["待办与明日跟进"]
     }
   }
   ```
   Prompt 要点：Tags 只能从清单中选；保留专有名词和参数；没有内容的分类返回空数组，不要编造。
3. **逐条更新** Entries：标题、类型、Tags，并勾上 `AI已处理`。
4. **创建** Daily 页面：正文是总结，`摘要` 存纯文本版，`记录` 关联当天所有条目（单次最多 100 条）。
5. **推送到 Telegram**：
   ```
   📅 11-01 回顾 · 共 23 条
   ✅ 定位 Nginx 502：php-fpm listen.backlog 满了
   💡 新项目移动端入口先做 TG Bot
   📌 待办：给域名续费
   → 打开 Notion
   ```
   当天没有任何记录时，不创建页面，也不推送。

### 5.2 周任务（每周一北京 08:30）

覆盖上周一到周日。

1. 读取上周 7 个 Daily 的 `摘要`。
2. 读取上周所有 Entries 的标题、类型和 Tags（不读全文，控制 token 用量）。
3. 读取收件匣积压：`状态 = 未处理` 且早于 7 天前的条目。
4. **旧笔记呼应**：取本周最多的 3 个 Tag，各随机抽 2 条 30 天以前的同 Tag 记录。
5. 调用 LLM 生成周回顾：
   - **本周主题**：把记录聚成 3–5 个主题，每个主题一句话说明在做什么、进展到哪
   - **反复出现的想法**：一周内出现两次以上的念头，通常值得认真对待
   - **建议推进的 3 件事**：附上理由
   - **收件匣待决定**：列出积压最久的 10 条，建议每条该归档、转为行动还是丢弃
   - **旧笔记呼应**：「三个月前你记过……，和本周的 X 相关」
6. 创建 Weekly 页面，关联 7 个 Daily，推送到 Telegram。

**周回顾的人工部分（约 15 分钟）**：打开 Notion「收件匣」视图，参考 AI 的建议，把每条的 `状态` 改掉。**这一步才是让系统产生价值的关键**，否则它只是一个写进去就不再看的仓库。

### 5.3 子请求上限

Cloudflare Workers 免费版每次调用最多 50 个子请求（以官方文档为准）：

- 日任务约需 `条数 + 5` 个请求。一天超过约 40 条时，超出的部分不更新标签，第二天补上（只查询 `AI已处理 = false` 的记录，所以不会遗漏）。总结本身仍然覆盖全部记录。
- 周任务约 15 个请求，不受影响。
- 如果经常超出，Workers Paid（$5/月）的上限是 1000。

---

## 6. 费用

| 模块 | 服务 | 月费用 |
|---|---|---|
| 存储 | Notion Free（个人版不限 block） | ¥0 |
| 中间件 + 定时任务 | Cloudflare Workers Free（每日 10 万次请求，Cron 免费） | ¥0 |
| 手机入口 | Telegram Bot + iOS 快捷指令 | ¥0 |
| 语音转录 | Workers AI Whisper（iOS 听写不需要） | ¥0 |
| AI 整理 | Workers AI 免费额度（每天 10,000 Neurons，实际用量约 2–5%） | ¥0 |

---

## 7. 实施步骤

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **1. Notion**（15 分钟） | 建 3 个库和属性、建视图、建 Integration 并共享给 3 个库 | 手动在每个库各新增一行，正常 |
| **2. Worker 捕获**（30 分钟） | 部署 capture 和 telegram 路由，设置 secrets 和 webhook | 见下方测试清单 |
| **3. 各个入口**（30 分钟） | note 脚本、书签脚本、iOS 快捷指令 A/B、Claude Code `/note` | 每个入口都成功写入一条 |
| **4. 日任务**（30 分钟） | 部署 daily，用 `wrangler dev --test-scheduled` 手动触发 | Daily 页生成、标签已回写、TG 收到推送 |
| **5. 周任务** | 部署 weekly，积累一周数据后手动触发 | Weekly 页生成、TG 收到推送 |
| **6. 第二阶段（可选）** | 图片存储、链接正文抓取、D1 原始备份 | — |

**阶段 2 测试清单**：
- [ ] `note "测试"` 能写入；`echo "多行\n含\"引号\"" | note` 内容完整
- [ ] 断网时执行 `note` → 内容进入 `~/.note_failed.jsonl`；恢复网络后 `note-retry` 补发成功，不重复
- [ ] 一段超过 3000 字的文本能完整写入
- [ ] 在 GitHub 页面点书签脚本 → 自动走中转页面并保存成功
- [ ] TG 发文字、语音、转发消息都能写入；发贴纸会回复「暂不支持」
- [ ] 不带 secret header 直接 POST webhook → 401
- [ ] 在 Notion 撤销 Integration 后发消息 → TG 回复 ❌

---

## 8. 需要你确认的事项

已确认：~~时区~~ Asia/Shanghai · ~~推送时间~~ 08:00 / 周一 08:30 · ~~手机~~ iOS · ~~总结模型~~ Workers AI

还需要确认：

1. **Tag 清单**（2.4）：请增删，特别是把「项目A」换成你实际在做的项目。
2. **语音转录也用 Workers AI**（替代 Groq，少一个外部 Key），可以吗？
3. **可选功能**，要不要放进第一阶段：
   - [ ] **D1 原始备份**：Worker 同时把原文写进 Cloudflare D1。Notion 出问题时数据也还在，并且可以随时导出（免费，多一点代码）
   - [ ] **链接正文抓取**：日任务顺便抓取链接的标题和正文摘要写进正文，防止链接失效
   - [ ] **私密前缀**：以 `!private` 开头的记录不发送给 AI，只存档
   - [ ] **图片存储**：TG 图片存进 Notion
