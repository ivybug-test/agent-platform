import OpenAI from "openai";

export type Provider = "deepseek" | "kimi";

// DeepSeek V4 series exposes a fast non-thinking variant (flash) and a
// reasoning variant (pro). Old aliases deepseek-chat / deepseek-reasoner
// are deprecated 2026-07-24 — we point at the v4 names by default.
export type DeepSeekMode = "flash" | "pro";

type SamplingKnobs = {
  temperature: number;
  frequency_penalty?: number;
  presence_penalty?: number;
};

interface ProviderSpec {
  /** OpenAI-compatible client builder. */
  buildClient(): OpenAI;
  /** Pick a model id given the optional DeepSeek mode toggle. */
  resolveModel(mode: DeepSeekMode): string;
  /** Sampling knobs sent into chat.completions.create. `withPenalties` is
   *  set on the open-ended chat stream (style polish for DeepSeek) and
   *  cleared on the tool-call path where deterministic argument JSON
   *  matters more than stylistic variety. */
  sampling(opts: { withPenalties: boolean }): SamplingKnobs;
}

const PROVIDERS: Record<Provider, ProviderSpec> = {
  deepseek: {
    buildClient: () =>
      new OpenAI({
        apiKey: process.env.LLM_API_KEY,
        baseURL: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
      }),
    resolveModel: (mode) =>
      mode === "pro"
        ? process.env.LLM_MODEL_PRO || "deepseek-v4-pro"
        : process.env.LLM_MODEL || "deepseek-v4-flash",
    sampling: ({ withPenalties }) =>
      withPenalties
        ? {
            temperature: 0.8,
            frequency_penalty: 0.6,
            presence_penalty: 0.5,
          }
        : { temperature: 0.8 },
  },
  // Kimi K2.6 locks temperature to 1 and rejects penalty knobs. Sampling
  // determinism comes from the prompt instead.
  kimi: {
    buildClient: () =>
      new OpenAI({
        apiKey: process.env.KIMI_API_KEY,
        baseURL: process.env.KIMI_BASE_URL || "https://api.moonshot.cn/v1",
      }),
    resolveModel: () => process.env.KIMI_VISION_MODEL || "kimi-k2.6",
    sampling: () => ({ temperature: 1 }),
  },
};

const _clients = new Map<Provider, OpenAI>();

export function getClient(provider: Provider = "deepseek"): OpenAI {
  let client = _clients.get(provider);
  if (!client) {
    client = PROVIDERS[provider].buildClient();
    _clients.set(provider, client);
  }
  return client;
}

export function getModel(
  provider: Provider = "deepseek",
  mode: DeepSeekMode = "flash"
): string {
  return PROVIDERS[provider].resolveModel(mode);
}

export interface ChatRequestConfig {
  client: OpenAI;
  model: string;
  /** Sampling fields to spread into chat.completions.create */
  sampling: SamplingKnobs;
}

/** One-stop shop for picking the client + model + sampling knobs for a
 *  single chat completion. Keeps the request handler in index.ts free of
 *  provider-specific branching. */
export function chatConfig(
  provider: Provider,
  mode: DeepSeekMode = "flash",
  opts: { withPenalties?: boolean } = {}
): ChatRequestConfig {
  const spec = PROVIDERS[provider];
  return {
    client: getClient(provider),
    model: spec.resolveModel(mode),
    sampling: spec.sampling({ withPenalties: opts.withPenalties ?? false }),
  };
}
