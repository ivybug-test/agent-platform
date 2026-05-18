import OpenAI from "openai";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("memory-worker:embeddings");

let _client: OpenAI | null = null;

const EMBEDDING_TIMEOUT_MS = 30_000;
const EMBEDDING_MAX_RETRIES = 3;

// EMBEDDING_PROVIDER selects request shape:
//   "openai" (default) — OpenAI SDK; works for OpenAI / DashScope-compat /
//                        SiliconFlow / any OAI-compatible endpoint.
//   "minimax"          — fetch-based; MiniMax /v1/embeddings has a custom
//                        shape: body {model,texts,type} → resp {vectors,base_resp}.
const PROVIDER = (process.env.EMBEDDING_PROVIDER || "openai").toLowerCase();

function getClient(): OpenAI {
  if (!_client) {
    // EMBEDDING_API_KEY / EMBEDDING_BASE_URL are optional overrides so the
    // embedding provider can differ from the chat LLM (e.g. local proxy
    // for chat, OpenAI for embeddings). Falls back to the chat provider's
    // creds if those aren't set.
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
      baseURL:
        process.env.EMBEDDING_BASE_URL || "https://api.openai.com/v1",
      timeout: EMBEDDING_TIMEOUT_MS,
      maxRetries: 0, // we do our own retry with backoff below
    });
  }
  return _client;
}

const MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || 1536);
const MINIMAX_BASE_URL =
  process.env.EMBEDDING_BASE_URL ||
  process.env.MINIMAX_BASE_URL ||
  "https://api.minimax.chat/v1";
// MiniMax's `type` field tells them whether this is a document being
// stored or a query lookup; they use slightly different encoders. We
// always use "db" because backfill / write-path both store; the on-demand
// query path passes "query" via embedQuery (apps/web).
async function minimaxEmbed(
  texts: string[],
  type: "db" | "query"
): Promise<number[][]> {
  const apiKey =
    process.env.EMBEDDING_API_KEY || process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MiniMax embedding key missing — set EMBEDDING_API_KEY or MINIMAX_API_KEY"
    );
  }
  const res = await fetch(`${MINIMAX_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, texts, type }),
    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
  });
  if (!res.ok) {
    // surface HTTP-level failure so withRetry can decide whether to retry
    const text = await res.text().catch(() => "");
    const err = new Error(
      `minimax embedding http ${res.status}: ${text.slice(0, 200)}`
    );
    (err as { status?: number }).status = res.status;
    throw err;
  }
  const body = (await res.json()) as {
    vectors?: number[][];
    base_resp?: { status_code: number; status_msg: string };
  };
  const code = body.base_resp?.status_code;
  if (code !== 0) {
    // MiniMax returns 200 OK even on logical failure (e.g. 1008 insufficient
    // balance). Treat non-zero status_code as a hard error.
    throw new Error(
      `minimax embedding status ${code}: ${body.base_resp?.status_msg ?? "unknown"}`
    );
  }
  if (!body.vectors || body.vectors.length !== texts.length) {
    throw new Error(
      `minimax embedding shape mismatch: got ${body.vectors?.length} expected ${texts.length}`
    );
  }
  return body.vectors;
}

// Whitespace-only strings make the API error. Treat empty text as a
// no-op and return a null embedding so callers can skip storage.
function isEmpty(s: string): boolean {
  return !s || s.trim().length === 0;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < EMBEDDING_MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      // 4xx that aren't 429 won't recover — don't burn retries
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }
      const backoff = 500 * Math.pow(2, i); // 500ms, 1s, 2s
      log.warn(
        { label, attempt: i + 1, err: (err as Error).message, backoff },
        "embedding.retry"
      );
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/** Embed a single text into a 1536-d vector. Returns null for empty input
 *  so callers can store NULL and skip later. Throws after EMBEDDING_MAX_RETRIES
 *  on transient failures — caller decides whether to drop the write or
 *  enqueue a retry job. */
export async function embedOne(text: string): Promise<number[] | null> {
  if (isEmpty(text)) return null;

  if (PROVIDER === "minimax") {
    const vectors = await withRetry(
      () => minimaxEmbed([text], "db"),
      "embedOne.minimax"
    );
    const v = vectors[0];
    if (!v || v.length !== DIMENSIONS) {
      throw new Error(
        `embedding response shape unexpected: got ${v?.length} expected ${DIMENSIONS}`
      );
    }
    return v;
  }

  const client = getClient();
  const res = await withRetry(
    () =>
      client.embeddings.create({
        model: MODEL,
        input: text,
        dimensions: DIMENSIONS,
      }),
    "embedOne"
  );
  const v = res.data[0]?.embedding;
  if (!v || v.length !== DIMENSIONS) {
    throw new Error(
      `embedding response shape unexpected: got ${v?.length} expected ${DIMENSIONS}`
    );
  }
  return v;
}

/** Embed a batch of texts in one API call. Empty entries get a NULL slot
 *  preserved in the returned array so the caller can map back to source
 *  rows positionally. OpenAI caps at 2048 inputs / ~8000 tokens per input —
 *  the caller is responsible for chunking. */
export async function embedBatch(
  texts: string[]
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const out: (number[] | null)[] = new Array(texts.length).fill(null);
  const nonEmpty: { idx: number; text: string }[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (!isEmpty(texts[i])) nonEmpty.push({ idx: i, text: texts[i] });
  }
  if (nonEmpty.length === 0) return out;

  if (PROVIDER === "minimax") {
    const vectors = await withRetry(
      () => minimaxEmbed(nonEmpty.map((x) => x.text), "db"),
      "embedBatch.minimax"
    );
    for (let i = 0; i < nonEmpty.length; i++) {
      const v = vectors[i];
      if (!v || v.length !== DIMENSIONS) {
        throw new Error(`embedding ${i} shape unexpected`);
      }
      out[nonEmpty[i].idx] = v;
    }
    return out;
  }

  const client = getClient();
  const res = await withRetry(
    () =>
      client.embeddings.create({
        model: MODEL,
        input: nonEmpty.map((x) => x.text),
        dimensions: DIMENSIONS,
      }),
    "embedBatch"
  );
  if (res.data.length !== nonEmpty.length) {
    throw new Error(
      `embedding batch size mismatch: got ${res.data.length} expected ${nonEmpty.length}`
    );
  }
  for (let i = 0; i < nonEmpty.length; i++) {
    const v = res.data[i]?.embedding;
    if (!v || v.length !== DIMENSIONS) {
      throw new Error(`embedding ${i} shape unexpected`);
    }
    out[nonEmpty[i].idx] = v;
  }
  return out;
}

/** Format a number[] as the literal pgvector text representation:
 *  "[0.1,0.2,...]". Drizzle handles this when using the `vector` column
 *  type via parameterized inserts, but raw sql`...` queries (used for
 *  bulk back-fill) need the literal. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
