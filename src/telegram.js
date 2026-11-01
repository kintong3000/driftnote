// Telegram：解析消息 → capture()，并回复保存结果

import { capture } from "./capture.js";
import { transcribe } from "./llm.js";
import { truncate } from "./notion.js";
import { localDateTime } from "./time.js";

const HELP = `直接发消息即可记录：文字、语音、转发的消息都可以。
以 #待办 #技术 #想法 #AI对话 等开头可以指定类型。
图片和文件目前只记录说明文字，不保存文件本身。`;

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
    await reply(`${r.duplicate ? "✓ 已存在" : "✓"} ${r.type} · ${truncate(r.title, 50)}`);
  } catch (err) {
    console.error(err);
    await reply(`❌ 保存失败：${err.message}\n请稍后重发。`).catch(() => {});
  }
}

async function toCaptureInput(env, msg) {
  let text, url, type;

  if (msg.text) {
    text = msg.text;
    url = firstUrl(msg.text, msg.entities);
  } else if (msg.voice || msg.audio) {
    const transcript = await transcribeFile(env, (msg.voice || msg.audio).file_id);
    if (!transcript) throw new Error("语音没有识别出内容");
    text = `[语音] ${transcript}`;
    type = "语音";
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
  return { text, url, type };
}

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

async function transcribeFile(env, fileId) {
  const file = await tg(env, "getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`下载语音失败：${res.status}`);
  return transcribe(env, await res.arrayBuffer());
}
