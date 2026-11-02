// 浏览器书签脚本。替换 EP 和 TK 后，把整段（从 javascript: 开始）粘贴到书签的「网址」栏。
// 粘贴后会变成一行，所以下面的代码里只能用 /* */ 注释。
// 保存顺序：直接 fetch → 被网站 CSP 拦截时打开中转页面 → 弹窗也被拦截时显示内容让你手动复制。
javascript:(function () {
  const EP = "https://driftnote.<你的子域>.workers.dev", TK = "<AUTH_TOKEN>";
  const sel = getSelection().toString().trim();
  const note = prompt("批注（可留空）：", "");
  if (note === null) return;
  const full = confirm("同时保存网页正文？\n\n确定：保存正文\n取消：只保存" + (sel ? "选中的文字" : "标题和链接"));
  /* 优先取文章区域，减少导航栏和评论区的干扰；上限和服务端 LIMITS.pageContentChars 一致 */
  const main = document.querySelector("article") || document.querySelector("main, [role=main]") || document.body;
  const content = full ? main.innerText.trim().slice(0, 100000) : "";
  const p = {
    text: [note, sel && "> " + sel].filter(Boolean).join("\n\n") || document.title,
    url: location.href,
    title: document.title,
    source: "browser",
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(),
    content: content,
    fetch: full,
  };
  fetch(EP + "/api/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Token": TK },
    body: JSON.stringify(p),
  })
    .then((r) => { if (!r.ok) throw 0; alert(content ? "✓ 已保存（含正文）" : "✓ 已保存"); })
    .catch(() => {
      /* 正文放在地址里，太长会打不开，中转页面只带前 2 万字 */
      const w = window.open(EP + "/capture#" + encodeURIComponent(JSON.stringify({ ...p, content: content.slice(0, 20000), token: TK })));
      if (!w) prompt("这个网站拦截了保存，请复制下面的内容发给 Telegram Bot：", p.text + "\n" + p.url);
    });
})();
