# driftnote

把每天在手机、电脑、各个 AI 平台上的零散想法和看到的内容，收进 Notion，并由 AI 每天整理、每周回顾。

基于 Cloudflare Workers（含 Workers AI 和 Cron Triggers）+ Notion + Telegram Bot，全部在免费额度内运行。完整的设计方案见 [`personal_logging_workflow_v2.md`](personal_logging_workflow_v2.md)，这里是代码和部署步骤。

```
driftnote/
├── wrangler.toml          # Worker 配置：Workers AI 绑定、非机密变量、定时任务
├── src/
│   ├── index.js           # 路由 + 定时任务分发
│   ├── config.js          # ⭐ 类型、Tag 清单、Notion 属性名、各种上限
│   ├── prompts.js         # 日总结 / 周回顾的 prompt
│   ├── capture.js         # 统一捕获：类型前缀、粗分类型、去重、写入 Entries
│   ├── telegram.js        # Telegram 消息解析、语音转录、回复
│   ├── daily.js           # 日任务
│   ├── weekly.js          # 周任务
│   ├── llm.js             # Workers AI 封装
│   ├── notion.js          # Notion API 封装
│   ├── time.js            # 时区工具
│   └── capture-page.js    # 书签脚本的中转页面
└── clients/
    ├── note / note-retry  # 终端命令
    ├── bookmarklet.js     # 浏览器书签脚本
    └── claude-code-note.md  # Claude Code 的 /note 命令
```

接口：

| 路由 | 说明 |
|---|---|
| `POST /api/capture` | 统一捕获接口，header `X-Auth-Token` |
| `POST /api/run` | 手动触发定时任务：`{"job": "daily" \| "weekly", "today": "YYYY-MM-DD"}`，`today` 可省略 |
| `GET /capture` | 书签脚本的中转页面 |
| `POST /webhook/telegram` | Telegram webhook |

---

## 1. Notion

### 1.1 创建 Integration

1. 打开 https://www.notion.so/profile/integrations → 新建 Internal Integration
2. 复制 token（`ntn_` 开头），之后作为 `NOTION_API_KEY`

### 1.2 创建三个数据库

每个数据库都建成整页（Full page）数据库。**属性名必须和下表完全一致**（或者同步修改 `src/config.js`）。默认的标题列叫 `Name`，记得改名。

**Entries**

| 属性 | 类型 | 备注 |
|---|---|---|
| `标题` | Title | 由 `Name` 改名 |
| `时间` | Date | |
| `来源` | Select | 选项会自动创建 |
| `类型` | Select | 选项会自动创建 |
| `URL` | URL | |
| `内容` | Text | |
| `Tags` | Multi-select | 选项会自动创建 |
| `状态` | **Select** | 不要用 Notion 的 Status 类型，API 格式不一样 |
| `AI已处理` | Checkbox | |
| `外部ID` | Text | |

**Daily**

| 属性 | 类型 | 备注 |
|---|---|---|
| `日期` | Title | |
| `Date` | Date | |
| `记录` | Relation → Entries | 开启「在 Entries 上显示」，名称填 `日总结` |
| `摘要` | Text | |
| `条数` | Rollup | 关联 `记录`，计算方式选「计数 / Count all」 |

**Weekly**

| 属性 | 类型 | 备注 |
|---|---|---|
| `周` | Title | |
| `开始` | Date | |
| `结束` | Date | |
| `每日` | Relation → Daily | 开启「在 Daily 上显示」，名称填 `周回顾` |

### 1.3 授权和 ID

1. 三个数据库各自点右上角 `···` → 连接（Connections）→ 添加刚才的 Integration
2. 数据库 ID：打开数据库页面，链接 `notion.so/<工作区>/<32 位 ID>?v=...` 中 `?v=` 之前的 32 位字符串
3. 把三个 ID 填进 `wrangler.toml` 的 `[vars]`

### 1.4 视图（可选，但推荐）

在 Entries 上建：今天（List，`时间` 是今天，按时间升序）、收件匣（`状态` = 未处理）、链接库（Gallery，`类型` = 链接）、技术笔记（`类型` = 技术）、按主题（Board，按 `Tags` 分组）。

---

## 2. Telegram

1. 找 `@BotFather` 发 `/newbot`，拿到 Bot Token
2. 找 `@userinfobot` 发任意消息，拿到你的 user ID，填进 `wrangler.toml` 的 `MY_TG_USER_ID`
3. 先给 Bot 发一条 `/start`（否则 Bot 无法主动给你推送）

---

## 3. 部署 Worker

```bash
git clone https://github.com/kintong3000/driftnote.git && cd driftnote
npm install
npx wrangler login

# 机密配置（逐个输入）
npx wrangler secret put NOTION_API_KEY
npx wrangler secret put AUTH_TOKEN          # 用 openssl rand -hex 24 生成
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_WEBHOOK_SECRET   # 用 openssl rand -hex 24 生成

npx wrangler deploy
```

部署成功后会显示 Worker 地址，例如 `https://driftnote.<你的子域>.workers.dev`。

设置 Telegram webhook：

```bash
curl "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook" \
  -d url=https://driftnote.<你的子域>.workers.dev/webhook/telegram \
  -d secret_token=<TG_WEBHOOK_SECRET> \
  -d 'allowed_updates=["message"]'
```

查看实时日志：`npm run tail`

---

## 4. 各个入口

### 4.1 终端

```bash
mkdir -p ~/.local/bin
cp clients/note clients/note-retry ~/.local/bin/

# 写进 ~/.zshenv（不要提交到 dotfiles 仓库）
export NOTE_ENDPOINT="https://driftnote.<你的子域>.workers.dev"
export NOTE_TOKEN="<AUTH_TOKEN>"
# 确保 ~/.local/bin 在 PATH 里
export PATH="$HOME/.local/bin:$PATH"
```

可选：在 `~/.zshrc` 里加上启动提醒：

```bash
[ -s ~/.note_failed.jsonl ] && echo "⚠️ 有 $(wc -l < ~/.note_failed.jsonl | tr -d ' ') 条 note 发送失败，运行 note-retry 重发"
```

用法：`note "想法"`、`cmd | note`、`note -t 技术 "内容"`。依赖 `jq`（macOS 自带）。

### 4.2 浏览器

打开 `clients/bookmarklet.js`，替换 `EP` 和 `TK`，然后把从 `javascript:` 开始的整段代码粘贴到新书签的「网址」栏。

### 4.3 Claude Code

```bash
mkdir -p ~/.claude/commands
cp clients/claude-code-note.md ~/.claude/commands/note.md
```

在 Claude Code 里输入 `/note` 或 `/note 重点记一下 xxx`。

### 4.4 iOS 快捷指令

**A「存到日志」**（分享菜单）
1. 新建快捷指令 → 右上角「ⓘ」→ 打开「在共享表单中显示」，接收类型选 URL、文本、Safari 网页
2. 添加动作：
   1. 「获取 URL」：输入选「快捷指令输入」→ 结果重命名为 `链接`
   2. 「要求输入」：文本，提示「批注（可留空）」→ 重命名为 `批注`
   3. 「文本」：内容为 `批注`、换行、`快捷指令输入`
   4. 「获取 URL 内容」：
      - URL：`https://driftnote.<你的子域>.workers.dev/api/capture`
      - 方法：POST
      - 头部：`Content-Type` = `application/json`，`X-Auth-Token` = `<AUTH_TOKEN>`
      - 请求体：JSON，字段 `text` = 第 3 步的文本，`url` = `链接`，`source` = `ios-share`
   5. 「获取词典值」：键 `status`，词典选上一步的结果
   6. 「如果」词典值 是 `success` →「显示通知」✓ 已保存；否则 →「显示提醒」，内容选第 4 步的结果（会显示错误原因）

**B「语音速记」**
1. 「听写文本」（语言选中文）
2. 「获取 URL 内容」：同上，请求体 `text` = 听写文本，`source` = `ios-voice`
3. 同 A 的第 5、6 步
4. 绑定到操作按钮（设置 → 操作按钮 → 快捷指令）或轻点背面（设置 → 辅助功能 → 触控 → 轻点背面）

---

## 5. 验证

```bash
EP=https://driftnote.<你的子域>.workers.dev
TK=<AUTH_TOKEN>

# 捕获
note "测试记录"
printf '多行\n含"引号"' | note
python3 -c 'print("长"*3000)' | note

# 无 token → 401
curl -s -X POST $EP/api/capture -d '{}'

# 把今天的记录也纳入日任务：today 传明天
curl -s -X POST $EP/api/run -H "X-Auth-Token: $TK" -d '{"job":"daily","today":"2026-11-03"}'

# 周任务：today 传某个周一，回顾它的前一周
curl -s -X POST $EP/api/run -H "X-Auth-Token: $TK" -d '{"job":"weekly","today":"2026-11-02"}'
```

Telegram：发文字、语音、转发一条消息，都应该收到 `✓` 回复；发贴纸应该回复「暂不支持」。

---

## 6. 注意事项

- **Tag 清单、类型、属性名**都在 `src/config.js`，改完 `npx wrangler deploy` 即可。
- **子请求上限**：免费版每次调用最多 50 个子请求，日任务每条记录需要一次更新。一天超过约 40 条时，多出来的记录会在下次运行时补上标签（总结仍覆盖全部记录）。
- **CPU 时间**：免费版每次调用 10ms CPU（等待网络不计时）。如果日志里出现 `exceeded CPU` 错误，可能是语音太长或一次处理的记录太多，可以调小 `config.js` 里的 `LIMITS`，或升级 Workers Paid（$5/月）。
- **Workers AI 额度**：每天 10,000 Neurons，UTC 00:00 重置。用量在 Cloudflare 后台 → AI → Workers AI 查看。
- **模型名**可能随 Cloudflare 更新而变化，部署前在后台的模型列表确认 `wrangler.toml` 里的 `LLM_MODEL` / `STT_MODEL` 仍可用。
- **去重**依赖 Notion 查询，Notion 的索引有几秒延迟，极短时间内的重复请求仍可能写入两条。
