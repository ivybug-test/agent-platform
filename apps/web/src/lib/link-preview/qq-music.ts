import type { PreviewMeta } from "./og-parse";

/** Adapter for y.qq.com URLs. The static HTML is a near-empty SPA shell
 *  with no useful OG tags, so we extract the songmid from the URL and hit
 *  QQ Music's public song-detail endpoint to build a real card.
 *
 *  Returns null when the URL doesn't look like a song page or when the
 *  upstream API misbehaves — caller falls back to whatever the OG parser
 *  scraped (typically just the generic "QQ音乐" title). */
export async function tryQQMusicCard(url: URL): Promise<PreviewMeta | null> {
  if (!/(^|\.)y\.qq\.com$/.test(url.hostname)) return null;

  // Songmid lives in different query keys depending on which QQ Music page
  // surface generated the URL. Try each in turn.
  const songmid =
    url.searchParams.get("songmid") ||
    url.searchParams.get("songMid") ||
    url.pathname.match(/\/songDetail\/([A-Za-z0-9]+)/)?.[1] ||
    null;
  if (!songmid) return null;

  try {
    // c.y.qq.com is the legacy public read-only endpoint — no auth, JSONP-
    // ish JSON. Referer must be y.qq.com or the response is censored.
    const apiUrl = `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${encodeURIComponent(
      songmid
    )}&format=json&inCharset=utf-8&outCharset=utf-8&platform=yqq.json`;
    const res = await fetch(apiUrl, {
      headers: {
        Referer: "https://y.qq.com/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: Array<{
        name?: string;
        singer?: Array<{ name?: string }>;
        album?: { mid?: string; name?: string };
      }>;
    };
    const song = data.data?.[0];
    if (!song?.name) return null;

    const artist =
      (song.singer || [])
        .map((s) => s.name)
        .filter(Boolean)
        .join(" / ") || "未知歌手";
    const albumMid = song.album?.mid;
    const cover = albumMid
      ? `https://y.qq.com/music/photo_new/T002R300x300M000${albumMid}.jpg`
      : undefined;

    return {
      title: `${song.name} - ${artist}`,
      description: song.album?.name ? `专辑：${song.album.name}` : "QQ 音乐",
      image: cover,
      siteName: "QQ音乐",
      favicon: "https://y.qq.com/favicon.ico",
    };
  } catch {
    return null;
  }
}
