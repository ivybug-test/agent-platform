/** Compact relative timestamp for memory list rows. Within a day shows
 *  HH:mm, within a week shows weekday + HH:mm, else MM-DD. */
export function fmtMemoryTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = Date.now();
  const ms = d.getTime();
  const diffH = (now - ms) / 3600000;
  const sh = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = sh.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  if (diffH < 24) return `${get("hour")}:${get("minute")}`;
  if (diffH < 24 * 7) return `${get("weekday")} ${get("hour")}:${get("minute")}`;
  return `${get("month")}-${get("day")}`;
}
