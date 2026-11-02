import { capture, HttpError } from "./capture.js";
import { CAPTURE_PAGE } from "./capture-page.js";
import { CRON } from "./config.js";
import { runDaily } from "./daily.js";
import { handleTelegram, sendMessage } from "./telegram.js";
import { runWeekly } from "./weekly.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });

// 固定时间比较，避免通过响应时间猜 token
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJSON(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") throw new HttpError(400, "请求体不是合法 JSON");
  return body;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    try {
      // 统一捕获接口（终端、浏览器、iOS 快捷指令）
      if (pathname === "/api/capture") {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        if (!safeEqual(request.headers.get("X-Auth-Token"), env.AUTH_TOKEN)) return json({ error: "Unauthorized" }, 401);

        const body = await readJSON(request);
        const r = await capture(env, { ...body, source: body.source || "api" });
        if (r.enriched) ctx.waitUntil(r.enriched.catch((err) => console.error("enrich", err)));
        return json({ status: "success", duplicate: r.duplicate, type: r.type, title: r.title, url: r.page.url });
      }

      // 手动触发定时任务，方便测试和补跑：{"job": "daily" | "weekly", "today": "YYYY-MM-DD"}
      if (pathname === "/api/run") {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        if (!safeEqual(request.headers.get("X-Auth-Token"), env.AUTH_TOKEN)) return json({ error: "Unauthorized" }, 401);

        const { job = "daily", today } = await readJSON(request);
        if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new HttpError(400, "today 格式应为 YYYY-MM-DD");
        const result = job === "weekly" ? await runWeekly(env, { today }) : await runDaily(env, { today });
        return json({ status: "success", result });
      }

      if (pathname === "/capture" && request.method === "GET") {
        return new Response(CAPTURE_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (pathname === "/webhook/telegram") {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        if (!safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.TG_WEBHOOK_SECRET)) {
          return json({ error: "Unauthorized" }, 401);
        }
        // 先返回 200，避免 Telegram 超时重试；处理结果通过回复消息告诉你
        const update = await request.json();
        ctx.waitUntil(handleTelegram(env, update));
        return new Response("OK");
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    const job = event.cron === CRON.weekly ? runWeekly : runDaily;
    ctx.waitUntil(
      job(env)
        .then((result) => console.log(event.cron, JSON.stringify(result)))
        .catch(async (err) => {
          console.error(err);
          await sendMessage(env, `⚠️ 定时任务失败（${event.cron}）：${err.message}\n未处理的记录会在下次运行时补上。`).catch(
            () => {},
          );
        }),
    );
  },
};
