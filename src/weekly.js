// 周任务：回顾上周一到周日，生成 Weekly 页面并推送到 Telegram

import { DAILY, ENTRY, LIMITS, STATUS, WEEKLY } from "./config.js";
import { notion, query, queryAll, P, read, block, richText } from "./notion.js";
import { chatJSON } from "./llm.js";
import { WEEKLY_PROMPT } from "./prompts.js";
import { sendMessage } from "./telegram.js";
import { addDays, dayStart, isoWeek, localDate } from "./time.js";

const INBOX_ACTIONS = [STATUS.archived, STATUS.action, STATUS.dropped];

export async function runWeekly(env, { today = localDate() } = {}) {
  const start = addDays(today, -7);
  const end = addDays(today, -1);
  const week = isoWeek(start);

  const existing = await query(env, env.NOTION_WEEKLY_DB, {
    filter: { property: WEEKLY.title, title: { equals: week } },
    page_size: 1,
  });
  if (existing.results.length) return { week, skipped: "已存在" };

  const entries = await queryAll(
    env,
    env.NOTION_ENTRIES_DB,
    {
      filter: {
        and: [
          { property: ENTRY.time, date: { on_or_after: dayStart(start) } },
          { property: ENTRY.time, date: { before: dayStart(today) } },
        ],
      },
      sorts: [{ property: ENTRY.time, direction: "ascending" }],
    },
    3,
  );
  if (!entries.length) return { week, skipped: "上周没有记录" };

  const dailies = await queryAll(env, env.NOTION_DAILY_DB, {
    filter: {
      and: [
        { property: DAILY.date, date: { on_or_after: start } },
        { property: DAILY.date, date: { on_or_before: end } },
      ],
    },
    sorts: [{ property: DAILY.date, direction: "ascending" }],
  });

  const backlogData = await query(env, env.NOTION_ENTRIES_DB, {
    filter: {
      and: [
        { property: ENTRY.status, select: { equals: STATUS.inbox } },
        { property: ENTRY.time, date: { before: dayStart(start) } },
      ],
    },
    sorts: [{ property: ENTRY.time, direction: "ascending" }],
    page_size: 10,
  });
  const backlog = backlogData.results;
  const echoes = await findEchoes(env, entries, today);

  const ai = await chatJSON(env, WEEKLY_PROMPT, formatWeek(dailies, entries, backlog, echoes));
  const review = normalizeReview(ai, backlog, echoes);

  const page = await notion(env, "/pages", "POST", {
    parent: { database_id: env.NOTION_WEEKLY_DB },
    properties: {
      [WEEKLY.title]: P.title(week),
      [WEEKLY.start]: P.date(start),
      [WEEKLY.end]: P.date(end),
      [WEEKLY.dailies]: P.relation(dailies.map((d) => d.id)),
    },
    children: weeklyBlocks(review).slice(0, 100),
  });

  const backlogCount = backlogData.has_more ? `${backlog.length}+` : `${backlog.length}`;
  await sendMessage(env, weeklyMessage(week, entries.length, review, backlogCount, page.url));
  return { week, entries: entries.length, dailies: dailies.length, backlog: backlogCount, echoes: echoes.length };
}

// 取上周最多的 3 个标签，各随机抽 2 条 30 天以前的同标签记录
async function findEchoes(env, entries, today) {
  const counts = new Map();
  for (const p of entries) {
    for (const tag of read.multi(p, ENTRY.tags)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  const topTags = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tag]) => tag);

  const seen = new Set();
  const echoes = [];
  for (const tag of topTags) {
    const data = await query(env, env.NOTION_ENTRIES_DB, {
      filter: {
        and: [
          { property: ENTRY.tags, multi_select: { contains: tag } },
          { property: ENTRY.time, date: { before: dayStart(addDays(today, -30)) } },
        ],
      },
      page_size: 30,
    });
    for (const p of sample(data.results.filter((p) => !seen.has(p.id)), 2)) {
      seen.add(p.id);
      echoes.push(p);
    }
  }
  return echoes;
}

function sample(items, n) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

const entryDate = (p) => localDate(new Date(read.date(p, ENTRY.time)));

function entryLine(p, withContent) {
  const tags = read.multi(p, ENTRY.tags).map((t) => `#${t}`).join(" ");
  let line = `${entryDate(p)} [${read.select(p, ENTRY.type)}] ${read.title(p, ENTRY.title)} ${tags}`.trim();
  if (withContent) line += `：${read.text(p, ENTRY.content).slice(0, 100)}`;
  return line;
}

function formatWeek(dailies, entries, backlog, echoes) {
  const parts = ["## 每日摘要"];
  for (const d of dailies) parts.push(`### ${read.title(d, DAILY.title)}\n${read.text(d, DAILY.summary)}`);
  if (!dailies.length) parts.push("（无）");

  parts.push(`## 上周记录（共 ${entries.length} 条）`);
  parts.push(entries.slice(0, LIMITS.weeklyLines).map((p) => entryLine(p, false)).join("\n"));

  parts.push("## 收件匣积压");
  parts.push(backlog.map((p, i) => `[B${i + 1}] ${entryLine(p, true)}`).join("\n") || "（无）");

  parts.push("## 旧笔记");
  parts.push(echoes.map((p, i) => `[O${i + 1}] ${entryLine(p, true)}`).join("\n") || "（无）");
  return parts.join("\n\n");
}

// 校验 AI 输出，并把 B1/O1 这样的编号换回对应的 Notion 页面
function normalizeReview(ai, backlog, echoes) {
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
  const str = (v) => String(v ?? "").trim();
  const byRef = (prefix, pages) => (ref) => pages[Number(String(ref).replace(prefix, "")) - 1];

  return {
    themes: list(ai.themes).map((t) => ({ name: str(t.name), summary: str(t.summary) })).filter((t) => t.name),
    recurring: (Array.isArray(ai.recurring) ? ai.recurring : []).map(str).filter(Boolean),
    next: list(ai.next).map((t) => ({ item: str(t.item), reason: str(t.reason) })).filter((t) => t.item),
    inbox: list(ai.inbox)
      .map((t) => ({ page: byRef("B", backlog)(t.ref), action: str(t.action), reason: str(t.reason) }))
      .filter((t) => t.page && INBOX_ACTIONS.includes(t.action)),
    echoes: list(ai.echoes)
      .map((t) => ({ page: byRef("O", echoes)(t.ref), note: str(t.note) }))
      .filter((t) => t.page),
  };
}

function weeklyBlocks(review) {
  const section = (title, items) => (items.length ? [block.h2(title), ...items.map((rich) => block.bullet(rich))] : []);
  const pageLink = (p) => richText(`${entryDate(p)} ${read.title(p, ENTRY.title)}`, p.url);

  const blocks = [
    ...section("🧭 本周主题", review.themes.map((t) => `${t.name}：${t.summary}`)),
    ...section("🔁 反复出现的想法", review.recurring),
    ...section("🚀 建议推进", review.next.map((t) => `${t.item} —— ${t.reason}`)),
    ...section(
      "📥 收件匣待决定",
      review.inbox.map((t) => [...pageLink(t.page), ...richText(` → ${t.action}：${t.reason}`)]),
    ),
    ...section("🕰 旧笔记呼应", review.echoes.map((t) => [...pageLink(t.page), ...richText(` —— ${t.note}`)])),
  ];
  return blocks.length ? blocks : [block.para("（AI 没有生成回顾内容）")];
}

function weeklyMessage(week, count, review, backlogCount, url) {
  const lines = [`🗓 ${week} 周回顾 · 上周 ${count} 条`];
  if (review.themes.length) lines.push(`🧭 主题：${review.themes.map((t) => t.name).join("、")}`);
  if (review.next.length) {
    lines.push("🚀 建议推进：");
    review.next.forEach((t, i) => lines.push(`${i + 1}. ${t.item}`));
  }
  if (backlogCount !== "0") lines.push(`📥 收件匣积压 ${backlogCount} 条待决定`);
  lines.push(`→ ${url}`);
  return lines.join("\n");
}
