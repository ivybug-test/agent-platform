"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { io, Socket } from "socket.io-client";
import { sendImageMessage } from "@/lib/upload-image";
import LinkPreviewCard from "./LinkPreviewCard";
import MarkdownContent from "./MarkdownContent";
import {
  play as playTts,
  stopAll as stopAllTts,
  stripMarkdownForTts,
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
}

interface ChatPanelProps {
  roomId: string;
  onChatComplete?: () => void;
}

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
  // Real agent name from the room (e.g. "Assistant", "Maya"). Loaded with
  // the message history so optimistic placeholders match what the rest of
  // the chat shows after the SSE stream resolves.
  const [agentName, setAgentName] = useState("Assistant");

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

  // Per-room voice mode toggle. When on, every agent reply auto-plays
  // through TTS after the text stream finishes. User interruptions
  // (sending new message, toggling off, switching room) abort the
  // in-flight playback and DO NOT resume — the next agent reply will
  // spawn a fresh TTS session.
  const [voiceMode, setVoiceMode] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  // Last TTS error — surfaced as a toast above the input dock for ~4s so
  // failures (no plan, quota exceeded, network blip) don't leave the
  // user wondering why nothing played.
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
  useEffect(() => {
    if (!roomId) return;
    try {
      const saved = localStorage.getItem(`voice-mode-${roomId}`);
      setVoiceMode(saved === "on");
    } catch {
      setVoiceMode(false);
    }
    // Switching room always kills playback in flight.
    stopAllTts();
    setIsPlaying(false);
  }, [roomId]);
  const toggleVoiceMode = () => {
    setVoiceMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(`voice-mode-${roomId}`, next ? "on" : "off");
      } catch {}
      // Turning OFF mid-playback aborts immediately. Turning ON does not
      // retroactively play prior messages — only new replies trigger TTS.
      if (!next) {
        stopAllTts();
        setIsPlaying(false);
      }
      return next;
    });
  };
  const stopPlayback = () => {
    stopAllTts();
    setIsPlaying(false);
  };
  // Cleanup on unmount — drop any audio that was still playing.
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

    // User typed → interrupt any in-flight TTS. The agent's about to
    // produce a new reply; the old one is no longer interesting.
    stopAllTts();
    setIsPlaying(false);

    // Snapshot the staged quote so user can clear/replace it while we're
    // mid-flight without leaving the optimistic message holding a stale
    // reference.
    const stagedReply = replyTarget;

    const userMsg: Message = {
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
        }),
      });

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) return;
      if (!res.ok || !res.body) throw new Error("Request failed");

      reasoningStartRef.current = 0;
      setMessages((prev) => [
        ...prev,
        {
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
      // Voice mode kicks in after the text is fully streamed. Read the
      // freshly-completed message off the latest state via setMessages
      // (closure here would see stale data) and pipe its text to TTS.
      // We read voiceMode off a fresh snapshot via setVoiceMode so the
      // user toggling it off mid-stream still suppresses playback.
      setVoiceMode((vmCurrent) => {
        if (vmCurrent) {
          setMessages((prevMsgs) => {
            const last = prevMsgs[prevMsgs.length - 1];
            const clean =
              last && last.senderType === "agent"
                ? stripMarkdownForTts(last.content)
                : "";
            if (clean) {
              setIsPlaying(true);
              setTtsError(null);
              playTts({
                body: {
                  text: clean,
                  agentId: agentIdRef.current,
                },
                onEnd: () => setIsPlaying(false),
                onError: (err) => {
                  setIsPlaying(false);
                  // User-facing summary of common provider errors.
                  // Provider shape: "minimax 2061: token plan not support model"
                  // / "minimax 2049: invalid api key" / "tts request failed: 502 ..."
                  const raw = err?.message || String(err);
                  if (/abort/i.test(raw)) return; // user-initiated, no toast
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
            }
            return prevMsgs;
          });
        }
        return vmCurrent;
      });
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
    try {
      const msg = await sendImageMessage(file, roomId, stagedReply?.id ?? null);
      seenIds.current.add(msg.id);
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

  const startLongPress = (m: Message) => {
    if (!m.id) return;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      setMenuForId(m.id!);
    }, 450);
  };
  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  const openMenuViaContextMenu = (e: React.MouseEvent, m: Message) => {
    if (!m.id) return;
    e.preventDefault();
    setMenuForId(m.id);
  };

  const beginQuote = (m: Message) => {
    if (!m.id) return;
    setReplyTarget({
      id: m.id,
      senderName: m.senderName,
      content: m.content,
      contentType: m.contentType,
    });
    setMenuForId(null);
    // Focus the input so the user can keep typing immediately.
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const jumpToMessage = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-primary/60");
    setTimeout(() => el.classList.remove("ring-2", "ring-primary/60"), 1200);
  };

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
          const isMe = msg.senderType === "user" && msg.senderId === currentUserId;
          const isAgent = msg.senderType === "agent";
          const displayName = isMe
            ? "我"
            : msg.senderName || (isAgent ? "Agent" : "用户");
          const bubbleColor = isAgent
            ? "chat-bubble-neutral"
            : isMe
              ? "chat-bubble-primary"
              : colorForUser(msg.senderId || "unknown");

          // Day divider: inserted whenever this message crosses to a new
          // calendar day in Asia/Shanghai compared to the previous message.
          const prev = i > 0 ? messages[i - 1] : null;
          const showDayDivider =
            msg.createdAt && (!prev || dayKey(prev.createdAt) !== dayKey(msg.createdAt));

          const timeLabel = fmtTime(msg.createdAt);

          return (
            <div key={i} id={msg.id ? `msg-${msg.id}` : undefined} className="rounded transition-shadow">
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
                    <time className="ml-1.5 opacity-60 text-[10px]">
                      {timeLabel}
                    </time>
                  )}
                </div>
                <div
                  className={`chat-bubble ${bubbleColor} text-sm select-text`}
                  onContextMenu={(e) => openMenuViaContextMenu(e, msg)}
                  onTouchStart={() => startLongPress(msg)}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                >
                  {msg.replyTo && (
                    <QuoteBlock reply={msg.replyTo} onJump={jumpToMessage} />
                  )}
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
                      {msg.reasoning && (
                        <ThinkingPanel
                          reasoning={msg.reasoning}
                          reasoningMs={msg.reasoningMs}
                          // The latest agent message is "active" while
                          // the panel itself has reasoning but no answer
                          // text yet — auto-expand and animate the label.
                          streaming={
                            isAgent &&
                            isStreaming &&
                            i === messages.length - 1 &&
                            !msg.content
                          }
                        />
                      )}
                      {/* Agent replies are markdown (headings, lists,
                          tables, **bold**, [links]); user messages are
                          plain text — render them as preserved-whitespace
                          to avoid bullet-glyph hijacking from a stray "-".
                          react-markdown handles partial syntax during
                          streaming gracefully. */}
                      {isAgent ? (
                        <MarkdownContent>{msg.content}</MarkdownContent>
                      ) : (
                        <div className="whitespace-pre-wrap">{msg.content}</div>
                      )}
                      {extractUrls(msg.content).map((u) => (
                        <LinkPreviewCard key={u} url={u} />
                      ))}
                    </>
                  )}
                </div>
                {menuForId && menuForId === msg.id && (
                  <div
                    className={`absolute z-20 ${isMe ? "right-2" : "left-2"} -bottom-8 bg-base-100 border border-base-300 rounded-lg shadow-lg text-xs overflow-hidden`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="px-3 py-1.5 hover:bg-base-200 active:bg-base-300 w-full text-left"
                      onClick={() => beginQuote(msg)}
                    >
                      引用
                    </button>
                  </div>
                )}
              </div>
            </div>
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
            <button
              type="button"
              onClick={isPlaying ? stopPlayback : toggleVoiceMode}
              disabled={isStreaming && !voiceMode && !isPlaying}
              className={`flex items-center gap-1.5 px-3 h-7 rounded-full text-xs transition-colors ${
                isPlaying
                  ? "bg-error/20 text-error border border-error/40"
                  : voiceMode
                    ? "bg-primary/20 text-primary border border-primary/40"
                    : "bg-transparent text-base-content/70 border border-base-content/20 hover:bg-base-content/5"
              }`}
              title={
                isPlaying
                  ? "正在播放 — 点击停止"
                  : voiceMode
                    ? "语音模式开 — 点击关闭"
                    : "语音模式 — 点击开启（agent 回复后自动朗读）"
              }
            >
              <span aria-hidden>{isPlaying ? "⏹" : "🔊"}</span>
              <span>{isPlaying ? "停止" : "语音"}</span>
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
