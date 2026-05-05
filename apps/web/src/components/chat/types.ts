import type { ReplyToSnippet } from "@/lib/redis";

export type { ReplyToSnippet };

/** Single search/fetch tool call, mirroring `ToolInvocation` from
 *  packages/db/schema.ts. Duplicated here so the client doesn't pull a
 *  server-side type into the bundle. */
export interface ToolHit {
  title: string;
  url: string;
  snippet?: string;
}

export interface ToolInvocation {
  name: string;
  query?: string;
  results?: ToolHit[];
  fetched?: { url: string; title?: string; charCount?: number };
  provider?: string;
  error?: string;
  /** Only set on the optimistic placeholder we push when the SSE stream
   *  delivers a tool_call but the matching tool_result hasn't arrived yet.
   *  Persisted invocations always have a final state. */
  pending?: boolean;
}

export interface Message {
  id?: string;
  senderType: "user" | "agent";
  senderId: string | null;
  senderName: string | null;
  content: string;
  contentType?: string;
  createdAt?: string;
  /** DeepSeek v4-pro chain-of-thought, surfaced in the collapsible
   *  thinking panel above the message bubble. Populated either from
   *  the SSE `{reasoning: ...}` events (live stream) or from
   *  metadata.reasoning on initial load. */
  reasoning?: string;
  /** Milliseconds spent in the reasoning phase. Drives the
   *  "已思考 Xs" label. */
  reasoningMs?: number;
  /** Reply / quote target. The full snippet (preview text + sender name)
   *  is denormalized onto each message so we can render the quote chip
   *  without a follow-up fetch. Click → scroll to source. */
  replyToMessageId?: string | null;
  replyTo?: ReplyToSnippet | null;
  /** Search / fetch tool calls made while producing this reply. Drives
   *  the "已搜索 N 个网页" card above the bubble. Live-stream entries
   *  start with `pending: true` and resolve as the matching tool_result
   *  arrives. */
  toolInvocations?: ToolInvocation[];
  /** Set when the agent called the speak tool — bubble gets a 🔊 play
   *  button. Live-streamed in via tool_result; persisted via
   *  metadata.audio so the button survives reload. */
  audio?: { text: string; voiceId?: string };
  /** Async generate_image placeholder state. Drives the "正在生成"
   *  bubble's prompt + phase + elapsed-time UI. Cleared (or ignored
   *  via contentType swap) once the BG task swaps the message to
   *  contentType="image" with a real URL in content. */
  imageGen?: { prompt?: string; phase?: string; startedAt?: string };
}

export interface MessageBubbleProps {
  msg: Message;
  /** Previous message's createdAt — used purely to decide whether to
   *  draw the day divider. Primitive so memo's shallow compare works. */
  prevCreatedAt: string | undefined;
  agentName: string;
  currentUserId: string | null;
  /** True when the row's action menu is the currently-open one. Pulled
   *  out as a primitive so non-open bubbles don't re-render when
   *  someone else opens theirs. */
  isMenuOpen: boolean;
  /** True when this bubble's audio is the one currently playing. */
  isPlaying: boolean;
  /** True only for the live-streaming "thinking" panel of the latest
   *  agent reply (drives the auto-expand + pulsing label). False for
   *  every other bubble, so they stay memoed. */
  isStreamingThinking: boolean;
  onContextMenu: (id: string) => void;
  onLongPressStart: (id: string) => void;
  onLongPressCancel: () => void;
  onJumpToMessage: (id: string) => void;
  onBeginQuote: (m: Message) => void;
  onCloseMenu: () => void;
  onToggleAudio: (id: string, text: string, voiceId?: string) => void;
}
