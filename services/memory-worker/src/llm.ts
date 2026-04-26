import OpenAI from "openai";

let _client: OpenAI | null = null;

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

const CAPTION_PROMPT =
  "Describe this image so a text-only assistant can reference it later. " +
  "Reply in the language of the image's likely audience (Chinese if it shows Chinese text or context, otherwise English). " +
  "One paragraph, 30-80 words. Capture: subject(s), notable text/OCR, setting, mood, anything that identifies the image. Do not editorialize.";

/** Run a single vision pass on an image URL and return the model's caption.
 *  Used by the caption-image job to back-fill descriptions of image messages
 *  so text-only LLMs can still reference the image once it leaves the chat
 *  window. Calls MiniMax Coding Plan's /v1/coding_plan/vlm endpoint. */
export async function llmCaptionImage(imageUrl: string): Promise<{
  caption: string;
  model: string;
}> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("MINIMAX_API_KEY not configured");
  const host =
    process.env.MINIMAX_CODING_PLAN_HOST || "https://api.minimaxi.com";

  // VLM only accepts JPEG/PNG/WebP and prefers a base64 data URL — the
  // official MCP also pre-fetches HTTP URLs to base64 on the client side.
  const fetched = await fetch(imageUrl);
  if (!fetched.ok) throw new Error(`image fetch: HTTP ${fetched.status}`);
  const mime = fetched.headers.get("content-type") || "image/jpeg";
  const bytes = Buffer.from(await fetched.arrayBuffer());
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;

  const res = await fetch(`${host}/v1/coding_plan/vlm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "MM-API-Source": "agent-platform",
    },
    body: JSON.stringify({
      prompt: CAPTION_PROMPT,
      image_url: dataUrl,
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`minimax vlm HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    content?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };
  const code = data.base_resp?.status_code;
  if (typeof code === "number" && code !== 0) {
    throw new Error(`minimax vlm ${code}: ${data.base_resp?.status_msg ?? ""}`);
  }

  return {
    caption: (data.content ?? "").trim(),
    model: "minimax-vlm",
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
