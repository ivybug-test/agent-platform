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
