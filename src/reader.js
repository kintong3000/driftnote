// 用 Jina Reader 抓取链接的标题和正文。抓不到（超时、需要登录、被拦截）时返回 null，不影响保存。

import { LIMITS } from "./config.js";

export async function readPage(env, url) {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        Accept: "application/json",
        "X-Retain-Images": "none",
        ...(env.JINA_API_KEY && { Authorization: `Bearer ${env.JINA_API_KEY}` }),
      },
      signal: AbortSignal.timeout(LIMITS.readerTimeoutMs),
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    if (!data || data.warning || redirectedAway(url, data.finalUrl)) return null;

    // X 等网站的正文是登录提示，帖子原文只在 description 里；
    // 多数文章的 description 是正文开头的摘要，忽略空白比较前 30 字，避免重复
    const desc = String(data.description || "").trim();
    const body = String(data.content || "").trim();
    const squash = (s) => s.replace(/\s+/g, "");
    const content = desc && !squash(body).includes(squash(desc).slice(0, 30)) ? `${desc}\n\n${body}` : body;
    return { title: String(data.title || "").trim(), content };
  } catch (err) {
    console.error("readPage", url, err.message);
    return null;
  }
}

// 被跳转到登录页或首页时，最终地址里不再有原链接的 ID（例如小红书笔记 → /explore）
function redirectedAway(url, finalUrl) {
  if (!finalUrl) return false;
  const id = new URL(url).pathname.split("/").filter(Boolean).pop();
  return Boolean(id) && !finalUrl.includes(id);
}
