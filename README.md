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
├── scripts/
│   └── setup-notion.mjs   # 检查 / 创建 Notion 数据库
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

### 1.2 把 Integration 连接到页面

Token 和 Connection 管的是两件事：
- **Token**：证明请求来自这个 Integration，相当于工牌
- **Connection**：允许这个 Integration 访问哪些页面，相当于门禁授权

Notion 默认不给 Integration 任何页面的权限。只有 token、没有连接时，所有页面对它来说都"不存在"，API 会返回 404 `object_not_found`。就算 token 泄露，别人也只能访问你连接过的页面。

连接方法（任选一种）：
- **在页面里**：打开页面 → 右上角 `···` → **连接（Connections）** → 添加连接 → 搜索 Integration 名称 → 确认
- **在 Integration 设置里**：https://www.notion.so/profile/integrations → 点进 Integration → **Access** 标签页 → 选择页面

连接会被子页面继承，所以只需要连接这一个父页面，脚本在它下面建的三个数据库自动有权限。如果在页面里找不到这个 Integration，检查它和页面是不是在同一个工作区。

### 1.3 用脚本创建三个数据库

1. 在 Notion 里新建一个空页面（例如叫 `driftnote`），把 Integration 连接到这个页面（见下方说明）
2. 复制 `.dev.vars.example` 为 `.dev.vars`，填上 `NOTION_API_KEY` 和 `NOTION_PARENT_PAGE`（页面右上角 `···` → 复制链接）
3. 运行：

   ```bash
   npm install
   npm run setup:notion
   ```

脚本会在这个页面下检查 Entries / Daily / Weekly 三个库：
- 已存在的直接复用，缺少的属性自动补上，标题列名字不对会自动改名
- 不存在的就新建，包括双向关联、「条数」统计和常用视图（见 1.5）
- 属性名存在但类型不对（例如「状态」用了 Notion 的 Status 类型）时只报错提示，不会改动已有属性
- 已存在的同名视图不会改动，所以你在 Notion 里手动调整过的视图不会被覆盖
- 三个**数据源 ID** 写进 `.dev.vars`；加上 `-- --secrets` 参数会同时上传为 Cloudflare secret（见第 3 节）

脚本可以重复运行。改了 `src/config.js` 里的属性名或标签清单后，再运行一次即可补上新属性。

> **数据库和数据源**：Notion API 从 2025-09-03 版开始，把数据库拆成两层。数据库只是容器，属性和记录属于其中的「数据源」（data source）。一个数据库可以有多个数据源，本项目每个库只用一个。Worker 查询和写入记录用的都是数据源 ID（`NOTION_*_DS`），它和数据库链接里的 ID 不是同一个。本项目使用 API 版本 `2026-03-11`。

### 1.4 数据库结构（供参考，也可以手动创建）

属性名必须和下表完全一致（或者同步修改 `src/config.js`）。

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

如果你手动建了库，同样运行一次 `npm run setup:notion`：它会按名称（Entries / Daily / Weekly）找到你建的库，补上缺少的部分，并把数据源 ID 写进 `.dev.vars`。前提是这三个库放在 `NOTION_PARENT_PAGE` 页面下面。

### 1.5 视图

由脚本自动创建：

| 所在库 | 视图 | 布局 | 筛选 / 排序 |
|---|---|---|---|
| Entries | 全部 | 表格 | 时间降序 |
| Entries | 今天 | 列表 | `时间` 是今天，升序 |
| Entries | 收件匣 | 表格 | `状态` = 未处理，时间降序 |
| Entries | 链接库 | 画廊 | `类型` = 链接，时间降序 |
| Entries | 技术笔记 | 列表 | `类型` = 技术，时间降序 |
| Entries | 按主题 | 看板 | 按 `Tags` 分组 |
| Daily | 日记 | 表格 | 日期降序 |
| Weekly | 周回顾 | 表格 | 开始日期降序 |

新建数据库时 Notion 会自带一个叫 Default view 的表格视图，脚本会把它改造成上表里该库的第一个表格视图，不会多出一个。视图的显示列、列宽等细节没有设置，按需在 Notion 里调整即可，脚本之后不会覆盖。

### 1.6 只能手动做的部分

- 新建父页面，并把 Integration 连接上去：API 不提供这个接口
- 创建 Integration 本身

---

## 2. Telegram

1. 找 `@BotFather` 发 `/newbot`，拿到 Bot Token
2. 找 `@userinfobot` 发任意消息，拿到你的 user ID，作为 `MY_TG_USER_ID`
3. 先给 Bot 发一条 `/start`（否则 Bot 无法主动给你推送）

---

## 3. 部署 Worker

```bash
git clone https://github.com/kintong3000/driftnote.git && cd driftnote
npm install
npx wrangler login

# 先部署一次，Cloudflare 上才有这个 Worker，之后才能设置 secret
npx wrangler deploy

# 配置（逐个输入）
npx wrangler secret put NOTION_API_KEY
npx wrangler secret put AUTH_TOKEN          # 用 openssl rand -hex 24 生成
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_WEBHOOK_SECRET   # 用 openssl rand -hex 24 生成
npx wrangler secret put MY_TG_USER_ID

# 三个数据源 ID：由脚本检查/创建后自动上传
npm run setup:notion -- --secrets
```

设置 secret 后 Worker 会自动使用新配置，不需要重新部署。

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
