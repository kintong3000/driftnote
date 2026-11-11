// 所有可调整的配置集中在这里。
// Notion 里的属性名如果改了，只需同步修改下面的 ENTRY / DAILY / WEEKLY。

// 时区：北京时间（UTC+8，无夏令时）。只支持整小时的正偏移。
export const UTC_OFFSET_HOURS = 8;

// 必须和 wrangler.toml 里的 [triggers] crons 完全一致
export const CRON = {
  daily: "0 0 * * *", // 北京 08:00
  weekly: "30 0 * * 1", // 北京周一 08:30
};

export const TYPES = ["想法", "链接", "摘录", "AI对话", "技术", "待办", "语音"];

// AI 只能从这份清单里选标签，每条 0–3 个
export const TAGS = ["AI", "编程", "运维", "前端", "产品", "项目A", "学习", "阅读", "健康", "生活", "财务", "灵感孵化"];

export const STATUS = {
  inbox: "未处理",
  archived: "已归档",
  action: "转为行动",
  dropped: "丢弃",
};

// Notion 属性名
export const ENTRY = {
  title: "标题",
  time: "时间",
  source: "来源",
  type: "类型",
  url: "URL",
  content: "内容",
  summary: "摘要",
  tags: "Tags",
  status: "状态",
  aiDone: "AI已处理",
  externalId: "外部ID",
};

export const DAILY = {
  title: "日期",
  date: "Date",
  entries: "记录",
  summary: "摘要",
};

export const WEEKLY = {
  title: "周",
  start: "开始",
  end: "结束",
  dailies: "每日",
};

export const LIMITS = {
  subrequestBudget: 45, // 免费版每次调用最多 50 个子请求，留一点余量
  daysPerRun: 3, // 日任务一次最多处理几天的积压
  entriesPerDay: 100, // Notion 单次写入关联的上限
  charsPerEntryForAI: 500, // 每条记录给 AI 看的字数，避免超出上下文
  pageContentChars: 100000, // 书签保存的网页正文上限，中文约 300KB，低于 Notion 单次请求 500KB 的限制
  readerTimeoutMs: 20000, // Firecrawl 抓取网页的超时，超时就只存链接；后台处理总共约 30 秒，剩下的留给摘要
  tgTextFileBytes: 1024 * 1024, // Telegram 发来的文本文件（.md/.txt 等）超过这个大小只记文件名，不读内容
  summaryInputChars: 6000, // 生成网页摘要时给 AI 看的正文字数
  weeklyLines: 300, // 周回顾最多给 AI 看多少条记录标题
};
