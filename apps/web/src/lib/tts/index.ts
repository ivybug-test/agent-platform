import { minimaxProvider } from "./minimax";
import { mockProvider } from "./mock";
import type { TTSProvider } from "./types";

const PROVIDERS: Record<string, TTSProvider> = {
  minimax: minimaxProvider,
  mock: mockProvider,
};

/** Pick the active TTS provider. Defaults to MiniMax in prod; falls back
 *  to mock when its key isn't configured (so local dev / CI can still
 *  exercise the streaming path without burning quota). */
export function getActiveProvider(): TTSProvider {
  const explicit = (process.env.TTS_PROVIDER || "").toLowerCase();
  if (explicit && PROVIDERS[explicit]) return PROVIDERS[explicit];
  if (process.env.MINIMAX_API_KEY && process.env.MINIMAX_GROUP_ID) {
    return minimaxProvider;
  }
  return mockProvider;
}

export function getProviderByName(name: string): TTSProvider | null {
  return PROVIDERS[name.toLowerCase()] || null;
}

export type { TTSProvider, TTSRequest, TTSVoice } from "./types";
