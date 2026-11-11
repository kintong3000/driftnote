// 检查 Notion 里的三个数据库：不存在就新建，缺少的属性、关联和视图自动补上。
// 可以重复运行，已经存在的部分不会改动（包括你手动调整过的视图）。
//
// 用法：npm run setup:notion            # 只更新本地 .dev.vars
//       npm run setup:notion -- --secrets  # 同时把数据源 ID 上传为 Cloudflare secret
//
// 需要在 .dev.vars（或环境变量）里提供：
//   NOTION_API_KEY      Integration token
//   NOTION_PARENT_PAGE  存放数据库的页面链接或 ID（需要先把 Integration 连接到这个页面）
//
// Notion API 2025-09-03 起，数据库只是容器，属性和记录属于其中的「数据源」（data source）。
// Worker 读写记录用的是数据源 ID，所以脚本写入 .dev.vars 的是 NOTION_*_DS。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DAILY, ENTRY, STATUS, TAGS, TYPES, WEEKLY } from "../src/config.js";
import { notion } from "../src/notion.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEV_VARS = fileURLToPath(new URL("../.dev.vars", import.meta.url));
const DEFAULT_VIEW = "Default view"; // 新建数据库时 Notion 自动创建的表格视图

const options = (names) => ({ options: names.map((name) => ({ name })) });
const byTime = (direction) => [{ property: ENTRY.time, direction }];
const is = (property, kind, value) => ({ property, [kind]: { equals: value } });

// 被 Worker 读写的属性名来自 src/config.js；「日总结」「周回顾」「条数」和视图只在 Notion 里显示，代码不读写
const DATABASES = [
  {
    key: "NOTION_ENTRIES_DS",
    title: "Entries",
    properties: {
      [ENTRY.title]: { title: {} },
      [ENTRY.time]: { date: {} },
      [ENTRY.source]: { select: options(["telegram", "ios-share", "ios-voice", "terminal", "browser", "claude-code"]) },
      [ENTRY.type]: { select: options(TYPES) },
      [ENTRY.url]: { url: {} },
      [ENTRY.content]: { rich_text: {} },
      [ENTRY.summary]: { rich_text: {} },
      [ENTRY.tags]: { multi_select: options(TAGS) },
      [ENTRY.status]: { select: options(Object.values(STATUS)) },
      [ENTRY.aiDone]: { checkbox: {} },
      [ENTRY.externalId]: { rich_text: {} },
    },
    // 第一个表格视图会复用 Notion 自动创建的 Default view
    views: [
      { name: "全部", type: "table", sorts: byTime("descending") },
      {
        name: "今天",
        type: "list",
        filter: {
          and: [
            { property: ENTRY.time, date: { on_or_after: "today" } },
            { property: ENTRY.time, date: { before: "tomorrow" } },
          ],
        },
        sorts: byTime("ascending"),
      },
      { name: "收件匣", type: "table", filter: is(ENTRY.status, "select", STATUS.inbox), sorts: byTime("descending") },
      // 做完改成「已归档」、不做了改成「丢弃」，就会从这个视图消失
      {
        name: "待办",
        type: "table",
        filter: { and: [is(ENTRY.type, "select", "待办"), is(ENTRY.status, "select", STATUS.inbox)] },
        sorts: byTime("ascending"),
      },
      { name: "链接库", type: "gallery", filter: is(ENTRY.type, "select", "链接"), sorts: byTime("descending") },
      { name: "技术笔记", type: "list", filter: is(ENTRY.type, "select", "技术"), sorts: byTime("descending") },
      {
        name: "按主题",
        type: "board",
        sorts: byTime("descending"),
        configuration: (props) => ({
          type: "board",
          group_by: { type: "multi_select", property_id: props[ENTRY.tags].id, sort: { type: "manual" }, hide_empty_groups: true },
        }),
      },
    ],
  },
  {
    key: "NOTION_DAILY_DS",
    title: "Daily",
    properties: {
      [DAILY.title]: { title: {} },
      [DAILY.date]: { date: {} },
      [DAILY.summary]: { rich_text: {} },
    },
    relations: [{ name: DAILY.entries, target: "NOTION_ENTRIES_DS", syncedName: "日总结" }],
    rollups: {
      条数: { rollup: { relation_property_name: DAILY.entries, rollup_property_name: ENTRY.title, function: "count" } },
    },
    views: [{ name: "日记", type: "table", sorts: [{ property: DAILY.date, direction: "descending" }] }],
  },
  {
    key: "NOTION_WEEKLY_DS",
    title: "Weekly",
    properties: {
      [WEEKLY.title]: { title: {} },
      [WEEKLY.start]: { date: {} },
      [WEEKLY.end]: { date: {} },
    },
    relations: [{ name: WEEKLY.dailies, target: "NOTION_DAILY_DS", syncedName: "周回顾" }],
    views: [{ name: "周回顾", type: "table", sorts: [{ property: WEEKLY.start, direction: "descending" }] }],
  },
];

const problems = [];
const plain = (items = []) => items.map((t) => t.plain_text).join("");
const cleanId = (id = "") => id.replace(/-/g, "");
const typeOf = (schema) => Object.keys(schema)[0];

const vars = readDevVars();
const env = { NOTION_API_KEY: process.env.NOTION_API_KEY || vars.NOTION_API_KEY };
const parentInput = process.env.NOTION_PARENT_PAGE || vars.NOTION_PARENT_PAGE || "";
const parentId = parentInput.match(/[0-9a-f]{32}|[0-9a-f-]{36}/i)?.[0];

if (!env.NOTION_API_KEY || !parentId) {
  console.error("请在 .dev.vars 里填写 NOTION_API_KEY 和 NOTION_PARENT_PAGE（页面链接或 ID），见 .dev.vars.example");
  process.exit(1);
}

try {
  await notion(env, `/pages/${parentId}`);
} catch (err) {
  console.error(`无法访问父页面：${err.message}`);
  console.error("请在该页面右上角 ··· → 连接（Connections）中添加你的 Integration。");
  process.exit(1);
}

const sources = {}; // key → 数据源对象
for (const spec of DATABASES) await ensureDatabase(spec);
for (const spec of DATABASES) await ensureViews(spec, sources[spec.key]);

const ids = Object.fromEntries(Object.entries(sources).map(([key, ds]) => [key, ds.id]));
writeDevVars(ids);
console.log("\n已写入 .dev.vars：");
for (const [key, id] of Object.entries(ids)) console.log(`  ${key}=${id}`);

if (process.argv.includes("--secrets")) {
  console.log("\n上传为 Cloudflare secret：");
  for (const [key, id] of Object.entries(ids)) {
    execFileSync("npx", ["wrangler", "secret", "put", key], { cwd: ROOT, input: id, stdio: ["pipe", "inherit", "inherit"] });
  }
}

if (problems.length) {
  console.error("\n⚠️ 以下问题需要你在 Notion 里手动处理（脚本不会改动已有属性的类型）：");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\n✓ 完成");

async function ensureDatabase(spec) {
  let ds = await findDataSource(spec);
  if (ds) {
    console.log(`✓ 找到 ${spec.title}`);
  } else {
    const db = await notion(env, "/databases", "POST", {
      parent: { type: "page_id", page_id: parentId },
      title: [{ type: "text", text: { content: spec.title } }],
      initial_data_source: { properties: spec.properties },
    });
    ds = await notion(env, `/data_sources/${db.data_sources[0].id}`);
    console.log(`＋ 新建 ${spec.title}`);
  }
  sources[spec.key] = ds;

  ds = await addMissing(spec, ds, spec.properties);
  for (const rel of spec.relations || []) ds = await ensureRelation(spec, ds, rel);
  if (spec.rollups) ds = await addMissing(spec, ds, spec.rollups);
  sources[spec.key] = ds;
}

// 优先用 .dev.vars 里已有的数据源 ID，否则在父页面下按数据库标题查找
async function findDataSource(spec) {
  const id = process.env[spec.key] || vars[spec.key];
  if (id) {
    try {
      const ds = await notion(env, `/data_sources/${id}`);
      if (ds.properties && !ds.in_trash) return ds;
    } catch (err) {
      console.warn(`  .dev.vars 里的 ${spec.key} 无法访问（${err.message}），改为按名称查找`);
    }
  }

  const res = await notion(env, "/search", "POST", {
    query: spec.title,
    filter: { property: "object", value: "data_source" },
    page_size: 100,
  });
  const candidates = res.results.filter(
    (ds) => cleanId(ds.database_parent?.page_id) === cleanId(parentId) && !ds.in_trash && ds.parent?.database_id,
  );
  // 搜索按数据库标题匹配，但返回的是数据源，需要再取一次数据库确认标题
  for (const candidate of candidates) {
    const db = await notion(env, `/databases/${candidate.parent.database_id}`);
    if (plain(db.title) === spec.title && !db.in_trash) return notion(env, `/data_sources/${candidate.id}`);
  }
  return null;
}

async function addMissing(spec, ds, wanted) {
  const update = {};
  for (const [name, schema] of Object.entries(wanted)) {
    const current = ds.properties[name];
    const type = typeOf(schema);
    if (current) {
      if (current.type !== type) problems.push(`${spec.title} 的「${name}」类型是 ${current.type}，应为 ${type}`);
    } else if (type === "title") {
      // 每个数据源只有一个标题列，名字不对（例如默认的 Name）就改名
      const titleProp = Object.values(ds.properties).find((p) => p.type === "title");
      update[titleProp.id] = { name };
      console.log(`  ✎ ${spec.title}：标题列「${titleProp.name}」改名为「${name}」`);
    } else {
      update[name] = schema;
      console.log(`  ＋ ${spec.title}：新增属性「${name}」`);
    }
  }
  if (!Object.keys(update).length) return ds;
  return notion(env, `/data_sources/${ds.id}`, "PATCH", { properties: update });
}

// 双向关联：请求里直接指定对方的同步属性名；如果 Notion 没有采用，再改名一次
async function ensureRelation(spec, ds, rel) {
  const target = sources[rel.target];
  const current = ds.properties[rel.name];
  if (current) {
    if (current.type !== "relation") problems.push(`${spec.title} 的「${rel.name}」类型是 ${current.type}，应为 relation`);
    else if (cleanId(current.relation.data_source_id) !== cleanId(target.id)) {
      problems.push(`${spec.title} 的「${rel.name}」关联的不是 ${rel.target} 对应的数据源`);
    }
    return ds;
  }

  ds = await notion(env, `/data_sources/${ds.id}`, "PATCH", {
    properties: {
      [rel.name]: {
        relation: { data_source_id: target.id, type: "dual_property", dual_property: { synced_property_name: rel.syncedName } },
      },
    },
  });
  const syncedId = ds.properties[rel.name].relation.dual_property.synced_property_id;
  let targetDs = await notion(env, `/data_sources/${target.id}`);
  const synced = Object.values(targetDs.properties).find((p) => p.id === syncedId);
  if (synced && synced.name !== rel.syncedName) {
    targetDs = await notion(env, `/data_sources/${target.id}`, "PATCH", {
      properties: { [syncedId]: { name: rel.syncedName } },
    });
  }
  sources[rel.target] = targetDs;
  console.log(`  ＋ ${spec.title}：新增双向关联「${rel.name}」（对方显示为「${rel.syncedName}」）`);
  return ds;
}

// 按名称检查视图：已存在的不动；新建数据库自带的 Default view 改造成第一个表格视图
async function ensureViews(spec, ds) {
  const databaseId = ds.parent.database_id;
  const existing = await listViews(databaseId);
  const names = new Set(existing.map((v) => v.name));
  let defaultView = existing.find((v) => v.name === DEFAULT_VIEW && v.type === "table");

  for (const view of spec.views || []) {
    if (names.has(view.name)) continue;
    const body = {
      name: view.name,
      ...(view.filter && { filter: view.filter }),
      ...(view.sorts && { sorts: view.sorts }),
      ...(view.configuration && { configuration: view.configuration(ds.properties) }),
    };
    if (view.type === "table" && defaultView) {
      await notion(env, `/views/${defaultView.id}`, "PATCH", body);
      console.log(`  ✎ ${spec.title}：视图「${DEFAULT_VIEW}」改为「${view.name}」`);
      defaultView = null;
    } else {
      await notion(env, "/views", "POST", { database_id: databaseId, data_source_id: ds.id, type: view.type, ...body });
      console.log(`  ＋ ${spec.title}：新增视图「${view.name}」`);
    }
  }
}

// 列表接口只返回视图 ID，需要逐个取详情才能拿到名称
async function listViews(databaseId) {
  const refs = [];
  let cursor;
  do {
    const params = new URLSearchParams({ database_id: databaseId, page_size: "100", ...(cursor && { start_cursor: cursor }) });
    const res = await notion(env, `/views?${params}`);
    refs.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return Promise.all(refs.map((ref) => notion(env, `/views/${ref.id}`)));
}

function readDevVars() {
  if (!existsSync(DEV_VARS)) return {};
  const out = {};
  for (const line of readFileSync(DEV_VARS, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function writeDevVars(updates) {
  const lines = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, "utf8").split("\n") : [];
  while (lines.length && lines.at(-1) === "") lines.pop();
  for (const [key, value] of Object.entries(updates)) {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(DEV_VARS, lines.join("\n") + "\n");
}
