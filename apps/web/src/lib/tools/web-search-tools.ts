import { getRedisClient } from "@/lib/redis";
import { createLogger } from "@agent-platform/logger";
import type { ToolHandler } from "./index";

const log = createLogger("web");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

interface SearchResponse {
  results: SearchHit[];
  total: number;
  provider: string;
}

interface SearchProvider {
  readonly name: string;
  search(query: string, max: number): Promise<SearchHit[]>;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const SNIPPET_MAX = 300;
const MAX_RESULTS_CAP = 5;

function clampLimit(n: unknown, dflt: number, max: number): number {
  const v = typeof n === "number" ? Math.floor(n) : dflt;
  if (!Number.isFinite(v) || v <= 0) return dflt;
  return Math.min(v, max);
}

function trimSnippet(s: string): string {
  // Strip HTML tags (Bocha sometimes wraps query terms in <b>) + collapse
  // whitespace + cap length so the model doesn't drown in long snippets.
  const stripped = s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return stripped.length > SNIPPET_MAX
    ? stripped.slice(0, SNIPPET_MAX - 1) + "…"
    : stripped;
}

function normalizeUrl(u: string): string {
  // Best-effort dedupe key — strip fragment + trailing slash.
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    let pathname = parsed.pathname.replace(/\/$/, "");
    if (!pathname) pathname = "/";
    return `${parsed.host}${pathname}${parsed.search}`;
  } catch {
    return u;
  }
}

function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const key = normalizeUrl(h.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Providers — each owns its own key env var so two providers can be
// configured at once (primary + fallback).
// -----------------------------------------------------------------------------

const bochaProvider: SearchProvider = {
  name: "bocha",
  async search(query, max) {
    const apiKey = process.env.BOCHA_API_KEY;
    if (!apiKey) throw new Error("BOCHA_API_KEY not configured");
    const res = await fetch("https://api.bochaai.com/v1/web-search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        count: max,
        freshness: "noLimit",
        summary: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`bocha ${res.status}`);
    }
    const data = (await res.json()) as {
      data?: { webPages?: { value?: Array<{ name: string; url: string; summary?: string; snippet?: string }> } };
    };
    const items = data.data?.webPages?.value ?? [];
    return items.map((it) => ({
      title: it.name ?? "",
      url: it.url ?? "",
      snippet: trimSnippet(it.summary ?? it.snippet ?? ""),
    }));
  },
};

const tavilyProvider: SearchProvider = {
  name: "tavily",
  async search(query, max) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error("TAVILY_API_KEY not configured");
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: max,
        search_depth: "basic",
      }),
    });
    if (!res.ok) {
      throw new Error(`tavily ${res.status}`);
    }
    const data = (await res.json()) as {
      results?: Array<{ title: string; url: string; content?: string }>;
    };
    return (data.results ?? []).map((it) => ({
      title: it.title ?? "",
      url: it.url ?? "",
      snippet: trimSnippet(it.content ?? ""),
    }));
  },
};

const PROVIDERS: Record<string, SearchProvider> = {
  bocha: bochaProvider,
  tavily: tavilyProvider,
};

interface ProviderChain {
  primary: SearchProvider;
  fallback: SearchProvider | null;
}

function getProviderChain(): ProviderChain | null {
  const primaryName = (process.env.WEB_SEARCH_PRIMARY || "bocha").toLowerCase();
  const fallbackName = (process.env.WEB_SEARCH_FALLBACK || "").toLowerCase();
  const primary = PROVIDERS[primaryName];
  if (!primary) return null;
  const fallback =
    fallbackName && fallbackName !== primaryName ? PROVIDERS[fallbackName] ?? null : null;
  return { primary, fallback };
}

/** Check whether a provider has its key configured; the chain only attempts
 *  providers whose keys are present, so a missing fallback key just collapses
 *  the chain to "primary only". */
function isConfigured(p: SearchProvider): boolean {
  if (p.name === "bocha") return !!process.env.BOCHA_API_KEY;
  if (p.name === "tavily") return !!process.env.TAVILY_API_KEY;
  return false;
}

// -----------------------------------------------------------------------------
// fetch_url — only used when the user pastes a URL into the chat. Pulls the
// cleaned text content via Tavily's /extract endpoint.
// -----------------------------------------------------------------------------

const FETCH_CONTENT_MAX = 8000; // chars; ~2-3K tokens
const FETCH_RATE_PER_MIN = 5;
const FETCH_RATE_PER_DAY = 100;

interface FetchUrlResult {
  url: string;
  title?: string;
  content: string;
  charCount: number;
  provider: string;
}

async function tavilyExtract(url: string): Promise<FetchUrlResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not configured");
  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      urls: [url],
      extract_depth: "basic",
    }),
  });
  if (!res.ok) {
    throw new Error(`tavily extract ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    results?: Array<{ url: string; raw_content?: string; title?: string }>;
    failed_results?: Array<{ url: string; error?: string }>;
  };
  const hit = data.results?.[0];
  if (!hit) {
    const failure = data.failed_results?.[0];
    throw new Error(failure?.error || "tavily returned no content");
  }
  const raw = (hit.raw_content || "").replace(/\s+\n/g, "\n").trim();
  const truncated = raw.length > FETCH_CONTENT_MAX
    ? raw.slice(0, FETCH_CONTENT_MAX) + "\n\n[...truncated]"
    : raw;
  return {
    url: hit.url,
    title: hit.title,
    content: truncated,
    charCount: raw.length,
    provider: "tavily",
  };
}

const fetchUrlCache = new Map<string, { ts: number; data: FetchUrlResult }>();

async function checkFetchRateLimit(userId: string): Promise<{
  ok: boolean;
  retryAfterSec?: number;
}> {
  try {
    const redis = getRedisClient();
    const minute = Math.floor(Date.now() / 60000);
    const day = Math.floor(Date.now() / 86400000);
    const minKey = `fetchurl:min:${userId}:${minute}`;
    const dayKey = `fetchurl:day:${userId}:${day}`;
    const [minCount, dayCount] = await Promise.all([
      redis.incr(minKey),
      redis.incr(dayKey),
    ]);
    if (minCount === 1) await redis.expire(minKey, 65);
    if (dayCount === 1) await redis.expire(dayKey, 86400);
    if (minCount > FETCH_RATE_PER_MIN) return { ok: false, retryAfterSec: 60 };
    if (dayCount > FETCH_RATE_PER_DAY)
      return { ok: false, retryAfterSec: 86400 };
    return { ok: true };
  } catch (err) {
    log.warn({ err }, "fetchurl.ratelimit-redis-error");
    return { ok: true };
  }
}

const fetchUrl: ToolHandler = async (args, ctx) => {
  const url = typeof args?.url === "string" ? args.url.trim() : "";
  if (!url) return { error: "url is required" };

  // Cheap upfront sanity: only public http(s) URLs. Tavily handles SSRF
  // server-side, but rejecting local-looking targets early gives a cleaner
  // error and stops obvious misuse.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "invalid url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "only http(s) urls are supported" };
  }
  if (
    /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1)/i.test(parsed.hostname)
  ) {
    return { error: "internal urls are not allowed" };
  }

  const cached = fetchUrlCache.get(url);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    return { data: cached.data };
  }

  const rate = await checkFetchRateLimit(ctx.userId);
  if (!rate.ok) {
    return { error: "rate limit", retryAfterSec: rate.retryAfterSec };
  }

  const startedAt = Date.now();
  try {
    const result = await tavilyExtract(url);
    fetchUrlCache.set(url, { ts: Date.now(), data: result });
    if (fetchUrlCache.size > 128) {
      const oldest = fetchUrlCache.keys().next().value;
      if (oldest) fetchUrlCache.delete(oldest);
    }
    log.info(
      {
        userId: ctx.userId,
        url,
        charCount: result.charCount,
        durationMs: Date.now() - startedAt,
      },
      "fetchurl.complete"
    );
    return { data: result };
  } catch (err: any) {
    log.error(
      { err: err?.message, url, userId: ctx.userId },
      "fetchurl.error"
    );
    return { error: `fetch failed: ${err?.message || "unknown"}` };
  }
};

// -----------------------------------------------------------------------------
// In-memory cache (5 min TTL) — same query/provider key only hits the network
// once per window. Acts as both a cost guardrail and a soft de-dup if the
// model emits the same query twice in one tool loop.
// -----------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedHit {
  results: SearchHit[];
  /** Which provider produced the cached results — surfaced back to the
   *  caller so the response stays honest about provenance. */
  provider: string;
}

const cache = new Map<string, { ts: number; data: CachedHit }>();

function cacheGet(key: string): CachedHit | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key: string, data: CachedHit) {
  // Bound the map; drop oldest if it's grown beyond a reasonable size.
  if (cache.size > 256) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { ts: Date.now(), data });
}

// -----------------------------------------------------------------------------
// Per-user rate limit (10/min, 200/day) — uses the shared Redis client.
// -----------------------------------------------------------------------------

const RATE_PER_MIN = 10;
const RATE_PER_DAY = 200;

async function checkRateLimit(userId: string): Promise<{
  ok: boolean;
  retryAfterSec?: number;
}> {
  try {
    const redis = getRedisClient();
    const minute = Math.floor(Date.now() / 60000);
    const day = Math.floor(Date.now() / 86400000);
    const minKey = `websearch:min:${userId}:${minute}`;
    const dayKey = `websearch:day:${userId}:${day}`;

    const [minCount, dayCount] = await Promise.all([
      redis.incr(minKey),
      redis.incr(dayKey),
    ]);
    if (minCount === 1) await redis.expire(minKey, 65);
    if (dayCount === 1) await redis.expire(dayKey, 86400);

    if (minCount > RATE_PER_MIN) {
      return { ok: false, retryAfterSec: 60 };
    }
    if (dayCount > RATE_PER_DAY) {
      return { ok: false, retryAfterSec: 86400 };
    }
    return { ok: true };
  } catch (err) {
    // If Redis hiccups, fail open — better to serve the call than block.
    log.warn({ err }, "websearch.ratelimit-redis-error");
    return { ok: true };
  }
}

// -----------------------------------------------------------------------------
// Core search routine — used by both web_search and search_lyrics.
// -----------------------------------------------------------------------------

async function runSearch(
  query: string,
  maxResults: number,
  userId: string
): Promise<{ data: SearchResponse } | { error: string; retryAfterSec?: number }> {
  if (!query || !query.trim()) {
    return { error: "query is required" };
  }
  const trimmed = query.trim().slice(0, 200);
  const max = clampLimit(maxResults, MAX_RESULTS_CAP, MAX_RESULTS_CAP);

  const chain = getProviderChain();
  if (!chain) {
    return { error: "web search not configured (unknown provider)" };
  }

  // Build the actual attempt list — drop any provider missing its key.
  const attempts: SearchProvider[] = [chain.primary, chain.fallback]
    .filter((p): p is SearchProvider => !!p)
    .filter(isConfigured);

  if (attempts.length === 0) {
    return { error: "web search not configured (API key missing)" };
  }

  const rate = await checkRateLimit(userId);
  if (!rate.ok) {
    return { error: "rate limit", retryAfterSec: rate.retryAfterSec };
  }

  // Cache lookup is provider-agnostic (query + max) — once any provider has
  // answered, both primary and fallback short-circuit on the cached value.
  const cacheKey = `${trimmed}:${max}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return {
      data: {
        results: cached.results.slice(0, max),
        total: cached.results.length,
        provider: cached.provider,
      },
    };
  }

  const errors: string[] = [];
  for (const provider of attempts) {
    const startedAt = Date.now();
    try {
      const hits = await provider.search(trimmed, max);
      const deduped = dedupeHits(hits).slice(0, max);
      cacheSet(cacheKey, { results: deduped, provider: provider.name });
      log.info(
        {
          userId,
          query: trimmed,
          provider: provider.name,
          resultCount: deduped.length,
          durationMs: Date.now() - startedAt,
          attempt: errors.length + 1,
        },
        "websearch.complete"
      );
      return {
        data: {
          results: deduped,
          total: deduped.length,
          provider: provider.name,
        },
      };
    } catch (err: any) {
      const msg = err?.message || "unknown";
      errors.push(`${provider.name}: ${msg}`);
      log.warn(
        { err: msg, query: trimmed, provider: provider.name },
        attempts.length > errors.length
          ? "websearch.provider-error-falling-back"
          : "websearch.provider-error-final"
      );
    }
  }

  return { error: `search failed: ${errors.join(" | ")}` };
}

// -----------------------------------------------------------------------------
// Tool handlers
// -----------------------------------------------------------------------------

const webSearch: ToolHandler = async (args, ctx) => {
  const query = typeof args?.query === "string" ? args.query : "";
  const max = clampLimit(args?.max_results, MAX_RESULTS_CAP, MAX_RESULTS_CAP);
  const out = await runSearch(query, max, ctx.userId);
  return out;
};

const searchLyrics: ToolHandler = async (args, ctx) => {
  const song = typeof args?.song === "string" ? args.song.trim() : "";
  const artist = typeof args?.artist === "string" ? args.artist.trim() : "";
  if (!song) return { error: "song is required" };
  // Domestic music sites first — Bocha / Tavily both honour the site:
  // operator. A small site-bias is worth a lot for the singing flow.
  const query = `${song}${artist ? " " + artist : ""} 歌词 site:y.qq.com OR site:music.163.com`;
  const out = await runSearch(query, MAX_RESULTS_CAP, ctx.userId);
  return out;
};

/** Free-form music search scoped to QQ 音乐 / 网易云. Use for browse-y
 *  queries that don't have a specific song name — "周杰伦的歌",
 *  "适合开车听的歌", "最近华语流行新歌", artist discography, album
 *  lookups, etc. search_lyrics is for "I have a specific song name and
 *  want lyrics + a stream link"; this one is for everything else
 *  music-related. */
const searchMusic: ToolHandler = async (args, ctx) => {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) return { error: "query is required" };
  const scoped = `${query} site:y.qq.com OR site:music.163.com`;
  const out = await runSearch(scoped, MAX_RESULTS_CAP, ctx.userId);
  return out;
};

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

export const webSearchToolHandlers: Record<string, ToolHandler> = {
  web_search: webSearch,
  search_lyrics: searchLyrics,
  search_music: searchMusic,
  fetch_url: fetchUrl,
};

export const webSearchToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description:
        "Search the live web. Use ONLY when the user asks about current events, real-world facts, products, or links you cannot answer from memory or training. Returns up to 5 results with title/url/snippet. Cite the URL inline in your reply when you use a result.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description:
              "Search query in the user's language. Keep it concise — under 200 characters.",
          },
          max_results: {
            type: "integer",
            description: "Max results (1–5). Default 5.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_lyrics",
      description:
        "Find lyrics and a streaming link (QQ Music / NetEase) for a specific song. Prefer this over web_search when the user asks you to sing or quote a song — results are pre-filtered to Chinese music sites.",
      parameters: {
        type: "object",
        required: ["song"],
        properties: {
          song: { type: "string", description: "Song title." },
          artist: {
            type: "string",
            description: "Artist or band name (optional, but improves results).",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_music",
      description:
        "Search QQ 音乐 / 网易云 for songs / artists / albums / playlists. Use for browse-y queries that don't have a specific song title — '周杰伦的歌' / '适合通勤听的歌' / artist discography lookups / new releases / etc. Use search_lyrics instead when the user names a SPECIFIC song they want to hear or quote.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description:
              "Music-related search terms. Free form — artist name, mood, genre, album, etc. Don't add 'site:' yourself; the tool already scopes to music platforms.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fetch_url",
      description:
        "Read the actual content of a webpage. Returns up to ~8000 chars of cleaned article text. Call this ONLY when the user pasted a URL into the chat and you need to know what's on the page (article body, full lyrics, README, doc page, etc.). DO NOT call this for URLs you found yourself via web_search — the snippet is enough for those. One URL per call.",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: {
            type: "string",
            description:
              "The fully-qualified http(s) URL the user gave you. Must start with http:// or https://.",
          },
        },
      },
    },
  },
];
