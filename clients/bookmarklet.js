// 浏览器书签脚本。替换 EP 和 TK 后，把整段（从 javascript: 开始）粘贴到书签的「网址」栏。
// 保存顺序：直接 fetch → 被网站 CSP 拦截时打开中转页面 → 弹窗也被拦截时显示内容让你手动复制。
javascript:(function () {
  const EP = "https://driftnote.<你的子域>.workers.dev", TK = "<AUTH_TOKEN>";
  const sel = getSelection().toString().trim();
  const note = prompt("批注（可留空）：", "");
  if (note === null) return;
  const p = {
    text: [note, sel && "> " + sel].filter(Boolean).join("\n\n") || document.title,
    url: location.href,
    title: document.title,
    source: "browser",
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(),
  };
  fetch(EP + "/api/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Token": TK },
    body: JSON.stringify(p),
  })
    .then((r) => { if (!r.ok) throw 0; alert("✓ 已保存"); })
    .catch(() => {
      const w = window.open(EP + "/capture#" + encodeURIComponent(JSON.stringify({ ...p, token: TK })));
      if (!w) prompt("这个网站拦截了保存，请复制下面的内容发给 Telegram Bot：", p.text + "\n" + p.url);
    });
})();
