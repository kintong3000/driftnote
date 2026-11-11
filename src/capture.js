// 统一捕获：所有入口（API、Telegram）最终都调用 capture()

import { ENTRY, LIMITS, STATUS, TYPES } from "./config.js";
import { enrich, webBlocks } from "./enrich.js";
import { notion, query, P, read, truncate, paragraphs } from "./notion.js";
import { localDateTime } from "./time.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const URL_RE = /https?:\/\/[^\s<>"'，。）】]+/;

/**
 * @param {object} input
 * @param {string} input.text    内容
 * @param {string} [input.url]   链接，不传则从内容里提取第一个
 * @param {string} [input.title] 标题，不传则取内容第一行
 * @param {string} [input.source]
 * @param {string} [input.type]  强制指定类型
 * @param {string} [input.id]    外部 ID，用于去重
 * @param {string} [input.time]  记录时间（ISO），默认当前
 * @param {string} [input.content] 网页正文（书签带来），写进页面正文并生成摘要，不进「内容」属性
 * @param {string} [input.contentHeading] 正文那一节的标题，默认「网页正文」
 * @param {boolean} [input.markdown] content 是 Markdown，按 Markdown 渲染
 * @param {boolean} [input.fetch] 传 false 时不抓取链接
 * @returns 其中 enriched 是后台补充网页内容的 Promise，没有链接时为 null
 */
export async function capture(env, input) {
  let text = String(input.text ?? "").trim();
  let type = TYPES.includes(input.type) ? input.type : "";

  // 内容以「#类型」开头时，按前缀归类并去掉前缀
  const prefix = text.match(/^#(\S+)\s*/);
  if (prefix && TYPES.includes(prefix[1])) {
    type ||= prefix[1];
    text = text.slice(prefix[0].length).trim();
  }

  const url = truncate(input.url || text.match(URL_RE)?.[0] || "", 2000);
  if (!text && !url) throw new HttpError(400, "内容为空");
  if (!text) text = url;

  const source = truncate(input.source || "api", 50);
  type ||= guessType(text, url, source);
  const title = truncate(String(input.title || "").trim() || text.split("\n")[0], 60);
  const externalId = input.id ? truncate(String(input.id), 200) : "";

  if (externalId) {
    const dup = await findByExternalId(env, externalId);
    if (dup) {
      return { page: dup, type: read.select(dup, ENTRY.type), title: read.title(dup, ENTRY.title), duplicate: true };
    }
  }

  const content = truncate(String(input.content ?? "").trim(), LIMITS.pageContentChars);

  const properties = {
    [ENTRY.title]: P.title(title),
    [ENTRY.time]: P.date(input.time || localDateTime()),
    [ENTRY.source]: P.select(source),
    [ENTRY.type]: P.select(type),
    [ENTRY.content]: P.text(truncate(text, 2000)),
    [ENTRY.status]: P.select(STATUS.inbox),
    [ENTRY.aiDone]: P.checkbox(false),
  };
  if (url) properties[ENTRY.url] = P.url(url);
  if (externalId) properties[ENTRY.externalId] = P.text(externalId);

  const parent = { type: "data_source_id", data_source_id: env.NOTION_ENTRIES_DS };
  let page;
  // Markdown 正文直接交给 Notion 渲染（标题、列表、代码块等）；太长或格式太复杂会被拒绝，退回按段落写纯文本
  if (content && input.markdown) {
    const heading = input.contentHeading || "网页正文";
    const markdown = `${text}\n\n---\n\n## ${heading}\n\n${content}`;
    page = await notion(env, "/pages", "POST", { parent, properties, markdown, markdown_version: "v2" }).catch(
      (err) => console.error("markdown page", err.message),
    );
  }
  if (!page) {
    // 单次请求最多 100 个 block、500KB，网页正文按字数截断，并给批注留 10 段
    const children = paragraphs(text).slice(0, content ? 10 : 100);
    if (content) children.push(...webBlocks(content, 100 - children.length, input.contentHeading));
    page = await notion(env, "/pages", "POST", { parent, properties, children });
  }

  // 有链接时在后台抓取网页、生成摘要；调用方负责等待（Telegram）或交给 ctx.waitUntil（API）
  // 长笔记里顺带提到的链接不抓，否则夜间 AI 读到的是网页摘要而不是笔记本身
  const fetchPage = linkIsMain(text, url) && !content && input.fetch !== false;
  const retitle = !input.title && !text.replace(url, "").trim();
  const enriched = content || fetchPage ? enrich(env, page.id, { url, content, fetchPage, retitle }) : null;
  return { page, type, title, duplicate: false, enriched };
}

// 粗分类型，夜间 AI 会再修正
function guessType(text, url, source) {
  if (source.endsWith("voice")) return "语音";
  if (linkIsMain(text, url)) return "链接";
  return "想法";
}

// 链接是记录的主体：去掉链接后只剩不到 80 字（批注、标题之类）
function linkIsMain(text, url) {
  return Boolean(url) && text.replace(url, "").trim().length < 80;
}

async function findByExternalId(env, externalId) {
  const data = await query(env, env.NOTION_ENTRIES_DS, {
    filter: { property: ENTRY.externalId, rich_text: { equals: externalId } },
    page_size: 1,
  });
  return data.results[0];
}
