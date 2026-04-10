import OpenAI from "openai";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.LLM_API_KEY,
      baseURL: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
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
  });

  const text = res.choices[0]?.message?.content || "{}";
  return JSON.parse(text);
}
