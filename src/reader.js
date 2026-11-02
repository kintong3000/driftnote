// 用 Firecrawl 抓取链接的标题和正文。抓不到（超时、需要登录、被拦截、额度用完）时返回 null，不影响保存。

import { LIMITS } from "./config.js";

export async function readPage(env, url) {
  if (!env.FIRECRAWL_API_KEY) return fail(url, "未设置 FIRECRAWL_API_KEY");
  try {
    url = stripTracking(url);
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`, "Content-Type": "application/json" },
      // onlyMainContent 去掉导航、页脚；Firecrawl 自己的超时比本地略短，超时时能拿到它的报错
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, timeout: LIMITS.readerTimeoutMs - 2000 }),
      signal: AbortSignal.timeout(LIMITS.readerTimeoutMs),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || !result.success) return fail(url, `HTTP ${res.status} ${result.error || ""}`);
    const { markdown = "", metadata = {} } = result.data || {};
    if (metadata.error || metadata.statusCode >= 400) return fail(url, `网页 ${metadata.statusCode} ${metadata.error || ""}`);
    if (redirectedAway(url, metadata.url)) return fail(url, `被跳转到 ${metadata.url}`);

    // X 等网站的正文是登录提示，帖子原文只在 description 里；
    // 多数文章的 description 是正文开头的摘要，忽略空白比较前 30 字，避免重复
    const desc = first(metadata.description || metadata.ogDescription).trim();
    const body = markdown.trim();
    const squash = (s) => s.replace(/\s+/g, "");
    const content = desc && !squash(body).includes(squash(desc).slice(0, 30)) ? `${desc}\n\n${body}` : body;
    return { title: first(metadata.title || metadata.ogTitle).trim(), content };
  } catch (err) {
    return fail(url, err.message);
  }
}

// metadata 里的字段可能是字符串，也可能是数组（页面有多个同名 meta 标签）
const first = (v) => String([].concat(v ?? "")[0] ?? "");

function fail(url, reason) {
  console.error("readPage", url, reason);
  return null;
}

// 去掉分享追踪参数：更容易命中 Firecrawl 缓存，也不把分享者标记发给第三方。
// 只删已知的参数，小红书 xsec_token 这类访问必需的参数要保留
const TRACKING = /^(utm_\w+|fbclid|gclid|share_source|share_medium)$/;
const X_HOSTS = /(^|\.)(x|twitter)\.com$/;

function stripTracking(url) {
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING.test(key) || (X_HOSTS.test(u.hostname) && (key === "s" || key === "t"))) u.searchParams.delete(key);
  }
  return u.toString();
}

// 被跳转到登录页或首页时，最终地址里不再有原链接的 ID（例如小红书笔记 → /explore）
function redirectedAway(url, finalUrl) {
  if (!finalUrl) return false;
  const id = new URL(url).pathname.split("/").filter(Boolean).pop();
  return Boolean(id) && !finalUrl.includes(id);
}
