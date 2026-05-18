/**
 * Server-side embedding helper. Lives in apps/web so tools running on the
 * Next.js API server can compute query embeddings without round-tripping
 * to the memory-worker. Lazy-loads the OpenAI SDK so the client bundle is
 * untouched — this file is server-only by virtue of where it's imported
 * (route.ts files).
 *
 * Smaller surface than services/memory-worker/src/embeddings.ts: just
 * `embedQuery` with built-in best-effort retry. Tools should treat NULL
 * returns as "fall back to non-cosine path".
 */

import { createLogger } from "@agent-platform/logger";

const log = createLogger("web:embeddings");

const PROVIDER = (process.env.EMBEDDING_PROVIDER || "openai").toLowerCase();
const MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || 1536);
const MINIMAX_BASE_URL =
  process.env.EMBEDDING_BASE_URL ||
  process.env.MINIMAX_BASE_URL ||
  "https://api.minimax.chat/v1";

// One OpenAI client per process — lazy so cold paths don't pay import cost.
let _client: unknown = null;

async function getClient() {
  if (_client) return _client;
  const { default: OpenAI } = await import("openai");
  const apiKey =
    process.env.EMBEDDING_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "embedding api key missing — set EMBEDDING_API_KEY (or OPENAI_API_KEY)"
    );
  }
  _client = new OpenAI({
    apiKey,
    baseURL: process.env.EMBEDDING_BASE_URL || "https://api.openai.com/v1",
    timeout: 8_000, // tool calls have a tight budget — fail fast
    maxRetries: 1, // one retry, then return null and let caller fall back
  });
  return _client;
}

// MiniMax has a non-OpenAI-compatible shape: body {model,texts,type} →
// resp {vectors,base_resp}. The tool path always passes type="query" so
// MiniMax's query-side encoder is used (matches stored doc-side embeddings
// produced by the worker's "db" calls).
async function minimaxEmbed(text: string): Promise<number[] | null> {
  const apiKey =
    process.env.EMBEDDING_API_KEY || process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    log.warn({}, "embed-query.minimax.no-key");
    return null;
  }
  const res = await fetch(`${MINIMAX_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, texts: [text], type: "query" }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    log.warn(
      { status: res.status },
      "embed-query.minimax.http-error"
    );
    return null;
  }
  const body = (await res.json()) as {
    vectors?: number[][];
    base_resp?: { status_code: number; status_msg: string };
  };
  const code = body.base_resp?.status_code;
  if (code !== 0) {
    log.warn(
      { code, msg: body.base_resp?.status_msg },
      "embed-query.minimax.logical-error"
    );
    return null;
  }
  const v = body.vectors?.[0];
  if (!v || v.length !== DIMENSIONS) {
    log.warn(
      { length: v?.length, expected: DIMENSIONS },
      "embed-query.minimax.bad-shape"
    );
    return null;
  }
  return v;
}

/** Embed a short query string. Returns null on empty input or any API
 *  failure — callers must fall back to a non-cosine path. Quiet on
 *  failure (warn-only) since the agent's tool call should still succeed
 *  via the trgm/ilike branch. */
export async function embedQuery(text: string): Promise<number[] | null> {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;

  if (PROVIDER === "minimax") {
    try {
      return await minimaxEmbed(trimmed);
    } catch (err) {
      log.warn(
        { err: (err as Error).message, queryPreview: trimmed.slice(0, 40) },
        "embed-query.minimax.failed"
      );
      return null;
    }
  }

  try {
    const client = (await getClient()) as {
      embeddings: {
        create: (args: {
          model: string;
          input: string;
          dimensions: number;
        }) => Promise<{ data: { embedding: number[] }[] }>;
      };
    };
    const res = await client.embeddings.create({
      model: MODEL,
      input: trimmed,
      dimensions: DIMENSIONS,
    });
    const v = res.data[0]?.embedding;
    if (!v || v.length !== DIMENSIONS) {
      log.warn(
        { length: v?.length, expected: DIMENSIONS },
        "embed-query.bad-shape"
      );
      return null;
    }
    return v;
  } catch (err) {
    log.warn(
      { err: (err as Error).message, queryPreview: trimmed.slice(0, 40) },
      "embed-query.failed"
    );
    return null;
  }
}

/** pgvector text literal: "[0.1,0.2,...]". Required for the `<=>` cosine
 *  distance operator in raw SQL fragments. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
