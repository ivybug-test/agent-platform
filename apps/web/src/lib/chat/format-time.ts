/** Asia/Shanghai-localised parts of a timestamp, used for both the per-message
 *  HH:mm label and the cross-day divider text. */
const SH_FMT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hour12: false,
});

export function fmtTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const parts = SH_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("hour")}:${get("minute")}`;
}

export function dayKey(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const parts = SH_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function dayDividerLabel(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const parts = SH_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";

  const now = new Date();
  const today = dayKey(now.toISOString());
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const key = `${get("year")}-${get("month")}-${get("day")}`;
  if (key === today) return "今天";
  if (key === dayKey(yesterday.toISOString())) return "昨天";

  const curYear = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).format(now);
  const inCurYear = get("year") === curYear;
  const base = `${get("month")}月${get("day")}日 ${get("weekday")}`;
  return inCurYear ? base : `${get("year")}年${base}`;
}
