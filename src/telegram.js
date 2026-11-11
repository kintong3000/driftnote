// Telegram：解析消息 → capture()，并回复保存结果

import { capture } from "./capture.js";
import { LIMITS } from "./config.js";
import { transcribe } from "./llm.js";
import { truncate } from "./notion.js";
import { localDateTime } from "./time.js";

const HELP = `直接发消息即可记录：文字、语音、转发的消息都可以。
以 #待办 #技术 #想法 #AI对话 等开头可以指定类型。
消息里有链接时会抓取网页正文并生成摘要（需要登录的网站抓不到，只保存链接）。
发 .md / .txt 等文本文件会读取文件内容存进笔记并生成摘要；图片和其他文件只记录说明文字，不保存文件本身。`;

export async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

// 发消息给自己（私聊的 chat_id 就是 user id）
export const sendMessage = (env, text, extra = {}) =>
  tg(env, "sendMessage", {
    chat_id: env.MY_TG_USER_ID,
    text: truncate(text, 4000),
    link_preview_options: { is_disabled: true },
    ...extra,
  });

export async function handleTelegram(env, update) {
  const msg = update.message;
  if (!msg || String(msg.from?.id) !== String(env.MY_TG_USER_ID)) return;

  const reply = (text) =>
    sendMessage(env, text, { reply_parameters: { message_id: msg.message_id }, disable_notification: true });

  try {
    if (msg.entities?.[0]?.type === "bot_command" && msg.entities[0].offset === 0) return await reply(HELP);

    const input = await toCaptureInput(env, msg);
    if (!input) return await reply("暂不支持这种消息类型，没有保存。");

    const r = await capture(env, {
      ...input,
      source: "telegram",
      id: `tg:${update.update_id}`,
      time: localDateTime(new Date(msg.date * 1000)),
    });
    // 已经在 waitUntil 里了，直接等网页处理完，把结果一起回复
    const e = r.enriched && (await r.enriched.catch((err) => (console.error("enrich", err), null)));
    const title = truncate(e?.title || r.title, 50);
    const status = !r.enriched
      ? ""
      : !e
        ? " · 网页处理出错"
        : e.summary
          ? `\n\n${e.summary}`
          : input.content || e.fetched
            ? ` · 已保存${input.content ? "文件内容" : "网页"}，摘要失败`
            : " · 网页抓取失败";
    await reply(`${r.duplicate ? "✓ 已存在" : "✓"} ${r.type} · ${title}${status}`);
  } catch (err) {
    console.error(err);
    await reply(`❌ 保存失败：${err.message}\n请稍后重发。`).catch(() => {});
  }
}

async function toCaptureInput(env, msg) {
  let text, url, type, title, content;

  if (msg.text) {
    text = msg.text;
    url = firstUrl(msg.text, msg.entities);
  } else if (msg.voice || msg.audio) {
    const transcript = await transcribeFile(env, (msg.voice || msg.audio).file_id);
    if (!transcript) throw new Error("语音没有识别出内容");
    text = `[语音] ${transcript}`;
    type = "语音";
  } else if (isTextFile(msg.document)) {
    const name = msg.document.file_name || "未命名文件";
    const buf = await fetchFile(env, msg.document.file_id, "文件");
    content = new TextDecoder("utf-8").decode(buf).replace(/^\uFEFF/, "").trim();
    if (!content) throw new Error("文件是空的");
    text = msg.caption ? `${msg.caption}\n[文件] ${name}` : `[文件] ${name}`;
    url = firstUrl(msg.caption, msg.caption_entities);
    // 没有说明文字时，标题用 Markdown 的第一个一级标题，没有就用文件名
    if (!msg.caption) title = content.match(/^#\s+(.+)$/m)?.[1].trim() || name.replace(/\.[^.]+$/, "");
  } else if (msg.photo || msg.document || msg.video) {
    const label = msg.photo ? "[图片]" : msg.document ? `[文件] ${msg.document.file_name || ""}` : "[视频]";
    text = msg.caption ? `${msg.caption}\n${label}` : label;
    url = firstUrl(msg.caption, msg.caption_entities);
  } else {
    return null;
  }

  // 来源放在末尾，以免挡住开头的 #类型 前缀
  const origin = forwardOrigin(msg);
  if (origin) text += `\n\n转发自：${origin}`;
  // 文件内容已经带上了，不再抓取链接
  if (content) return { text, url, type, title, content, contentHeading: "文件内容", markdown: isMarkdown(msg.document) };
  // 只抓取消息里的链接，不抓「转发自」里的 t.me 链接
  return { text, url, type, fetch: Boolean(url) };
}

const TEXT_EXT = /\.(md|markdown|txt|text|org|rst|csv|tsv|json|ya?ml|toml|xml|html?|log)$/i;

// 只读小的文本文件（Telegram Bot 最多能下载 20MB）
function isTextFile(doc) {
  if (!doc || doc.file_size > LIMITS.tgTextFileBytes) return false;
  return TEXT_EXT.test(doc.file_name || "") || String(doc.mime_type || "").startsWith("text/");
}

// .txt 之类按纯文本存，避免里面的 * _ # 被当成格式
const isMarkdown = (doc) => /\.(md|markdown)$/i.test(doc.file_name || "") || doc.mime_type === "text/markdown";

function firstUrl(text = "", entities = []) {
  for (const e of entities) {
    if (e.type === "text_link") return e.url;
    if (e.type === "url") return text.substr(e.offset, e.length);
  }
  return "";
}

function forwardOrigin(msg) {
  const o = msg.forward_origin;
  if (!o) return "";
  if (o.type === "user") return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ");
  if (o.type === "hidden_user") return o.sender_user_name;
  if (o.type === "chat") return o.sender_chat.title;
  if (o.type === "channel") {
    return o.chat.username ? `${o.chat.title} https://t.me/${o.chat.username}/${o.message_id}` : o.chat.title;
  }
  return "";
}

async function fetchFile(env, fileId, label) {
  const file = await tg(env, "getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`下载${label}失败：${res.status}`);
  return res.arrayBuffer();
}

async function transcribeFile(env, fileId) {
  return transcribe(env, await fetchFile(env, fileId, "语音"));
}
