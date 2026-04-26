import type { ToolContext } from "@/lib/tool-token";

export type ToolHandler = (args: any, ctx: ToolContext) => Promise<unknown>;

import { memoryToolHandlers, memoryToolDefs } from "./memory-tools";
import { webSearchToolHandlers, webSearchToolDefs } from "./web-search-tools";
import { voiceToolHandlers, voiceToolDefs } from "./voice-tools";
import { imageReadToolHandlers, imageReadToolDefs } from "./image-read-tools";

/**
 * Registry of tools the agent can call. Entries keyed by the OpenAI
 * function.name the agent sees.
 */
export const toolRegistry: Record<string, ToolHandler> = {
  // Built-in verifier. Stays available so the callback roundtrip can be
  // smoke-tested without touching real data.
  _echo: async (args) => ({ echoed: args }),
  ...memoryToolHandlers,
  ...webSearchToolHandlers,
  ...voiceToolHandlers,
  ...imageReadToolHandlers,
};

/** OpenAI-shaped tool definitions passed to agent-runtime in the /chat body. */
export const agentToolDefs = [
  ...memoryToolDefs,
  ...webSearchToolDefs,
  ...voiceToolDefs,
  ...imageReadToolDefs,
];

export function getTool(name: string): ToolHandler | undefined {
  return toolRegistry[name];
}

/** Parse the `arguments` string the agent-runtime forwards (OpenAI sends JSON text). */
export function parseToolArgs(raw: unknown): any {
  if (typeof raw !== "string") return raw ?? {};
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // If the model emits invalid JSON, expose it as-is so handlers can decide
    return { _raw: raw };
  }
}
