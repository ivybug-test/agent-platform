import type { ToolInvocation } from "@/components/chat/types";

export const TOOL_LABEL: Record<string, string> = {
  web_search: "搜索网页",
  search_lyrics: "搜索歌词",
  search_music: "搜索音乐",
  fetch_url: "读取网页",
};

export const VISIBLE_TOOLS = new Set([
  "web_search",
  "search_lyrics",
  "search_music",
  "fetch_url",
]);

/** Pull the user-facing label out of a (possibly partial) JSON args
 *  string. Tolerates malformed JSON — the SSE stream may deliver args in
 *  chunks, and we'd rather show the card with no query than crash. */
export function queryFromArgs(name: string, argsJson: string): string | undefined {
  if (!argsJson) return undefined;
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>;
    if (name === "search_lyrics") {
      const song = typeof obj.song === "string" ? obj.song : "";
      const artist = typeof obj.artist === "string" ? obj.artist : "";
      return artist ? `${song} ${artist}` : song || undefined;
    }
    if (name === "fetch_url") {
      return typeof obj.url === "string" ? obj.url : undefined;
    }
    return typeof obj.query === "string" ? obj.query : undefined;
  } catch {
    return undefined;
  }
}

/** Convert a raw tool_result payload (whatever the tool callback
 *  returned) into the trimmed shape we render. Mirrors the server-side
 *  buildInvocation in lib/chat/stream.ts. */
export function resolveToolInvocation(
  name: string,
  query: string | undefined,
  payload: any,
  ok: boolean
): ToolInvocation {
  const inv: ToolInvocation = { name };
  if (query) inv.query = query;
  if (!ok || !payload) {
    inv.error = payload?.error || "tool call failed";
    return inv;
  }
  if (name === "fetch_url") {
    if (payload.data?.url) {
      inv.fetched = {
        url: payload.data.url,
        title: payload.data.title,
        charCount: payload.data.charCount,
      };
    }
    if (payload.data?.provider) inv.provider = payload.data.provider;
    if (payload.error) inv.error = payload.error;
    return inv;
  }
  if (Array.isArray(payload.data?.results)) {
    inv.results = payload.data.results.map((r: any) => ({
      title: r.title || r.url,
      url: r.url,
      snippet: r.snippet,
    }));
  }
  if (payload.data?.provider) inv.provider = payload.data.provider;
  if (payload.error) inv.error = payload.error;
  return inv;
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
