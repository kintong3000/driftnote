// 检查 Notion 里的三个数据库：不存在就新建，缺少的属性自动补上。
// 可以重复运行，已经正确的部分不会改动。
//
// 用法：npm run setup:notion            # 只更新本地 .dev.vars
//       npm run setup:notion -- --secrets  # 同时把数据库 ID 上传为 Cloudflare secret
//
// 需要在 .dev.vars（或环境变量）里提供：
//   NOTION_API_KEY      Integration token
//   NOTION_PARENT_PAGE  存放数据库的页面链接或 ID（需要先把 Integration 连接到这个页面）

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DAILY, ENTRY, STATUS, TAGS, TYPES, WEEKLY } from "../src/config.js";
import { notion } from "../src/notion.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEV_VARS = fileURLToPath(new URL("../.dev.vars", import.meta.url));

const options = (names) => ({ options: names.map((name) => ({ name })) });

// 被 Worker 读写的属性名来自 src/config.js；下面几个只在 Notion 里显示，代码不读写
const DATABASES = [
  {
    key: "NOTION_ENTRIES_DB",
    title: "Entries",
    properties: {
      [ENTRY.title]: { title: {} },
      [ENTRY.time]: { date: {} },
      [ENTRY.source]: { select: options(["telegram", "ios-share", "ios-voice", "terminal", "browser", "claude-code"]) },
      [ENTRY.type]: { select: options(TYPES) },
      [ENTRY.url]: { url: {} },
      [ENTRY.content]: { rich_text: {} },
      [ENTRY.tags]: { multi_select: options(TAGS) },
      [ENTRY.status]: { select: options(Object.values(STATUS)) },
      [ENTRY.aiDone]: { checkbox: {} },
      [ENTRY.externalId]: { rich_text: {} },
    },
  },
  {
    key: "NOTION_DAILY_DB",
    title: "Daily",
    properties: {
      [DAILY.title]: { title: {} },
      [DAILY.date]: { date: {} },
      [DAILY.summary]: { rich_text: {} },
    },
    relations: [{ name: DAILY.entries, target: "NOTION_ENTRIES_DB", syncedName: "日总结" }],
    rollups: {
      条数: { rollup: { relation_property_name: DAILY.entries, rollup_property_name: ENTRY.title, function: "count" } },
    },
  },
  {
    key: "NOTION_WEEKLY_DB",
    title: "Weekly",
    properties: {
      [WEEKLY.title]: { title: {} },
      [WEEKLY.start]: { date: {} },
      [WEEKLY.end]: { date: {} },
    },
    relations: [{ name: WEEKLY.dailies, target: "NOTION_DAILY_DB", syncedName: "周回顾" }],
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

const ids = {};
for (const spec of DATABASES) await ensureDatabase(spec);

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
  let db = await findDatabase(spec);
  if (db) {
    console.log(`✓ 找到 ${spec.title}`);
  } else {
    db = await notion(env, "/databases", "POST", {
      parent: { type: "page_id", page_id: parentId },
      title: [{ type: "text", text: { content: spec.title } }],
      properties: spec.properties,
    });
    console.log(`＋ 新建 ${spec.title}`);
  }
  ids[spec.key] = db.id;

  db = await addMissing(spec, db, spec.properties);
  for (const rel of spec.relations || []) db = await ensureRelation(spec, db, rel);
  if (spec.rollups) await addMissing(spec, db, spec.rollups);
}

// 优先用 .dev.vars 里已有的 ID，否则在父页面下按标题查找
async function findDatabase(spec) {
  const id = process.env[spec.key] || vars[spec.key];
  if (id) {
    try {
      return await notion(env, `/databases/${id}`);
    } catch (err) {
      console.warn(`  .dev.vars 里的 ${spec.key} 无法访问（${err.message}），改为按名称查找`);
    }
  }
  const res = await notion(env, "/search", "POST", {
    query: spec.title,
    filter: { property: "object", value: "database" },
    page_size: 100,
  });
  return res.results.find(
    (db) => cleanId(db.parent?.page_id) === cleanId(parentId) && plain(db.title) === spec.title && !db.archived && !db.in_trash,
  );
}

async function addMissing(spec, db, wanted) {
  const update = {};
  for (const [name, schema] of Object.entries(wanted)) {
    const current = db.properties[name];
    const type = typeOf(schema);
    if (current) {
      if (current.type !== type) problems.push(`${spec.title} 的「${name}」类型是 ${current.type}，应为 ${type}`);
    } else if (type === "title") {
      // 每个数据库只有一个标题列，名字不对（例如默认的 Name）就改名
      const titleProp = Object.values(db.properties).find((p) => p.type === "title");
      update[titleProp.id] = { name };
      console.log(`  ✎ ${spec.title}：标题列「${titleProp.name}」改名为「${name}」`);
    } else {
      update[name] = schema;
      console.log(`  ＋ ${spec.title}：新增属性「${name}」`);
    }
  }
  if (!Object.keys(update).length) return db;
  return notion(env, `/databases/${db.id}`, "PATCH", { properties: update });
}

// 双向关联：新建后把对方库里自动生成的同步属性改成指定名字
async function ensureRelation(spec, db, rel) {
  const targetId = ids[rel.target];
  const current = db.properties[rel.name];
  if (current) {
    if (current.type !== "relation") problems.push(`${spec.title} 的「${rel.name}」类型是 ${current.type}，应为 relation`);
    else if (cleanId(current.relation.database_id) !== cleanId(targetId)) {
      problems.push(`${spec.title} 的「${rel.name}」关联的不是 ${rel.target} 对应的数据库`);
    }
    return db;
  }

  db = await notion(env, `/databases/${db.id}`, "PATCH", {
    properties: { [rel.name]: { relation: { database_id: targetId, type: "dual_property", dual_property: {} } } },
  });
  const synced = db.properties[rel.name].relation.dual_property;
  await notion(env, `/databases/${targetId}`, "PATCH", {
    properties: { [synced.synced_property_id]: { name: rel.syncedName } },
  });
  console.log(`  ＋ ${spec.title}：新增双向关联「${rel.name}」（对方显示为「${rel.syncedName}」）`);
  return db;
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
