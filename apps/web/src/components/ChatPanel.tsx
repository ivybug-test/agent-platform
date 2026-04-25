"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { io, Socket } from "socket.io-client";
import { sendImageMessage } from "@/lib/upload-image";
import LinkPreviewCard from "./LinkPreviewCard";

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
        }));
      for (const m of loaded) {
        if (m.id) seenIds.current.add(m.id);
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

    const userMsg: Message = {
      senderType: "user",
      senderId: currentUserId || null,
      senderName: session?.user?.name || "You",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, content: text, model }),
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
          senderName: "Agent",
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
          senderName: "Agent",
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
    try {
      const msg = await sendImageMessage(file, roomId);
      seenIds.current.add(msg.id);
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
        },
      ]);
    } catch (err: any) {
      alert(`图片发送失败:${err?.message || "未知错误"}`);
    } finally {
      setIsUploading(false);
    }
  };

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
            <div key={i}>
              {showDayDivider && (
                <div className="flex justify-center my-3">
                  <span className="text-[10px] px-2 py-0.5 rounded bg-base-300/60 text-base-content/50">
                    {dayDividerLabel(msg.createdAt)}
                  </span>
                </div>
              )}
              <div className={`chat ${isMe ? "chat-end" : "chat-start"}`}>
                <div className="chat-header text-xs opacity-60 mb-0.5">
                  {displayName}
                  {timeLabel && (
                    <time className="ml-1.5 opacity-60 text-[10px]">
                      {timeLabel}
                    </time>
                  )}
                </div>
                <div className={`chat-bubble ${bubbleColor} text-sm`}>
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
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                      {extractUrls(msg.content).map((u) => (
                        <LinkPreviewCard key={u} url={u} />
                      ))}
                    </>
                  )}
                </div>
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

      <div className="flex gap-2 px-3 py-2 md:px-4 md:py-3 border-t border-base-300 safe-area-bottom">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleImagePick}
        />
        <button
          type="button"
          onClick={toggleModel}
          disabled={isStreaming}
          className={`btn btn-sm self-end px-2 md:min-w-[3.5rem] ${
            model === "pro" ? "btn-secondary" : "btn-ghost"
          }`}
          title={
            model === "pro"
              ? "深度思考模式 (Pro) — 慢一点但推理更强，点击切回快速"
              : "快速模式 (Flash) — 默认，点击切到深度思考"
          }
        >
          <span className="md:hidden text-base leading-none" aria-hidden>
            {model === "pro" ? "🧠" : "⚡"}
          </span>
          <span className="hidden md:inline">
            {model === "pro" ? "深度" : "快速"}
          </span>
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm self-end px-2"
          onClick={() => fileInputRef.current?.click()}
          disabled={isStreaming || isUploading}
          title="发送图片"
        >
          {isUploading ? (
            <span className="loading loading-spinner loading-xs"></span>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
            </svg>
          )}
        </button>
        <textarea
          className="textarea textarea-bordered flex-1 min-h-[2.5rem] max-h-32 text-sm leading-normal resize-none bg-base-200"
          value={input}
          onChange={(e) => { setInput(e.target.value); emitTyping(); }}
          onKeyDown={handleKeyDown}
          placeholder="输入消息..."
          rows={1}
          disabled={isStreaming}
        />
        <button
          className="btn btn-primary btn-sm self-end"
          onClick={sendMessage}
          disabled={isStreaming}
        >
          {isStreaming ? (
            <span className="loading loading-dots loading-xs"></span>
          ) : (
            "发送"
          )}
        </button>
      </div>
    </div>
  );
}
