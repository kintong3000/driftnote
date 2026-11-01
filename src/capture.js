// 统一捕获：所有入口（API、Telegram）最终都调用 capture()

import { ENTRY, STATUS, TYPES } from "./config.js";
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

  const page = await notion(env, "/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: env.NOTION_ENTRIES_DS },
    properties,
    children: paragraphs(text),
  });
  return { page, type, title, duplicate: false };
}

// 粗分类型，夜间 AI 会再修正
function guessType(text, url, source) {
  if (source.endsWith("voice")) return "语音";
  if (url && text.replace(url, "").trim().length < 80) return "链接";
  return "想法";
}

async function findByExternalId(env, externalId) {
  const data = await query(env, env.NOTION_ENTRIES_DS, {
    filter: { property: ENTRY.externalId, rich_text: { equals: externalId } },
    page_size: 1,
  });
  return data.results[0];
}
