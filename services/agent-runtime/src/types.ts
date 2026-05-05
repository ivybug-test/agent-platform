import type { Provider, DeepSeekMode } from "./llm.js";

export interface SummarizeBody {
  system: string;
  user: string;
  temperature?: number;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ChatBody {
  messages: any[];
  tools?: ToolDef[];
  toolCallbackUrl?: string;
  toolAuth?: string;
  maxToolRounds?: number;
  provider?: Provider;
  /** DeepSeek-only knob: flash (fast/cheap) or pro (reasoning).
   *  Ignored when provider="kimi" (vision model is fixed). */
  model?: DeepSeekMode;
  /** Optional override for first-round tool_choice. Web side picks
   *  this from the user's input via cheap regex (画一张 → force
   *  generate_image, 学猫叫 → force speak, etc) so the model can't
   *  hallucinate "I called the tool" without actually calling. Defaults
   *  to "auto" when absent. */
  toolChoice?: ToolChoice;
}

export interface AccumulatedToolCall {
  id: string;
  name: string;
  args: string;
}
