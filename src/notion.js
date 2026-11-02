// Notion API 封装：统一检查错误，提供属性和 block 的构造/读取工具。

const API = "https://api.notion.com/v1";
const VERSION = "2026-03-11";

export async function notion(env, path, method = "GET", body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      "Notion-Version": VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion ${res.status}: ${data.message || res.statusText}`);
  return data;
}

// 新版 API 中，记录属于数据源（data source），查询用数据源 ID 而不是数据库 ID
export const query = (env, dataSourceId, body) => notion(env, `/data_sources/${dataSourceId}/query`, "POST", body);

// 分页查询，最多翻 maxPages 页（每页 100 条，每页消耗一个子请求）
export async function queryAll(env, dataSourceId, body = {}, maxPages = 1) {
  const results = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const data = await query(env, dataSourceId, { ...body, page_size: 100, ...(cursor && { start_cursor: cursor }) });
    results.push(...data.results);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return results;
}

// 按 size 切分文本（Notion 单段文本上限 2000），不切断 emoji 等代理对
export function chunkText(s, size = 2000) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + size, s.length);
    if (end < s.length && /[\uD800-\uDBFF]/.test(s[end - 1])) end--;
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

export const truncate = (s, size) => chunkText(String(s), size)[0] || "";

export const richText = (s, url) =>
  chunkText(String(s)).map((content) => ({ type: "text", text: url ? { content, link: { url } } : { content } }));

// 写入属性
export const P = {
  title: (s) => ({ title: richText(s) }),
  text: (s) => ({ rich_text: richText(s) }),
  date: (start) => ({ date: { start } }),
  select: (name) => ({ select: { name } }),
  multi: (names) => ({ multi_select: names.map((name) => ({ name })) }),
  url: (url) => ({ url }),
  checkbox: (checked) => ({ checkbox: checked }),
  relation: (ids) => ({ relation: ids.map((id) => ({ id })) }),
};

// 读取属性
const plain = (items = []) => items.map((t) => t.plain_text).join("");
export const read = {
  title: (page, name) => plain(page.properties[name]?.title),
  text: (page, name) => plain(page.properties[name]?.rich_text),
  select: (page, name) => page.properties[name]?.select?.name || "",
  multi: (page, name) => (page.properties[name]?.multi_select || []).map((o) => o.name),
  date: (page, name) => page.properties[name]?.date?.start || "",
  url: (page, name) => page.properties[name]?.url || "",
};

// 页面正文 block。bullet 接受字符串或已构造好的 rich_text 数组
export const block = {
  h2: (s) => ({ type: "heading_2", heading_2: { rich_text: richText(s) } }),
  para: (s) => ({ type: "paragraph", paragraph: { rich_text: richText(s) } }),
  divider: () => ({ type: "divider", divider: {} }),
  bullet: (rich) => ({
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: typeof rich === "string" ? richText(rich) : rich },
  }),
};

// 长文本转成多个段落（单次请求最多 100 个 block）
export const paragraphs = (text) => chunkText(text).slice(0, 100).map(block.para);

// 网页正文转成段落：按行合并，每段不超过 2000 字，最多 max 段
export function lineBlocks(text, max = 100) {
  const out = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur && cur.length + line.length + 1 > 2000) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out.flatMap((s) => chunkText(s)).slice(0, max).map(block.para);
}
