import type { ReplyToSnippet } from "@/lib/redis";

/** Compact label shown inside both the quote chip (above input) and the
 *  inline quote block (above the reply bubble). Truncates and prefixes
 *  the original sender's name. Image quotes show "[图片]" instead of a
 *  URL so the chip stays readable. */
export function quotePreview(snippet: ReplyToSnippet, max = 60): string {
  const body =
    snippet.contentType === "image" ? "[图片]" : snippet.content || "";
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + "…";
}
