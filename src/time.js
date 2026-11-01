import { UTC_OFFSET_HOURS } from "./config.js";

const OFFSET = `+${String(UTC_OFFSET_HOURS).padStart(2, "0")}:00`;
const shift = (d) => new Date(d.getTime() + UTC_OFFSET_HOURS * 3600_000);

// 本地日期 YYYY-MM-DD
export const localDate = (d = new Date()) => shift(d).toISOString().slice(0, 10);

// 本地时间 YYYY-MM-DDTHH:mm:ss+08:00，用于写入 Notion
export const localDateTime = (d = new Date()) => shift(d).toISOString().slice(0, 19) + OFFSET;

// 本地时刻 HH:mm
export const localTime = (d) => shift(d).toISOString().slice(11, 16);

// 某天本地 00:00 的 ISO 字符串，用于 Notion 日期筛选
export const dayStart = (date) => `${date}T00:00:00${OFFSET}`;

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ISO 周编号，例如 2026-W44
export function isoWeek(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
