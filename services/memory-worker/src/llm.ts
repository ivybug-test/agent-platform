import OpenAI from "openai";

let _client: OpenAI | null = null;
let _kimiClient: OpenAI | null = null;

const DEFAULT_TIMEOUT_MS = 90_000; // per-request timeout — hung DeepSeek won't stall cleanup

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.LLM_API_KEY,
      baseURL: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 1,
    });
  }
  return _client;
}

function getKimiClient(): OpenAI {
  if (!_kimiClient) {
    _kimiClient = new OpenAI({
      apiKey: process.env.KIMI_API_KEY,
      baseURL: process.env.KIMI_BASE_URL || "https://api.moonshot.cn/v1",
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 1,
    });
  }
  return _kimiClient;
}

/** Run a single vision pass on an image URL and return the model's caption.
 *  Used by the caption-image job to back-fill descriptions of image messages
 *  so text-only LLMs can still reference the image once it leaves the chat
 *  window. Returns the empty string on hard failure — the caller logs and
 *  decides whether to retry. */
export async function llmCaptionImage(imageUrl: string): Promise<{
  caption: string;
  model: string;
}> {
  // Moonshot rejects arbitrary HTTPS URLs ("unsupported image url") even when
  // they're publicly fetchable — pre-fetch and pass a base64 data URL. Kept
  // in sync with apps/web/src/lib/vision/caption.ts (sync path); this worker
  // is the async fallback for legacy or retry rows.
  const fetched = await fetch(imageUrl);
  if (!fetched.ok) throw new Error(`image fetch: HTTP ${fetched.status}`);
  const mime = fetched.headers.get("content-type") || "image/jpeg";
  const bytes = Buffer.from(await fetched.arrayBuffer());
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;

  const client = getKimiClient();
  const model = process.env.KIMI_VISION_MODEL || "kimi-k2.6";

  const res = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You describe images so a text-only assistant can reference them later. Reply in the language of the image's likely audience (Chinese if it shows Chinese text or context, otherwise English). One paragraph, 30-80 words. Capture: subject(s), notable text/OCR, setting, mood, anything that identifies the image. Do not editorialize.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    // K2.6 only allows temperature=1; sampling determinism comes from the
    // tight system prompt instead.
    temperature: 1,
    // K2.6 is a thinking model: reasoning_content burns from this same
    // budget. 300 left ~0 room for the actual caption ("length" finish,
    // empty content). 1500 gives ~1.2k for thinking + ~300 for the actual
    // 30-80 word description.
    max_tokens: 1500,
  });

  return {
    caption: res.choices[0]?.message?.content?.trim() || "",
    model,
  };
}

/** Call LLM and return the full text response (non-streaming) */
export async function llmComplete(
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const client = getClient();
  const model = process.env.LLM_MODEL || "gpt-4o";

  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
  });

  return res.choices[0]?.message?.content || "";
}

/** Call LLM and return parsed JSON response */
export async function llmCompleteJSON<T = unknown>(
  systemPrompt: string,
  userPrompt: string
): Promise<T> {
  const client = getClient();
  const model = process.env.LLM_MODEL || "gpt-4o";

  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
    // DeepSeek and most providers default output to 4096 tokens, which
    // gets clipped on large dedup batches and breaks JSON.parse. Push to
    // 8192 so a full batch's output can finish.
    max_tokens: 8192,
  });

  const choice = res.choices[0];
  const text = choice?.message?.content || "{}";
  if (choice?.finish_reason === "length") {
    throw new Error(
      "LLM output hit max_tokens (finish_reason=length); the JSON is truncated. Reduce batch size."
    );
  }
  return JSON.parse(text);
}
