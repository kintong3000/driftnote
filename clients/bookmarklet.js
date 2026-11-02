// 浏览器书签脚本。替换 EP 和 TK 后，把整段（从 javascript: 开始）粘贴到书签的「网址」栏。
// 粘贴后会变成一行，所以下面的代码里只能用 /* */ 注释，每条语句都要以分号结尾，字符串里不能有真正的换行。
// 点书签在页面右上角打开面板，再点一次关闭。⌘/Ctrl + Enter 保存，Esc 关闭。
// 保存顺序：直接 fetch → 被网站 CSP 拦截时打开中转页面 → 弹窗也被拦截时显示内容让你手动复制。
javascript:(function () {
  const EP = "https://driftnote.<你的子域>.workers.dev", TK = "<AUTH_TOKEN>";
  const TYPES = ["自动", "想法", "链接", "摘录", "技术", "待办", "AI对话"];
  const ID = "driftnote-panel";
  const API = EP.replace(/\/+$/, "");

  const old = document.getElementById(ID);
  if (old) { old.remove(); return; }

  const sel = getSelection().toString().trim();
  /* 优先取文章区域，减少导航栏和评论区的干扰；上限和服务端 LIMITS.pageContentChars 一致 */
  const main = document.querySelector("article") || document.querySelector("main, [role=main]") || document.body;
  const body = main.innerText.trim().slice(0, 100000);
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem("driftnote:" + k); return v === null ? d : v; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem("driftnote:" + k, v); } catch (e) {} },
  };

  /* 不用 innerHTML，避免启用了 Trusted Types 的网站报错 */
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), attrs[k]);
      else if (k === "text") el.textContent = attrs[k];
      else if (k === "checked" || k === "disabled") el[k] = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    el.append(...kids.filter(Boolean));
    return el;
  };

  const CSS = [
    ".p{--fg:#1f2328;--mut:#59636e;--bg:#fff;--in:#f6f8fa;--bd:#d0d7de;--acc:#0969da;--ok:#1a7f37;--err:#cf222e;box-sizing:border-box;width:380px;max-width:calc(100vw - 32px);padding:14px;color:var(--fg);background:var(--bg);border:1px solid var(--bd);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.2);font:14px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;text-align:left}",
    "@media (prefers-color-scheme:dark){.p{--fg:#e6edf3;--mut:#9198a1;--bg:#1c2128;--in:#151b23;--bd:#3d444d;--acc:#4493f8;--ok:#3fb950;--err:#f85149}}",
    ".hd{display:flex;align-items:center;gap:8px}",
    ".t{flex:1;font-weight:600}",
    ".x{border:0;background:none;color:var(--mut);font-size:20px;line-height:1;cursor:pointer;padding:0 2px}",
    ".sub{margin:2px 0 10px;color:var(--mut);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".q{margin:0 0 10px;padding:4px 8px;border-left:3px solid var(--acc);color:var(--mut);font-size:13px;max-height:80px;overflow:auto;white-space:pre-wrap}",
    "textarea{box-sizing:border-box;display:block;width:100%;min-height:68px;margin:0;padding:8px;resize:vertical;font:inherit;color:inherit;background:var(--in);border:1px solid var(--bd);border-radius:8px}",
    "textarea:focus{outline:2px solid var(--acc);outline-offset:-1px}",
    ".chips{display:flex;flex-wrap:wrap;gap:5px;margin:10px 0}",
    ".chip{padding:2px 8px;border:1px solid var(--bd);border-radius:999px;background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer}",
    ".chip[aria-pressed=true]{background:var(--acc);border-color:var(--acc);color:#fff}",
    "label{display:flex;align-items:center;gap:6px;color:var(--mut);font-size:13px;cursor:pointer}",
    "label input{margin:0;accent-color:var(--acc)}",
    ".ft{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px}",
    ".st{flex:1;font-size:12px;color:var(--mut)}",
    ".st.ok{color:var(--ok)}.st.err{color:var(--err)}",
    ".st a{color:var(--acc);margin-left:6px}",
    ".go{flex:none;white-space:nowrap;padding:6px 16px;border:0;border-radius:8px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}",
    ".go:disabled{opacity:.6;cursor:default}",
  ].join("");

  /* Shadow DOM 隔离网站样式；可构造样式表不受 CSP 的 style-src 限制 */
  const host = h("div", { id: ID });
  host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch (e) {
    root.append(h("style", { text: CSS }));
  }

  const close = () => host.remove();
  let type = "自动";
  const chips = TYPES.map((t) => h("button", {
    class: "chip", "aria-pressed": String(t === type), text: t,
    onclick: () => { type = t; chips.forEach((c) => c.setAttribute("aria-pressed", String(c.textContent === t))); },
  }));
  const ta = h("textarea", { placeholder: "批注（可留空）" });
  const cb = h("input", { type: "checkbox", checked: Boolean(body) && store.get("full", "1") === "1", disabled: !body });
  const st = h("span", { class: "st", text: (/Mac|iP/.test(navigator.platform) ? "⌘" : "Ctrl") + "+Enter 保存 · Esc 关闭" });
  const go = h("button", { class: "go", text: "保存", onclick: () => save() });
  const status = (text, cls, link) => {
    st.className = "st " + (cls || "");
    st.textContent = text;
    if (link) st.append(h("a", { href: link, target: "_blank", rel: "noopener", text: "在 Notion 打开" }));
  };

  root.append(h("div", { class: "p" },
    h("div", { class: "hd" }, h("span", { class: "t", text: "存到 driftnote" }), h("button", { class: "x", title: "关闭", text: "×", onclick: close })),
    h("div", { class: "sub", text: document.title || location.href }),
    sel && h("div", { class: "q", text: sel }),
    ta,
    h("div", { class: "chips" }, ...chips),
    h("label", {}, cb, document.createTextNode(body ? "保存网页正文（约 " + body.length.toLocaleString() + " 字）" : "没有读到网页正文")),
    h("div", { class: "ft" }, st, go),
  ));

  /* 面板里的按键不传给网站，避免触发网站自己的快捷键 */
  ["keydown", "keyup", "keypress"].forEach((t) => host.addEventListener(t, (e) => e.stopPropagation()));
  host.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  });

  function save() {
    if (go.disabled) return;
    go.disabled = true;
    status("保存中…");
    const full = cb.checked;
    store.set("full", full ? "1" : "0");
    const note = ta.value.trim();
    const p = {
      text: [note, sel && "> " + sel].filter(Boolean).join("\n\n") || document.title,
      url: location.href,
      title: document.title,
      source: "browser",
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(),
      content: full ? body : "",
      fetch: full,
    };
    if (type !== "自动") p.type = type;
    fetch(API + "/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": TK },
      body: JSON.stringify(p),
    })
      .then((r) => r.json().catch(() => ({})).then((j) => {
        if (!r.ok) throw Object.assign(new Error(r.status === 401 ? "AUTH_TOKEN 不对，检查书签里的 TK" : j.error || "HTTP " + r.status), { server: true });
        return j;
      }))
      .then((j) => {
        status((j.duplicate ? "✓ 已存在 · " : "✓ 已保存 · ") + j.type + (full ? " · 摘要几秒后生成" : ""), "ok", j.url);
        setTimeout(close, 2500);
      })
      .catch((err) => {
        if (err.server) { status("❌ " + err.message, "err"); go.disabled = false; return; }
        /* 请求被网站 CSP 拦截：改走中转页面。正文放在地址里，太长会打不开，只带前 2 万字 */
        const w = window.open(API + "/capture#" + encodeURIComponent(JSON.stringify({ ...p, content: p.content.slice(0, 20000), token: TK })));
        if (w) { status("这个网站拦截了请求，已在新窗口保存", "ok"); setTimeout(close, 2500); return; }
        status("❌ 网站拦截了保存，弹窗也被阻止", "err");
        go.disabled = false;
        prompt("请复制下面的内容发给 Telegram Bot：", p.text + "\n" + p.url);
      });
  }

  document.documentElement.append(host);
  ta.focus();
})();
