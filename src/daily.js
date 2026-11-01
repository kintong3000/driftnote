// 日任务：给未处理的记录打标签、改写标题，并为每一天生成 Daily 总结。
//
// 处理范围是「AI已处理 = false 且早于今天」的全部记录，按日期分组、从最早的一天开始。
// 所以某天任务失败、额度用完或者超出子请求上限，剩下的记录会在下次运行时自动补上。

import { DAILY, ENTRY, LIMITS, TAGS, TYPES } from "./config.js";
import { notion, query, queryAll, P, read, block, truncate } from "./notion.js";
import { chatJSON } from "./llm.js";
import { DAILY_PROMPT } from "./prompts.js";
import { sendMessage } from "./telegram.js";
import { addDays, dayStart, localDate, localTime } from "./time.js";

const SECTIONS = [
  ["highlights", "✅", "核心产出"],
  ["tech", "🔧", "技术沉淀"],
  ["ideas", "💡", "想法"],
  ["todos", "📌", "待办与跟进"],
];

export async function runDaily(env, { today = localDate() } = {}) {
  const budget = { left: LIMITS.subrequestBudget - 1 };
  const backlog = await queryAll(env, env.NOTION_ENTRIES_DS, {
    filter: {
      and: [
        { property: ENTRY.aiDone, checkbox: { equals: false } },
        { property: ENTRY.time, date: { before: dayStart(today) } },
      ],
    },
    sorts: [{ property: ENTRY.time, direction: "ascending" }],
  });

  const byDate = new Map();
  for (const page of backlog) {
    const date = localDate(new Date(read.date(page, ENTRY.time)));
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(page);
  }

  const days = [];
  for (const [date, pending] of [...byDate].slice(0, LIMITS.daysPerRun)) {
    if (budget.left < 6) break;
    days.push(await processDay(env, date, pending, budget));
  }

  // 每月 1 号提醒导出 AI 对话记录
  if (today.endsWith("-01")) {
    await sendMessage(env, "🗂 每月提醒：导出 ChatGPT / Claude / Gemini 的对话记录做冷备份。");
  }
  return { backlog: backlog.length, days };
}

async function processDay(env, date, pending, budget) {
  let daily = await findDaily(env, date);
  budget.left--;

  // 当天还没有总结：读取当天全部记录来写总结；已有总结：只给剩下的记录打标签
  const entries = daily ? pending : await queryDay(env, date);
  if (!daily) budget.left--;
  const batch = entries.slice(0, LIMITS.entriesPerDay);

  const ai = await chatJSON(env, DAILY_PROMPT, formatEntries(batch));
  budget.left--;

  let created = false;
  if (!daily) {
    const summary = normalizeSummary(ai.summary);
    daily = await createDaily(env, date, batch, summary);
    await sendMessage(env, dailyMessage(date, batch.length, summary, daily.url));
    budget.left -= 2;
    created = true;
  }

  const pendingIds = new Set(pending.map((p) => p.id));
  const infos = Array.isArray(ai.entries) ? ai.entries : [];
  let updated = 0;
  for (const [i, page] of batch.entries()) {
    if (!pendingIds.has(page.id)) continue;
    if (budget.left < 1) break;
    await updateEntry(env, page, infos.find((e) => Number(e?.n) === i + 1));
    budget.left--;
    updated++;
  }
  return { date, entries: batch.length, created, updated };
}

async function findDaily(env, date) {
  const data = await query(env, env.NOTION_DAILY_DS, {
    filter: { property: DAILY.title, title: { equals: date } },
    page_size: 1,
  });
  return data.results[0];
}

const queryDay = (env, date) =>
  queryAll(env, env.NOTION_ENTRIES_DS, {
    filter: {
      and: [
        { property: ENTRY.time, date: { on_or_after: dayStart(date) } },
        { property: ENTRY.time, date: { before: dayStart(addDays(date, 1)) } },
      ],
    },
    sorts: [{ property: ENTRY.time, direction: "ascending" }],
  });

function formatEntries(pages) {
  return pages
    .map((p, i) => {
      const meta = [
        localTime(new Date(read.date(p, ENTRY.time))),
        `来源:${read.select(p, ENTRY.source)}`,
        `类型:${read.select(p, ENTRY.type)}`,
      ];
      const url = read.url(p, ENTRY.url);
      if (url) meta.push(`链接:${url}`);
      const lines = [`[${i + 1}] ${meta.join(" ")}`, `标题:${read.title(p, ENTRY.title)}`];
      lines.push(read.text(p, ENTRY.content).slice(0, LIMITS.charsPerEntryForAI));
      return lines.join("\n");
    })
    .join("\n\n");
}

function normalizeSummary(summary = {}) {
  const out = {};
  for (const [key] of SECTIONS) {
    const items = Array.isArray(summary?.[key]) ? summary[key] : [];
    out[key] = items.map((s) => String(s).trim()).filter(Boolean);
  }
  return out;
}

function createDaily(env, date, entries, summary) {
  const children = SECTIONS.flatMap(([key, icon, label]) =>
    summary[key].length ? [block.h2(`${icon} ${label}`), ...summary[key].map((s) => block.bullet(s))] : [],
  );
  if (!children.length) children.push(block.para("（当天没有可总结的内容）"));

  const text = SECTIONS.filter(([key]) => summary[key].length)
    .map(([key, , label]) => `${label}\n${summary[key].map((s) => `- ${s}`).join("\n")}`)
    .join("\n");

  return notion(env, "/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: env.NOTION_DAILY_DS },
    properties: {
      [DAILY.title]: P.title(date),
      [DAILY.date]: P.date(date),
      [DAILY.entries]: P.relation(entries.map((p) => p.id)),
      [DAILY.summary]: P.text(truncate(text, 2000)),
    },
    children: children.slice(0, 100),
  });
}

function dailyMessage(date, count, summary, url) {
  const lines = [`📅 ${date.slice(5)} 回顾 · 共 ${count} 条`];
  for (const [key, icon] of SECTIONS) {
    for (const s of summary[key].slice(0, 3)) lines.push(`${icon} ${s}`);
  }
  lines.push(`→ ${url}`);
  return lines.join("\n");
}

// AI 没返回这条的结果时，也标记为已处理，避免反复处理同一条
function updateEntry(env, page, info = {}) {
  const properties = { [ENTRY.aiDone]: P.checkbox(true) };
  const title = String(info.title || "").trim();
  if (title) properties[ENTRY.title] = P.title(truncate(title, 100));
  if (TYPES.includes(info.type)) properties[ENTRY.type] = P.select(info.type);
  const tags = (Array.isArray(info.tags) ? info.tags : []).filter((t) => TAGS.includes(t)).slice(0, 3);
  if (tags.length) properties[ENTRY.tags] = P.multi(tags);
  return notion(env, `/pages/${page.id}`, "PATCH", { properties });
}
