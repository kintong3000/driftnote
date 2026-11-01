// 书签脚本的中转页面：网站的 CSP 拦截了 fetch 时，书签脚本会打开这个页面。
// 数据放在 URL 的 # 后面（不会发送到服务器），页面读取后同源 POST 到 /api/capture。

export const CAPTURE_PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>保存到日志</title>
<style>
  :root { --fg: #222; --muted: #777; --bg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ddd; --muted: #999; --bg: #1a1a1a; } }
  body { font: 16px/1.6 system-ui, sans-serif; color: var(--fg); background: var(--bg); max-width: 560px; margin: 15vh auto; padding: 0 16px; }
  pre { white-space: pre-wrap; color: var(--muted); }
</style>
</head>
<body>
<p id="status">保存中…</p>
<pre id="content"></pre>
<script>
(async () => {
  const status = document.getElementById("status");
  let data;
  try {
    data = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  } catch {
    status.textContent = "❌ 数据无效";
    return;
  }
  // 从地址栏和历史记录里去掉 token
  history.replaceState(null, "", location.pathname);

  const { token, ...payload } = data;
  document.getElementById("content").textContent = payload.text || "";
  try {
    const res = await fetch("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.status);
    status.textContent = "✓ 已保存，窗口即将关闭";
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    status.textContent = "❌ 保存失败：" + err.message;
  }
})();
</script>
</body>
</html>`;
