import type { PreviewMeta } from "./og-parse";

/** Adapter for music.163.com song URLs. NetEase exposes a public song-info
 *  API that returns title + artist + cover keyed by the numeric song id
 *  embedded in the URL. */
export async function tryNeteaseCard(url: URL): Promise<PreviewMeta | null> {
  if (!/(^|\.)music\.163\.com$/.test(url.hostname)) return null;

  // NetEase URLs come in two shapes:
  //   https://music.163.com/song?id=12345
  //   https://music.163.com/#/song?id=12345     (hash-routed legacy)
  const idMatch =
    url.searchParams.get("id") ||
    url.hash.match(/[?&]id=(\d+)/)?.[1] ||
    null;
  if (!idMatch || !/^\d+$/.test(idMatch)) return null;

  try {
    const apiUrl = `https://music.163.com/api/song/detail/?ids=%5B${idMatch}%5D`;
    const res = await fetch(apiUrl, {
      headers: {
        Referer: "https://music.163.com/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      songs?: Array<{
        name?: string;
        artists?: Array<{ name?: string }>;
        album?: { name?: string; picUrl?: string };
      }>;
    };
    const song = data.songs?.[0];
    if (!song?.name) return null;

    const artist =
      (song.artists || [])
        .map((s) => s.name)
        .filter(Boolean)
        .join(" / ") || "未知歌手";

    return {
      title: `${song.name} - ${artist}`,
      description: song.album?.name ? `专辑：${song.album.name}` : "网易云音乐",
      image: song.album?.picUrl,
      siteName: "网易云音乐",
      favicon: "https://music.163.com/favicon.ico",
    };
  } catch {
    return null;
  }
}
