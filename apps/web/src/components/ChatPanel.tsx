"use client";

import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { useSession } from "next-auth/react";
import { io, Socket } from "socket.io-client";
import { sendImageMessage } from "@/lib/upload-image";
import LinkPreviewCard from "./LinkPreviewCard";
import MarkdownContent from "./MarkdownContent";
import {
  play as playTts,
  stopAll as stopAllTts,
} from "@/lib/audio/streaming-player";

/** Pull every http(s) URL out of a message body. Trailing CJK and ASCII
 *  punctuation gets stripped so "看看 https://example.com。" doesn't try
 *  to fetch "https://example.com。" as one URL. Returns up to 3 unique
 *  URLs per message — beyond that the cards take over the bubble. */
/** Collapsible chain-of-thought panel — DeepSeek v4-pro returns
 *  reasoning_content as a separate stream channel; we surface it above
 *  the actual answer in a muted, italic, expandable block. Default-
 *  expanded while the message is still streaming reasoning, default-
 *  collapsed once the final answer is in. */
function ThinkingPanel({
  reasoning,
  reasoningMs,
  streaming,
}: {
  reasoning: string;
  reasoningMs?: number;
  streaming: boolean;
}) {
  const seconds =
    reasoningMs && reasoningMs > 0 ? Math.max(1, Math.round(reasoningMs / 1000)) : 0;
  const label = streaming
    ? "思考中…"
    : seconds > 0
      ? `已思考 ${seconds} 秒`
      : "已思考";
  return (
    <details
      className="text-xs opacity-70 mb-1 select-none cursor-pointer"
      open={streaming || undefined}
    >
      <summary className="flex items-center gap-1 list-none [&::-webkit-details-marker]:hidden">
        <span>🧠</span>
        <span className={streaming ? "animate-pulse" : ""}>{label}</span>
        <span className="opacity-60">▾</span>
      </summary>
      <div className="mt-1 pl-3 border-l-2 border-base-content/20 italic whitespace-pre-wrap opacity-80">
        {reasoning}
      </div>
    </details>
  );
}

/** Single search/fetch tool call, mirroring `ToolInvocation` from
 *  packages/db/schema.ts. Duplicated here so the client doesn't pull a
 *  server-side type into the bundle. */
interface ToolHit {
  title: string;
  url: string;
  snippet?: string;
}
interface ToolInvocation {
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

const TOOL_LABEL: Record<string, string> = {
  web_search: "搜索网页",
  search_lyrics: "搜索歌词",
  search_music: "搜索音乐",
  fetch_url: "读取网页",
};

const VISIBLE_TOOLS = new Set([
  "web_search",
  "search_lyrics",
  "search_music",
  "fetch_url",
]);

/** Pull the user-facing label out of a (possibly partial) JSON args
 *  string. Tolerates malformed JSON — the SSE stream may deliver args in
 *  chunks, and we'd rather show the card with no query than crash. */
function queryFromArgs(name: string, argsJson: string): string | undefined {
  if (!argsJson) return undefined;
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>;
    if (name === "search_lyrics") {
      const song = typeof obj.song === "string" ? obj.song : "";
      const artist = typeof obj.artist === "string" ? obj.artist : "";
      return artist ? `${song} ${artist}` : song || undefined;
    }
    if (name === "fetch_url") {
      return typeof obj.url === "string" ? obj.url : undefined;
    }
    return typeof obj.query === "string" ? obj.query : undefined;
  } catch {
    return undefined;
  }
}

/** Convert a raw tool_result payload (whatever the tool callback
 *  returned) into the trimmed shape we render. Mirrors the server-side
 *  buildInvocation in lib/chat/stream.ts. */
function resolveToolInvocation(
  name: string,
  query: string | undefined,
  payload: any,
  ok: boolean
): ToolInvocation {
  const inv: ToolInvocation = { name };
  if (query) inv.query = query;
  if (!ok || !payload) {
    inv.error = payload?.error || "tool call failed";
    return inv;
  }
  if (name === "fetch_url") {
    if (payload.data?.url) {
      inv.fetched = {
        url: payload.data.url,
        title: payload.data.title,
        charCount: payload.data.charCount,
      };
    }
    if (payload.data?.provider) inv.provider = payload.data.provider;
    if (payload.error) inv.error = payload.error;
    return inv;
  }
  if (Array.isArray(payload.data?.results)) {
    inv.results = payload.data.results.map((r: any) => ({
      title: r.title || r.url,
      url: r.url,
      snippet: r.snippet,
    }));
  }
  if (payload.data?.provider) inv.provider = payload.data.provider;
  if (payload.error) inv.error = payload.error;
  return inv;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Compact "已搜索 N 个网页" card rendered above the agent bubble. Open it
 *  to see each result (title, host, snippet) as a clickable row. */
function ToolInvocationsCard({ invocations }: { invocations: ToolInvocation[] }) {
  if (!invocations || invocations.length === 0) return null;
  // Group invocations by tool name so the header reads "搜索网页 (3)".
  // Most replies only call one tool, so this stays compact.
  return (
    <div className="mb-1 space-y-1">
      {invocations.map((inv, idx) => {
        const label = TOOL_LABEL[inv.name] || inv.name;
        const hits = inv.results || [];
        const isFetch = inv.name === "fetch_url";
        const summary = inv.pending
          ? `${label}中…${inv.query ? ` "${inv.query}"` : ""}`
          : inv.error
            ? `${label}失败${inv.query ? ` "${inv.query}"` : ""}`
            : isFetch
              ? `已读取 ${inv.fetched?.title || safeHost(inv.fetched?.url || "")}`
              : `已${label} ${hits.length} 个结果${inv.query ? ` "${inv.query}"` : ""}`;
        return (
          <details
            key={idx}
            className="text-xs opacity-80 select-none cursor-pointer rounded border border-base-content/15 bg-base-100/40 px-2 py-1"
          >
            <summary className="flex items-center gap-1 list-none [&::-webkit-details-marker]:hidden">
              <span>{isFetch ? "📄" : "🔎"}</span>
              <span className={inv.pending ? "animate-pulse" : ""}>{summary}</span>
              {!inv.pending && (hits.length > 0 || isFetch || inv.error) && (
                <span className="opacity-60">▾</span>
              )}
            </summary>
            {!inv.pending && hits.length > 0 && (
              <ol className="mt-1 space-y-1 pl-1">
                {hits.map((h, i) => (
                  <li key={i} className="leading-snug">
                    <a
                      href={h.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="link link-hover font-medium break-all"
                    >
                      {h.title || h.url}
                    </a>
                    <span className="ml-1 opacity-50">{safeHost(h.url)}</span>
                    {h.snippet && (
                      <div className="opacity-70 line-clamp-2">{h.snippet}</div>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {!inv.pending && isFetch && inv.fetched?.url && (
              <div className="mt-1 pl-1 leading-snug">
                <a
                  href={inv.fetched.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link link-hover break-all"
                >
                  {inv.fetched.title || inv.fetched.url}
                </a>
                <span className="ml-1 opacity-50">{safeHost(inv.fetched.url)}</span>
              </div>
            )}
            {inv.error && (
              <div className="mt-1 pl-1 text-error/80 break-all">
                错误：{inv.error}
              </div>
            )}
          </details>
        );
      })}
    </div>
  );
}

function extractUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"]+/g) || [];
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    let u = raw;
    // Strip common trailing punctuation that clearly isn't part of the URL.
    while (u.length > 0 && /[)\]\.,，。、;:!?！？]$/.test(u)) {
      u = u.slice(0, -1);
    }
    if (!u || seen.has(u)) continue;
    seen.add(u);
    cleaned.push(u);
    if (cleaned.length >= 3) break;
  }
  return cleaned;
}

/** Generate a uuid v4. Prefers crypto.randomUUID (cryptographically
 *  random, ~zero collision risk) but falls back to a Math.random-built
 *  v4 when the page runs in an INSECURE CONTEXT — `crypto.randomUUID`
 *  is gated on HTTPS-or-localhost, so accessing the dev server via an
 *  http:// LAN IP / proxy hostname makes the call throw. The fallback
 *  is fine because message ids are persisted but never used as auth /
 *  capability tokens; a chance collision on Math.random is laughably
 *  smaller than the risk of breaking the send button. */
function makeMessageId(): string {
  const c = typeof crypto !== "undefined" ? crypto : null;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // Some browsers (older Edge / odd embeds) throw despite presenting
      // the function. Drop through to the Math.random path.
    }
  }
  const bytes = new Array(16).fill(0).map(() => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface ReplyToSnippet {
  id: string;
  senderName: string | null;
  content: string;
  contentType?: string;
}

/** Compact label shown inside both the quote chip (above input) and the
 *  inline quote block (above the reply bubble). Truncates and prefixes
 *  the original sender's name. Image quotes show "[图片]" instead of a
 *  URL so the chip stays readable. */
function quotePreview(snippet: ReplyToSnippet, max = 60): string {
  const body =
    snippet.contentType === "image" ? "[图片]" : snippet.content || "";
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + "…";
}

/** Inline quote block rendered above each reply bubble. Click → scroll to
 *  source if it's still in the loaded window; otherwise just highlights. */
function QuoteBlock({
  reply,
  onJump,
}: {
  reply: ReplyToSnippet;
  onJump: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onJump(reply.id)}
      className="block w-full text-left mb-1 pl-2 pr-2 py-1 rounded border-l-2 border-base-content/30 bg-base-content/5 hover:bg-base-content/10 transition-colors"
    >
      <div className="text-[10px] opacity-60">
        回复 {reply.senderName || "用户"}
      </div>
      <div className="text-xs opacity-80 line-clamp-2">
        {quotePreview(reply, 100)}
      </div>
    </button>
  );
}

interface Message {
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
}

interface ChatPanelProps {
  roomId: string;
  onChatComplete?: () => void;
}

// -----------------------------------------------------------------------------
// MessageBubble: extracted out of messages.map and React.memo'd so a
// keystroke in the input doesn't force 1000+ markdown re-parses. Memo
// only kicks in when the parent passes stable refs / primitives — see
// the useCallback wrapping in ChatPanel below.
// -----------------------------------------------------------------------------

interface MessageBubbleProps {
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

function MessageBubbleInner({
  msg,
  prevCreatedAt,
  agentName,
  currentUserId,
  isMenuOpen,
  isPlaying,
  isStreamingThinking,
  onContextMenu,
  onLongPressStart,
  onLongPressCancel,
  onJumpToMessage,
  onBeginQuote,
  onCloseMenu,
  onToggleAudio,
}: MessageBubbleProps) {
  const isMe = msg.senderType === "user" && msg.senderId === currentUserId;
  const isAgent = msg.senderType === "agent";
  const displayName = isMe
    ? "我"
    : msg.senderName || (isAgent ? agentName : "用户");
  const bubbleColor = isAgent
    ? "chat-bubble-neutral"
    : isMe
      ? "chat-bubble-primary"
      : colorForUser(msg.senderId || "unknown");
  const showDayDivider =
    msg.createdAt && (!prevCreatedAt || dayKey(prevCreatedAt) !== dayKey(msg.createdAt));
  const timeLabel = fmtTime(msg.createdAt);
  // Cache the URL-extraction regex pass — it runs once per content
  // string change, not on every parent re-render.
  const urls = useMemo(() => extractUrls(msg.content), [msg.content]);

  return (
    <div id={msg.id ? `msg-${msg.id}` : undefined} className="rounded transition-shadow">
      {showDayDivider && (
        <div className="flex justify-center my-3">
          <span className="text-[10px] px-2 py-0.5 rounded bg-base-300/60 text-base-content/50">
            {dayDividerLabel(msg.createdAt)}
          </span>
        </div>
      )}
      <div className={`chat ${isMe ? "chat-end" : "chat-start"} relative`}>
        <div className="chat-header text-xs opacity-60 mb-0.5">
          {displayName}
          {timeLabel && (
            <time className="ml-1.5 opacity-60 text-[10px]">{timeLabel}</time>
          )}
        </div>
        <div
          className={`chat-bubble ${bubbleColor} text-sm select-none [-webkit-touch-callout:none] [-webkit-user-select:none]`}
          onContextMenu={(e) => {
            if (!msg.id) return;
            e.preventDefault();
            onContextMenu(msg.id);
          }}
          onTouchStart={() => msg.id && onLongPressStart(msg.id)}
          onTouchEnd={onLongPressCancel}
          onTouchMove={onLongPressCancel}
          onTouchCancel={onLongPressCancel}
        >
          {msg.replyTo && <QuoteBlock reply={msg.replyTo} onJump={onJumpToMessage} />}
          {isImageMessage(msg) ? (
            <a href={msg.content} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={msg.content}
                alt="sent image"
                className="max-w-[240px] max-h-[320px] rounded object-contain"
                loading="lazy"
              />
            </a>
          ) : (
            <>
              {isAgent && msg.toolInvocations && msg.toolInvocations.length > 0 && (
                <ToolInvocationsCard invocations={msg.toolInvocations} />
              )}
              {msg.reasoning && (
                <ThinkingPanel
                  reasoning={msg.reasoning}
                  reasoningMs={msg.reasoningMs}
                  streaming={isStreamingThinking}
                />
              )}
              {/* Agent replies are markdown; user messages are plain text
                  with whitespace preserved so a leading "-" doesn't get
                  list-bulleted. */}
              {isAgent ? (
                <MarkdownContent>{msg.content}</MarkdownContent>
              ) : (
                <div className="whitespace-pre-wrap">{msg.content}</div>
              )}
              {isAgent && msg.audio && msg.id && (
                <button
                  type="button"
                  onClick={() =>
                    onToggleAudio(msg.id!, msg.audio!.text, msg.audio!.voiceId)
                  }
                  className="mt-1.5 flex items-center gap-1.5 px-2.5 h-7 rounded-full text-xs bg-base-100/60 border border-base-content/20 hover:bg-base-content/5 transition-colors select-none"
                  title={isPlaying ? "停止" : "播放语音"}
                >
                  <span aria-hidden>{isPlaying ? "⏹" : "🔊"}</span>
                  <span>{isPlaying ? "播放中…" : "语音"}</span>
                </button>
              )}
              {urls.map((u) => (
                <LinkPreviewCard key={u} url={u} />
              ))}
            </>
          )}
        </div>
        {isMenuOpen && msg.id && (
          // Floats above the bubble (iMessage-style reaction bar) so it
          // doesn't get hidden by anything below.
          <div
            className={`absolute z-20 ${isMe ? "right-1" : "left-1"} -top-9 flex bg-base-100 border border-base-300 rounded-full shadow-lg text-xs overflow-hidden divide-x divide-base-300`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="px-3 py-1.5 hover:bg-base-200 active:bg-base-300"
              onClick={() => onBeginQuote(msg)}
            >
              引用
            </button>
            {!isImageMessage(msg) && (
              <button
                type="button"
                className="px-3 py-1.5 hover:bg-base-200 active:bg-base-300"
                onClick={() => {
                  navigator.clipboard?.writeText(msg.content).catch(() => {});
                  onCloseMenu();
                }}
              >
                复制
              </button>
            )}
            {isImageMessage(msg) && (
              <button
                type="button"
                className="px-3 py-1.5 hover:bg-base-200 active:bg-base-300"
                onClick={() => {
                  window.open(msg.content, "_blank", "noopener");
                  onCloseMenu();
                }}
              >
                新标签打开
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const MessageBubble = memo(MessageBubbleInner);

const bubbleColors = [
  "chat-bubble-primary",
  "chat-bubble-secondary",
  "chat-bubble-accent",
  "chat-bubble-warning",
  "chat-bubble-error",
  "chat-bubble-info",
];
function isImageMessage(msg: { content: string; contentType?: string }): boolean {
  if (msg.contentType === "image") return true;
  // Fallback: detect COS image URLs even if contentType is missing
  return /^https:\/\/[^\s]+\.myqcloud\.com\/[^\s]+\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(
    msg.content
  );
}

function colorForUser(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return bubbleColors[Math.abs(hash) % bubbleColors.length];
}

/** Asia/Shanghai-localised parts of a timestamp, used for both the per-message
 *  HH:mm label and the cross-day divider text. */
const SH_FMT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hour12: false,
});

function fmtTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const parts = SH_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("hour")}:${get("minute")}`;
}

function dayKey(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const parts = SH_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayDividerLabel(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const parts = SH_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";

  // "Today" / "Yesterday" shortcuts if applicable.
  const now = new Date();
  const today = dayKey(now.toISOString());
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const key = `${get("year")}-${get("month")}-${get("day")}`;
  if (key === today) return "今天";
  if (key === dayKey(yesterday.toISOString())) return "昨天";

  // Same year → "MM月DD日 周X"; otherwise "YYYY年MM月DD日 周X"
  const curYear = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).format(now);
  const inCurYear = get("year") === curYear;
  const base = `${get("month")}月${get("day")}日 ${get("weekday")}`;
  return inCurYear ? base : `${get("year")}年${base}`;
}

export default function ChatPanel({ roomId, onChatComplete }: ChatPanelProps) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // Reply / quote state — set by long-press / right-click on a message,
  // shown as a chip above the input, sent with the next message and then
  // cleared. `null` means no quote is staged.
  const [replyTarget, setReplyTarget] = useState<ReplyToSnippet | null>(null);
  // Which message's action menu is currently open. Keyed by message id;
  // `null` closes any open menu.
  const [menuForId, setMenuForId] = useState<string | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Real agent name from the room (e.g. "agent", "Maya"). Loaded with
  // the message history so optimistic placeholders match what the rest of
  // the chat shows after the SSE stream resolves.
  const [agentName, setAgentName] = useState("agent");

  // Per-room DeepSeek model toggle: flash (fast/cheap default) or pro
  // (thinking/reasoning). Persisted in localStorage so a user's choice
  // survives reload but stays scoped to that room.
  const [model, setModel] = useState<"flash" | "pro">("flash");
  useEffect(() => {
    if (!roomId) return;
    try {
      const saved = localStorage.getItem(`chat-model-${roomId}`);
      if (saved === "pro" || saved === "flash") {
        setModel(saved);
      } else {
        setModel("flash");
      }
    } catch {
      setModel("flash");
    }
  }, [roomId]);
  const toggleModel = () => {
    setModel((prev) => {
      const next = prev === "flash" ? "pro" : "flash";
      try {
        localStorage.setItem(`chat-model-${roomId}`, next);
      } catch {}
      return next;
    });
  };

  // Click-to-play TTS. The user no longer toggles a "voice mode" — the
  // agent's `speak` tool decides whether a reply has audio, and the
  // bubble gets a 🔊 button you can tap. Only one bubble plays at a
  // time; clicking another (or the playing one) calls stopAll first.
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  // Last TTS error — surfaced as a toast above the input dock for ~4s.
  const [ttsError, setTtsError] = useState<string | null>(null);
  useEffect(() => {
    if (!ttsError) return;
    const t = setTimeout(() => setTtsError(null), 4000);
    return () => clearTimeout(t);
  }, [ttsError]);
  // Tracks which agent we're chatting with (for /api/tts agentId param).
  // Populated from the first agent message we see; chat already enforces
  // single-agent-per-room so this is stable.
  const agentIdRef = useRef<string | null>(null);

  /** Play (or stop, if it's the one playing) the audio attached to an
   *  agent message. Replies without `metadata.audio` don't get a button
   *  in the first place, so callers can assume `text` is set. */
  const toggleAudioPlayback = useCallback((
    messageId: string,
    text: string,
    voiceId?: string
  ) => {
    if (playingMessageId === messageId) {
      stopAllTts();
      setPlayingMessageId(null);
      return;
    }
    stopAllTts();
    setPlayingMessageId(messageId);
    setTtsError(null);
    playTts({
      body: {
        text,
        agentId: agentIdRef.current,
        ...(voiceId ? { voiceId } : {}),
      },
      onEnd: () => {
        setPlayingMessageId((cur) => (cur === messageId ? null : cur));
      },
      onError: (err) => {
        setPlayingMessageId((cur) => (cur === messageId ? null : cur));
        const raw = err?.message || String(err);
        if (/abort/i.test(raw)) return;
        let shown = "TTS 失败";
        if (/2061|plan/i.test(raw)) {
          shown = "TTS 套餐未开通或当日配额已满";
        } else if (/2049|api key|invalid.*key/i.test(raw)) {
          shown = "TTS 鉴权失败";
        } else if (/429|rate/i.test(raw)) {
          shown = "TTS 频率被限，稍后再试";
        } else if (/502|503|504|timeout/i.test(raw)) {
          shown = "TTS 服务暂时无响应";
        } else {
          shown = "TTS 失败：" + raw.replace(/^.*?:\s*/, "").slice(0, 60);
        }
        setTtsError(shown);
      },
    });
  }, []);

  // Switching room kills any audio in flight. Same on unmount.
  useEffect(() => {
    if (!roomId) return;
    stopAllTts();
    setPlayingMessageId(null);
  }, [roomId]);
  useEffect(() => {
    return () => {
      stopAllTts();
    };
  }, []);
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const isInitialLoad = useRef(true);
  // Per-stream timer for the reasoning panel. Reset to 0 each time a new
  // agent message starts; first {reasoning} event stamps it, first
  // {content} event closes it out into reasoningMs on the message.
  const reasoningStartRef = useRef(0);
  // Live mapping of tool_call.id → tool name, so we can resolve the
  // matching tool_result event back to its placeholder invocation. Cleared
  // each time a new agent message starts.
  const pendingToolCallIds = useRef<Map<string, string>>(new Map());
  // Same keys as pendingToolCallIds but value is the raw args JSON
  // string. Needed for tools whose args matter at resolution time
  // (e.g. `speak` reads its `text`); tracked for ALL tool_calls so we
  // don't have to special-case visibility filters here.
  const pendingToolArgs = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    setMessages([]);
    setHasMore(false);
    seenIds.current.clear();
    isInitialLoad.current = true;
    (async () => {
      const res = await fetch(`/api/messages?roomId=${roomId}`);
      if (!res.ok) return;
      const data = await res.json();
      const loaded = data.messages
        .filter((r: any) => r.senderType !== "system")
        .map((r: any) => ({
          id: r.id,
          senderType: r.senderType,
          senderId: r.senderId,
          senderName: r.senderName,
          content: r.content,
          contentType: r.contentType,
          createdAt: r.createdAt,
          reasoning: r.metadata?.reasoning,
          reasoningMs: r.metadata?.reasoningMs,
          toolInvocations: r.metadata?.toolInvocations,
          audio: r.metadata?.audio,
          replyToMessageId: r.replyToMessageId ?? null,
          replyTo: r.replyTo ?? null,
        }));
      for (const m of loaded) {
        if (m.id) seenIds.current.add(m.id);
        if (m.senderType === "agent" && m.senderId && !agentIdRef.current) {
          agentIdRef.current = m.senderId;
        }
      }
      if (data.roomAgent?.name) {
        setAgentName(data.roomAgent.name);
        if (data.roomAgent.id) agentIdRef.current = data.roomAgent.id;
      }
      setMessages(loaded);
      setHasMore(data.hasMore ?? false);
    })();
  }, [roomId]);

  // WebSocket: listen for real-time messages from other users
  const socketRef = useRef<Socket | null>(null);
  const seenIds = useRef(new Set<string>());

  // Refetch messages from API and merge (used on reconnect to fill gaps)
  const refetchMessages = useCallback(async () => {
    const res = await fetch(`/api/messages?roomId=${roomId}`);
    if (!res.ok) return;
    const data = await res.json();
    const fetched: Message[] = data.messages
      .filter((r: any) => r.senderType !== "system")
      .map((r: any) => ({
        id: r.id,
        senderType: r.senderType,
        senderId: r.senderId,
        senderName: r.senderName,
        content: r.content,
        contentType: r.contentType,
        createdAt: r.createdAt,
        reasoning: r.metadata?.reasoning,
        reasoningMs: r.metadata?.reasoningMs,
        toolInvocations: r.metadata?.toolInvocations,
        audio: r.metadata?.audio,
      }));
    for (const m of fetched) {
      if (m.id) seenIds.current.add(m.id);
    }
    setMessages(fetched);
    setHasMore(data.hasMore ?? false);
  }, [roomId]);

  // Load older messages when scrolling to top
  const loadOlderMessages = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    const oldest = messages.find((m) => m.createdAt);
    if (!oldest?.createdAt) return;

    setIsLoadingMore(true);
    const container = scrollContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;

    try {
      const res = await fetch(
        `/api/messages?roomId=${roomId}&before=${encodeURIComponent(oldest.createdAt)}`
      );
      if (!res.ok) return;
      const data = await res.json();
      const older: Message[] = data.messages
        .filter((r: any) => r.senderType !== "system")
        .map((r: any) => ({
          id: r.id,
          senderType: r.senderType,
          senderId: r.senderId,
          senderName: r.senderName,
          content: r.content,
          contentType: r.contentType,
          createdAt: r.createdAt,
          reasoning: r.metadata?.reasoning,
          reasoningMs: r.metadata?.reasoningMs,
          toolInvocations: r.metadata?.toolInvocations,
          audio: r.metadata?.audio,
          replyToMessageId: r.replyToMessageId ?? null,
          replyTo: r.replyTo ?? null,
        }));
      for (const m of older) {
        if (m.id) seenIds.current.add(m.id);
      }
      if (older.length > 0) {
        setMessages((prev) => [...older, ...prev]);
        // Restore scroll position after prepending
        requestAnimationFrame(() => {
          if (container) {
            container.scrollTop = container.scrollHeight - prevScrollHeight;
          }
        });
      }
      setHasMore(data.hasMore ?? false);
    } finally {
      setIsLoadingMore(false);
    }
  }, [roomId, hasMore, isLoadingMore, messages]);

  useEffect(() => {
    const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
    if (!gatewayUrl || !currentUserId) return;

    const socket = io(gatewayUrl, {
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    let isFirstConnect = true;

    socket.on("connect", () => {
      socket.emit("join-room", roomId);
      // On reconnect (not first connect), refetch messages to fill the gap
      if (!isFirstConnect) {
        refetchMessages();
      }
      isFirstConnect = false;
    });

    socket.on("typing", (data: { userName: string }) => {
      if (!data?.userName) return;
      const name = data.userName;
      setTypingUsers((prev) => new Set(prev).add(name));
      // Clear previous timer for this user
      const existing = typingTimers.current.get(name);
      if (existing) clearTimeout(existing);
      // Auto-remove after 3s
      typingTimers.current.set(name, setTimeout(() => {
        setTypingUsers((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
        typingTimers.current.delete(name);
      }, 3000));
    });

    socket.on("room-message", (event: any) => {
      const msg = event.message;
      if (!msg) return;
      // Skip empty messages
      if (!msg.content) return;
      // Skip our own user messages (already shown locally)
      if (msg.senderType === "user" && msg.senderId === currentUserId) return;
      // Skip agent messages triggered by us (already rendered via SSE)
      if (msg.senderType === "agent" && event.triggeredBy === currentUserId) return;
      // Skip duplicates
      if (msg.id && seenIds.current.has(msg.id)) return;
      if (msg.id) seenIds.current.add(msg.id);

      // Clear typing indicator for this sender
      if (msg.senderName) {
        setTypingUsers((prev) => {
          if (!prev.has(msg.senderName)) return prev;
          const next = new Set(prev);
          next.delete(msg.senderName);
          return next;
        });
      }

      setMessages((prev) => [
        ...prev,
        {
          id: msg.id,
          senderType: msg.senderType,
          senderId: msg.senderId,
          senderName: msg.senderName,
          content: msg.content,
          contentType: msg.contentType,
          replyToMessageId: msg.replyToMessageId ?? null,
          replyTo: msg.replyTo ?? null,
        },
      ]);
    });

    return () => {
      socket.emit("leave-room", roomId);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, currentUserId, refetchMessages]);

  // Emit typing event (debounced: at most once per 2s)
  const lastTypingEmit = useRef(0);
  const emitTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingEmit.current < 2000) return;
    lastTypingEmit.current = now;
    const socket = socketRef.current;
    if (socket) {
      socket.emit("typing", { roomId, userName: session?.user?.name || "User" });
    }
  }, [roomId, session?.user?.name]);

  // Detect scroll near top to load older messages
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      if (container.scrollTop < 80 && hasMore && !isLoadingMore) {
        loadOlderMessages();
      }
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [hasMore, isLoadingMore, loadOlderMessages]);

  // Auto-scroll to bottom only when near bottom (not when loading older messages)
  const shouldAutoScroll = useRef(true);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleUserScroll = () => {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      shouldAutoScroll.current = distFromBottom < 150;
    };
    container.addEventListener("scroll", handleUserScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleUserScroll);
  }, []);

  useEffect(() => {
    if (isInitialLoad.current && messages.length > 0) {
      // First load or room switch: jump to bottom instantly
      isInitialLoad.current = false;
      shouldAutoScroll.current = true;
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView();
      });
      return;
    }
    if (shouldAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, typingUsers]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    // User typed → cut any audio currently playing. They're moving on
    // and the previous bubble is no longer the focus.
    stopAllTts();
    setPlayingMessageId(null);

    // Snapshot the staged quote so user can clear/replace it while we're
    // mid-flight without leaving the optimistic message holding a stale
    // reference.
    const stagedReply = replyTarget;

    // Mint UUIDs for the user message AND the agent placeholder upfront,
    // and tell the server to use them. Without this the optimistic
    // bubbles have no id until refresh — which means long-press / quote
    // / scroll-to-jump are all broken on freshly-sent messages. seenIds
    // tracks them too so the Redis echo doesn't double-render.
    const userMessageId = makeMessageId();
    const agentMessageId = makeMessageId();
    seenIds.current.add(userMessageId);
    seenIds.current.add(agentMessageId);

    const userMsg: Message = {
      id: userMessageId,
      senderType: "user",
      senderId: currentUserId || null,
      senderName: session?.user?.name || "You",
      content: text,
      createdAt: new Date().toISOString(),
      replyToMessageId: stagedReply?.id ?? null,
      replyTo: stagedReply,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setReplyTarget(null);
    setIsStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          content: text,
          model,
          replyToMessageId: stagedReply?.id ?? null,
          userMessageId,
          agentMessageId,
        }),
      });

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) return;
      if (!res.ok || !res.body) throw new Error("Request failed");

      reasoningStartRef.current = 0;
      pendingToolCallIds.current.clear();
      pendingToolArgs.current.clear();
      setMessages((prev) => [
        ...prev,
        {
          id: agentMessageId,
          senderType: "agent",
          senderId: null,
          senderName: agentName,
          content: "",
          createdAt: new Date().toISOString(),
        },
      ]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            // Server sends {done: true, messageId} at end of stream for dedup
            if (parsed.done && parsed.messageId) {
              seenIds.current.add(parsed.messageId);
              continue;
            }
            if (parsed.reasoning) {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                const wasEmpty = !last.reasoning;
                updated[updated.length - 1] = {
                  ...last,
                  reasoning: (last.reasoning || "") + parsed.reasoning,
                  // First reasoning chunk → start the timer. Each
                  // subsequent chunk while content hasn't started yet
                  // bumps reasoningMs forward; the moment content begins
                  // we stop updating it.
                  reasoningMs:
                    wasEmpty || !last.reasoningMs
                      ? 0
                      : last.reasoningMs,
                };
                return updated;
              });
              // Track when reasoning began on this message so we can
              // close out reasoningMs when content starts arriving.
              if (!reasoningStartRef.current) {
                reasoningStartRef.current = Date.now();
              }
            }
            if (parsed.content) {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                const reasoningMs =
                  last.reasoning && reasoningStartRef.current && !last.reasoningMs
                    ? Date.now() - reasoningStartRef.current
                    : last.reasoningMs;
                updated[updated.length - 1] = {
                  ...last,
                  content: last.content + parsed.content,
                  reasoningMs,
                };
                return updated;
              });
            }
            // Tool calls — push an optimistic pending row when the call
            // starts; resolve it in place when the matching tool_result
            // event arrives. We only render search/fetch tools (memory
            // tools stay invisible — same allowlist as stream.ts).
            if (parsed.tool_call) {
              const tc = parsed.tool_call as {
                id: string;
                name: string;
                args: string;
              };
              // Track name + args for ALL tool_calls — `speak` needs
              // them at tool_result time even though it doesn't show
              // up in the visible-tools card.
              pendingToolCallIds.current.set(tc.id, tc.name);
              pendingToolArgs.current.set(tc.id, tc.args);
              if (VISIBLE_TOOLS.has(tc.name)) {
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  const next = [...(last.toolInvocations || [])];
                  next.push({
                    name: tc.name,
                    query: queryFromArgs(tc.name, tc.args),
                    pending: true,
                  });
                  updated[updated.length - 1] = {
                    ...last,
                    toolInvocations: next,
                  };
                  return updated;
                });
              }
            }
            if (parsed.tool_result) {
              const tr = parsed.tool_result as {
                id: string;
                name?: string;
                ok: boolean;
                data?: any;
              };
              const knownName =
                pendingToolCallIds.current.get(tr.id) || tr.name || "";
              const knownArgs = pendingToolArgs.current.get(tr.id) || "";
              pendingToolCallIds.current.delete(tr.id);
              pendingToolArgs.current.delete(tr.id);
              // `speak` resolution: live-attach the audio metadata to
              // the in-flight agent message so the 🔊 button shows up
              // right when the tool fires, not only after reload.
              // stream.ts persists the same blob server-side.
              if (knownName === "speak" && tr.ok && knownArgs) {
                try {
                  const args = JSON.parse(knownArgs);
                  if (typeof args?.text === "string" && args.text.trim()) {
                    setMessages((prev) => {
                      const updated = [...prev];
                      const last = updated[updated.length - 1];
                      updated[updated.length - 1] = {
                        ...last,
                        audio: {
                          text: args.text.trim(),
                          ...(typeof args?.voiceId === "string"
                            ? { voiceId: args.voiceId }
                            : {}),
                        },
                      };
                      return updated;
                    });
                  }
                } catch {}
              }
              if (knownName && VISIBLE_TOOLS.has(knownName)) {
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  const list = [...(last.toolInvocations || [])];
                  // Find the matching pending row (latest one for this
                  // tool name) and replace it with the resolved data.
                  let idx = -1;
                  for (let i = list.length - 1; i >= 0; i--) {
                    if (list[i].name === knownName && list[i].pending) {
                      idx = i;
                      break;
                    }
                  }
                  const resolved = resolveToolInvocation(
                    knownName,
                    list[idx]?.query,
                    tr.data,
                    tr.ok
                  );
                  if (idx >= 0) {
                    list[idx] = resolved;
                  } else {
                    list.push(resolved);
                  }
                  updated[updated.length - 1] = {
                    ...last,
                    toolInvocations: list,
                  };
                  return updated;
                });
              }
            }
          } catch {}
        }
      }
    } catch {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          senderType: "agent",
          senderId: null,
          senderName: agentName,
          content: "错误:未能获取回复。",
        };
        return updated;
      });
    } finally {
      setIsStreaming(false);
      onChatComplete?.();
    }
  };

  const handleImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || isUploading) return;
    if (!file.type.startsWith("image/")) {
      alert("请选择图片文件");
      return;
    }
    setIsUploading(true);
    const stagedReply = replyTarget;
    // Mint the id up-front so the optimistic image bubble has it from
    // first paint — keeps long-press / quote / scroll-to-jump working
    // without waiting for the server round-trip.
    const messageId = makeMessageId();
    seenIds.current.add(messageId);
    try {
      const msg = await sendImageMessage(file, roomId, stagedReply?.id ?? null, messageId);
      setReplyTarget(null);
      setMessages((prev) => [
        ...prev,
        {
          id: msg.id,
          senderType: "user",
          senderId: msg.senderId,
          senderName: msg.senderName,
          content: msg.content,
          contentType: msg.contentType,
          createdAt: msg.createdAt,
          replyToMessageId: msg.replyToMessageId ?? null,
          replyTo: msg.replyTo ?? null,
        },
      ]);
    } catch (err: any) {
      alert(`图片发送失败:${err?.message || "未知错误"}`);
    } finally {
      setIsUploading(false);
    }
  };

  // All handlers below pass through to memoed MessageBubble — they MUST
  // be stable references (useCallback with [] deps where possible),
  // otherwise every re-render of ChatPanel would invalidate every
  // bubble's memo and we're back to 1000 markdown re-parses per
  // keystroke. Setters from useState and refs are guaranteed stable.
  const startLongPress = useCallback((id: string) => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => setMenuForId(id), 450);
  }, []);
  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);
  const openMenuViaContextMenu = useCallback((id: string) => {
    setMenuForId(id);
  }, []);
  const closeMenu = useCallback(() => {
    setMenuForId(null);
  }, []);

  const beginQuote = useCallback((m: Message) => {
    if (!m.id) return;
    setReplyTarget({
      id: m.id,
      senderName: m.senderName,
      content: m.content,
      contentType: m.contentType,
    });
    setMenuForId(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // Refs over hasMore / loadOlderMessages because jumpToMessage's
  // useCallback has [] deps (we want a stable reference for memo
  // efficiency and DOM event listeners) but its inner loop has to
  // observe FRESH values across awaits.
  const hasMoreRef = useRef(false);
  const loadOlderRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);
  useEffect(() => {
    loadOlderRef.current = loadOlderMessages;
  }, [loadOlderMessages]);

  /** Scroll to the message DOM node and briefly ring-highlight it.
   *  When the target hasn't been loaded yet (agent cited a message
   *  via search_messages that's older than the recent window we
   *  loaded), keep calling loadOlderMessages until it appears OR
   *  we've hit the top of the room. Cap attempts so a bogus id
   *  doesn't loop forever. */
  const jumpToMessage = useCallback(async (id: string) => {
    if (!id) return;
    const tryHighlight = (): boolean => {
      const el = document.getElementById(`msg-${id}`);
      if (!el) return false;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-primary/60");
      setTimeout(() => el.classList.remove("ring-2", "ring-primary/60"), 1200);
      return true;
    };
    if (tryHighlight()) return;
    // Slow path: load older pages until found or room start reached.
    // 12 batches × 50 msgs = 600 msgs of headroom — more than enough
    // for any practical citation, while bounded so a bad id can't
    // pin the UI loading forever.
    for (let i = 0; i < 12; i++) {
      if (!hasMoreRef.current) break;
      await loadOlderRef.current();
      // Wait one paint so the new bubbles are in the DOM.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (tryHighlight()) return;
    }
    console.warn("[jump-to-message] not found in this room:", id);
  }, []);

  // Citation chips inside MarkdownContent live outside the React tree
  // we control directly (custom <a> renderer). They dispatch a window
  // event on click instead of calling props — keeps MarkdownContent
  // memo-stable. Listener funnels into the same jumpToMessage path
  // QuoteBlock uses, so chips and quotes share the load-older retry.
  useEffect(() => {
    const handler = (ev: Event) => {
      const e = ev as CustomEvent<string>;
      if (typeof e.detail === "string") jumpToMessage(e.detail);
    };
    window.addEventListener("agentplatform:jump-to-message", handler);
    return () => window.removeEventListener("agentplatform:jump-to-message", handler);
  }, [jumpToMessage]);

  // Click-anywhere closes the open action menu.
  useEffect(() => {
    if (!menuForId) return;
    const onDocClick = () => setMenuForId(null);
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menuForId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden" data-theme="dark">
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-2 py-3 md:px-4">
        {isLoadingMore && (
          <div className="flex justify-center py-3">
            <span className="loading loading-spinner loading-sm text-base-content/50"></span>
          </div>
        )}
        {messages.length === 0 && !isLoadingMore && (
          <p className="text-base-content/40 text-center mt-[30vh] text-sm">
            发送消息开始聊天。
          </p>
        )}
        {messages.map((msg, i) => {
          // Stable per-message key: prefer the persisted id, fall back
          // to index for the brief window before the optimistic message
          // gets a server id. Index-as-key is OK here because we only
          // ever append/replace-in-place — never reorder.
          const key = msg.id || `idx-${i}`;
          const isAgent = msg.senderType === "agent";
          const isLast = i === messages.length - 1;
          return (
            <MessageBubble
              key={key}
              msg={msg}
              prevCreatedAt={i > 0 ? messages[i - 1].createdAt : undefined}
              agentName={agentName}
              currentUserId={currentUserId ?? null}
              isMenuOpen={!!msg.id && menuForId === msg.id}
              isPlaying={!!msg.id && playingMessageId === msg.id}
              isStreamingThinking={isAgent && isStreaming && isLast && !msg.content}
              onContextMenu={openMenuViaContextMenu}
              onLongPressStart={startLongPress}
              onLongPressCancel={cancelLongPress}
              onJumpToMessage={jumpToMessage}
              onBeginQuote={beginQuote}
              onCloseMenu={closeMenu}
              onToggleAudio={toggleAudioPlayback}
            />
          );
        })}
        {typingUsers.size > 0 && (
          <div className="chat chat-start">
            <div className="chat-header text-xs opacity-60 mb-0.5">
              {[...typingUsers].join(", ")}
            </div>
            <div className="chat-bubble chat-bubble-neutral text-sm py-1 px-3 min-h-0">
              <span className="loading loading-dots loading-xs"></span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {replyTarget && (
        <div className="flex items-center gap-2 px-3 md:px-4 pt-2 -mb-1 border-t border-base-300">
          <div className="flex-1 min-w-0 px-2 py-1 rounded border-l-2 border-primary/60 bg-base-200 text-xs">
            <div className="opacity-60 leading-tight">
              引用 {replyTarget.senderName || "用户"}
            </div>
            <div className="opacity-90 truncate">
              {quotePreview(replyTarget, 80)}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => setReplyTarget(null)}
            title="取消引用"
          >
            ✕
          </button>
        </div>
      )}
      {ttsError && (
        <div className="px-4 pb-1 text-xs text-error/90 flex items-center gap-1.5 animate-fade-in">
          <span aria-hidden>⚠️</span>
          <span className="truncate">{ttsError}</span>
          <button
            type="button"
            onClick={() => setTtsError(null)}
            className="ml-auto text-base-content/40 hover:text-base-content"
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      )}
      {/* Input dock — mirrors DeepSeek's mobile layout: one rounded
          container, textarea on top, two stateful pills on the lower
          left, two action icon-buttons on the lower right. Replaces an
          older flat row that crammed Flash/Pro, voice, image and send
          buttons all next to the textarea — visually noisy on mobile.
          Reply chip + uploading badge are rendered above this dock by
          the surrounding layout. */}
      <div className="px-3 py-2 md:px-4 md:py-3 safe-area-bottom">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleImagePick}
        />
        <div className="rounded-3xl bg-base-200 border border-base-300 px-4 pt-2 pb-2.5">
          <textarea
            ref={textareaRef}
            className="w-full bg-transparent border-0 outline-none focus:outline-none text-sm leading-normal resize-none min-h-[1.75rem] max-h-32 placeholder:text-base-content/40"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              emitTyping();
            }}
            onKeyDown={handleKeyDown}
            placeholder="发消息"
            rows={1}
            disabled={isStreaming}
          />
          <div className="flex items-center gap-2 mt-1">
            {/* Stateful pill toggles on the left — they show what mode
                the next reply will use, blue when active. */}
            <button
              type="button"
              onClick={toggleModel}
              disabled={isStreaming}
              className={`flex items-center gap-1.5 px-3 h-7 rounded-full text-xs transition-colors ${
                model === "pro"
                  ? "bg-primary/20 text-primary border border-primary/40"
                  : "bg-transparent text-base-content/70 border border-base-content/20 hover:bg-base-content/5"
              }`}
              title={
                model === "pro"
                  ? "深度思考模式 — 点击关闭"
                  : "深度思考模式 — 点击开启"
              }
            >
              <span aria-hidden>🧠</span>
              <span>深度思考</span>
            </button>
            <div className="flex-1" />

            {/* "+" opens the OS-native file picker. iOS / Android show
                their own camera / gallery / files menu automatically
                when accept="image/*" — duplicating that menu in-app
                only added a tap. */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming || isUploading}
              className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-base-content/10 transition-colors disabled:opacity-40"
              title="发送图片"
              aria-label="发送图片"
            >
              {isUploading ? (
                <span className="loading loading-spinner loading-xs"></span>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                  className="w-4 h-4"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 4.5v15m7.5-7.5h-15"
                  />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={sendMessage}
              disabled={isStreaming || !input.trim()}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                input.trim() && !isStreaming
                  ? "bg-primary text-primary-content hover:bg-primary/90"
                  : "bg-base-content/15 text-base-content/40"
              }`}
              title="发送"
              aria-label="发送"
            >
              {isStreaming ? (
                <span className="loading loading-dots loading-xs"></span>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2.4}
                  stroke="currentColor"
                  className="w-4 h-4"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0-6 6m6-6 6 6" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
