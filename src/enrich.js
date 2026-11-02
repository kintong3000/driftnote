// 记录写入后在后台补充网页内容：抓取正文（书签已带正文时跳过）→ AI 摘要写进「摘要」属性 → 正文追加到页面。
// 任何一步失败都不影响已保存的记录。

import { ENTRY, LIMITS } from "./config.js";
import { chatJSON } from "./llm.js";
import { notion, P, block, lineBlocks, truncate } from "./notion.js";
import { SUMMARY_PROMPT } from "./prompts.js";
import { readPage } from "./reader.js";

// 页面正文里「网页正文」这一节
export const webBlocks = (content, max) => [block.divider(), block.h2("网页正文"), ...lineBlocks(content, max - 2)];

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.content]  书签带来的正文，已在创建记录时写进页面
 * @param {boolean} opts.fetchPage 是否用 Jina 抓取
 * @param {boolean} opts.retitle   标题只是链接时，换成网页标题
 * @returns {Promise<{fetched: boolean, summary: string, title: string}>}
 */
export async function enrich(env, pageId, { url, content, fetchPage, retitle }) {
  const result = { fetched: false, summary: "", title: "" };
  let pageTitle = "";
  if (fetchPage) {
    const page = await readPage(env, url);
    if (!page) return result;
    pageTitle = page.title;
    content = truncate(page.content, LIMITS.pageContentChars);
    result.fetched = true;
  }
  if (!content) return result;

  // 摘要失败时照样追加正文，夜间 AI 还能看到「内容」
  try {
    const ai = await chatJSON(env, SUMMARY_PROMPT, truncate(content, LIMITS.summaryInputChars));
    result.summary = String(ai.summary || "").trim();
  } catch (err) {
    console.error("summary", url, err.message);
  }

  const properties = {};
  if (result.summary) properties[ENTRY.summary] = P.text(truncate(result.summary, 2000));
  if (retitle && pageTitle) {
    result.title = truncate(pageTitle, 60);
    properties[ENTRY.title] = P.title(result.title);
  }
  if (Object.keys(properties).length) await notion(env, `/pages/${pageId}`, "PATCH", { properties });
  if (fetchPage && content) {
    await notion(env, `/blocks/${pageId}/children`, "PATCH", { children: webBlocks(content, 100) });
  }
  return result;
}
