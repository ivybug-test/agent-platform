import OpenAI from "openai";

let _client: OpenAI | null = null;

export function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.LLM_API_KEY,
      baseURL: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
    });
  }
  return _client;
}

export function getModel(): string {
  return process.env.LLM_MODEL || "gpt-4o";
}
