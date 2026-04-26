import { minimaxProvider } from "./minimax";
import { mockProvider } from "./mock";
import type { TTSProvider } from "./types";

const PROVIDERS: Record<string, TTSProvider> = {
  minimax: minimaxProvider,
  mock: mockProvider,
};

/** Pick the active TTS provider. Defaults to MiniMax in prod; falls back
 *  to mock when its key isn't configured (so local dev / CI can still
 *  exercise the streaming path without burning quota).
 *
 *  Only MINIMAX_API_KEY is required — MINIMAX_GROUP_ID is for the legacy
 *  GroupId-in-URL form and most accounts don't need it. The synthesize
 *  call already treats GROUP_ID as optional. */
export function getActiveProvider(): TTSProvider {
  const explicit = (process.env.TTS_PROVIDER || "").toLowerCase();
  if (explicit && PROVIDERS[explicit]) return PROVIDERS[explicit];
  if (process.env.MINIMAX_API_KEY) {
    return minimaxProvider;
  }
  return mockProvider;
}

export function getProviderByName(name: string): TTSProvider | null {
  return PROVIDERS[name.toLowerCase()] || null;
}

export type { TTSProvider, TTSRequest, TTSVoice } from "./types";
