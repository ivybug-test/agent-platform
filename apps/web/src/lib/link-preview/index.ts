import { getRedisClient } from "@/lib/redis";
import { createLogger } from "@agent-platform/logger";
import { parseHtmlMeta, type PreviewMeta } from "./og-parse";
import { tryQQMusicCard } from "./qq-music";
import { tryNeteaseCard } from "./netease";

const log = createLogger("web");

const CACHE_TTL_SEC = 60 * 60; // 1 hour
const NEG_CACHE_TTL_SEC = 60; // 1 min — short so flaky URLs recover quickly
const FETCH_TIMEOUT_MS = 6000;
const FETCH_BYTE_CAP = 512 * 1024; // 512KB — head meta is always near the top

export interface PreviewResult extends PreviewMeta {
  url: string;
  host: string;
  /** Did we get anything beyond a bare host? false → frontend can render a
   *  minimal fallback card without breaking the layout. */
  ok: boolean;
}

const HOST_ADAPTERS: Array<(u: URL) => Promise<PreviewMeta | null>> = [
  tryQQMusicCard,
  tryNeteaseCard,
];

/** Validate a URL is safe to fetch from server-side. Drops localhost/private
 *  IPs and non-http(s) schemes — Tavily-style SSRF guard. */
function safeUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h)
  ) {
    return null;
  }
  return u;
}

async function fetchHtmlMeta(url: URL): Promise<PreviewMeta | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: {
        // OG-aware bots get the same response as humans these days; pose
        // as a normal browser to avoid surprise paywalls / soft 403s.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("html")) return null;

    // Stream up to FETCH_BYTE_CAP — OG meta lives in the <head>, no need
    // to download a 5MB article body.
    const reader = res.body?.getReader();
    if (!reader) return null;
    let received = 0;
    const chunks: Uint8Array[] = [];
    while (received < FETCH_BYTE_CAP) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      received += value.byteLength;
    }
    try {
      await reader.cancel();
    } catch {}
    const html = Buffer.concat(
      chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))
    ).toString("utf8");
    return parseHtmlMeta(html, url.toString());
  } catch (err) {
    log.warn(
      { err: (err as Error)?.message, url: url.toString() },
      "linkpreview.fetch-error"
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Build a preview card payload for a URL. Tries host-specific adapters
 *  first (so QQ Music / NetEase get rich data even though their static
 *  HTML is a SPA shell), falls back to OG/Twitter/title scraping. Caches
 *  results in Redis. */
export async function getLinkPreview(rawUrl: string): Promise<PreviewResult> {
  const u = safeUrl(rawUrl);
  if (!u) {
    return { url: rawUrl, host: "", ok: false };
  }
  const canonical = u.toString();
  const cacheKey = `linkpreview:${canonical}`;

  // Cache lookup — both positive and negative caches share the key. The
  // body itself encodes whether the lookup succeeded (`ok: true/false`).
  try {
    const redis = getRedisClient();
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as PreviewResult;
  } catch (err) {
    log.warn({ err: (err as Error)?.message }, "linkpreview.redis-get-error");
  }

  // Host-specific adapters first (they hit clean APIs). Only fall back to
  // HTML scraping if no adapter produced a card.
  let meta: PreviewMeta | null = null;
  for (const adapter of HOST_ADAPTERS) {
    try {
      meta = await adapter(u);
      if (meta) break;
    } catch (err) {
      log.warn(
        { err: (err as Error)?.message, host: u.hostname },
        "linkpreview.adapter-error"
      );
    }
  }
  if (!meta) {
    meta = await fetchHtmlMeta(u);
  }

  // Even on a complete fetch failure we hand the frontend a guessed
  // favicon URL — `<host>/favicon.ico` is the convention 90% of sites
  // honour, and the card's <img onError> quietly hides it if it 404s.
  // Without this the card collapses to a bare hostname which looks broken.
  const fallbackFavicon = `${u.origin}/favicon.ico`;

  const result: PreviewResult = meta
    ? {
        url: canonical,
        host: u.hostname,
        ok: !!(meta.title || meta.description || meta.image),
        ...meta,
        favicon: meta.favicon || fallbackFavicon,
      }
    : {
        url: canonical,
        host: u.hostname,
        ok: false,
        favicon: fallbackFavicon,
      };

  try {
    const redis = getRedisClient();
    const ttl = result.ok ? CACHE_TTL_SEC : NEG_CACHE_TTL_SEC;
    await redis.set(cacheKey, JSON.stringify(result), "EX", ttl);
  } catch (err) {
    log.warn({ err: (err as Error)?.message }, "linkpreview.redis-set-error");
  }

  return result;
}
