"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { sendImageMessage } from "@/lib/upload-image";
import MessageBubble from "./chat/MessageBubble";
import type {
  Message,
  ReplyToSnippet,
  ToolInvocation,
} from "./chat/types";
import { stopAll as stopAllTts } from "@/lib/audio/streaming-player";
import {
  VISIBLE_TOOLS,
  queryFromArgs,
  resolveToolInvocation,
} from "@/lib/chat/tool-invocations";
import { quotePreview } from "@/lib/chat/quote";
import { makeMessageId } from "@/lib/chat/message-helpers";
import { parseSSE } from "@/lib/chat/sse-stream";
import { useChatModel } from "@/hooks/useChatModel";
import { useTTSPlayer } from "@/hooks/useTTSPlayer";
import { useRoomChannel } from "@/hooks/useRoomChannel";


interface ChatPanelProps {
  roomId: string;
  onChatComplete?: () => void;
}


export default function ChatPanel({ roomId, onChatComplete }: ChatPanelProps) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Reply / quote state — set by long-press / right-click on a message,
  // shown as a chip above the input, sent with the next message and then
  // cleared. `null` means no quote is staged.
  const [replyTarget, setReplyTarget] = useState<ReplyToSnippet | null>(null);
  // Which message's action menu is currently open. Keyed by message id;
  // `null` closes any open menu.
  const [menuForId, setMenuForId] = useState<string | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { model, toggleModel } = useChatModel(roomId);
  const {
    playingMessageId,
    setPlayingMessageId,
    ttsError,
    setTtsError,
    agentIdRef,
    toggleAudioPlayback,
  } = useTTSPlayer(roomId);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const isInitialLoad = useRef(true);

  const {
    messages,
    setMessages,
    typingUsers,
    hasMore,
    isLoadingMore,
    agentName,
    seenIds,
    refetchMessages,
    loadOlderMessages,
    emitTyping,
  } = useRoomChannel({
    roomId,
    currentUserId,
    userName: session?.user?.name || "User",
    agentIdRef,
    scrollContainerRef,
    isInitialLoadRef: isInitialLoad,
  });
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


  // Auto-scroll to bottom only when near bottom (not when loading older messages)
  const shouldAutoScroll = useRef(true);
  // Pop a "↓ 最新" floating button when the user is far enough above
  // bottom that fresh messages would scroll off-screen — useful after
  // tapping a citation chip / scrolling up to read history. State (not
  // ref) so the button can render conditionally; the setter no-ops
  // when the value would be identical, so this isn't a per-scroll
  // re-render.
  const [farFromBottom, setFarFromBottom] = useState(false);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleUserScroll = () => {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      shouldAutoScroll.current = distFromBottom < 150;
      setFarFromBottom((prev) => {
        const next = distFromBottom > 500;
        return prev === next ? prev : next;
      });
    };
    container.addEventListener("scroll", handleUserScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleUserScroll);
  }, []);

  /** Click handler for the floating "↓ 最新" button. */
  const jumpToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    shouldAutoScroll.current = true;
    setFarFromBottom(false);
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

    // Force a snap-to-bottom for the upcoming optimistic message + agent
    // reply, even if the user had scrolled up (e.g. clicked a citation
    // chip earlier). Pressing send is an unambiguous "I'm engaging with
    // the latest", so the auto-scroll gate flips back on regardless of
    // current scroll position.
    shouldAutoScroll.current = true;

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

    // All streaming-bubble mutations go through this helper instead of
    // poking `prev[prev.length-1]`. Position-based access broke when
    // another room member's message arrived via socket mid-stream: the
    // new message landed at the end, the next SSE chunk targeted it
    // instead of the agent bubble, and the agent's text got glued to
    // the user's bubble (issue #10). Targeting by id makes the
    // streaming bubble immune to concurrent inserts.
    const updateAgentBubble = (updater: (m: Message) => Message): void => {
      setMessages((prev) =>
        prev.map((m) => (m.id === agentMessageId ? updater(m) : m))
      );
    };

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

      for await (const evt of parseSSE(res)) {
        if (evt.type === "done") {
          // Server sends {done, messageId} at end of stream for dedup —
          // the matching agent-message Redis echo arrives later and the
          // socket handler skips by id.
          if (evt.messageId) seenIds.current.add(evt.messageId);
        } else if (evt.type === "content_retracted") {
          // Validator caught a content/tool_call mismatch on the agent-
          // runtime side and is replaying the round with a forced
          // tool_choice. Wipe the partial reply we'd streamed so the
          // corrected version replaces it cleanly (server side already
          // throws away its accumulated fullContent on the same event).
          updateAgentBubble((m) => ({ ...m, content: "" }));
        } else if (evt.type === "reasoning") {
          updateAgentBubble((m) => {
            const wasEmpty = !m.reasoning;
            return {
              ...m,
              reasoning: (m.reasoning || "") + evt.text,
              // First reasoning chunk → start the timer. Subsequent
              // chunks while content hasn't started yet bump
              // reasoningMs forward; the moment content begins we
              // stop updating it.
              reasoningMs:
                wasEmpty || !m.reasoningMs ? 0 : m.reasoningMs,
            };
          });
          // Track when reasoning began so we can close out reasoningMs
          // when content starts arriving.
          if (!reasoningStartRef.current) {
            reasoningStartRef.current = Date.now();
          }
        } else if (evt.type === "content") {
          updateAgentBubble((m) => {
            const reasoningMs =
              m.reasoning && reasoningStartRef.current && !m.reasoningMs
                ? Date.now() - reasoningStartRef.current
                : m.reasoningMs;
            return {
              ...m,
              content: m.content + evt.text,
              reasoningMs,
            };
          });
        } else if (evt.type === "tool_call") {
          // Track name + args for ALL tool_calls — `speak` needs them at
          // tool_result time even though it doesn't show up in the
          // visible-tools card.
          pendingToolCallIds.current.set(evt.id, evt.name);
          pendingToolArgs.current.set(evt.id, evt.args);
          if (VISIBLE_TOOLS.has(evt.name)) {
            updateAgentBubble((m) => ({
              ...m,
              toolInvocations: [
                ...(m.toolInvocations || []),
                {
                  name: evt.name,
                  query: queryFromArgs(evt.name, evt.args),
                  pending: true,
                },
              ],
            }));
          }
        } else if (evt.type === "tool_result") {
          const knownName =
            pendingToolCallIds.current.get(evt.id) || evt.name || "";
          const knownArgs = pendingToolArgs.current.get(evt.id) || "";
          pendingToolCallIds.current.delete(evt.id);
          pendingToolArgs.current.delete(evt.id);
          // generate_image: tool returns immediately with a placeholder
          // messageId (queued: true) — the actual gen runs server-side
          // in the background. Insert a pending bubble here so the user
          // sees a "生成中..." spinner without waiting for Redis. Find
          // the streaming agent bubble's index by id and splice the
          // image bubble immediately before it; this stays robust to
          // concurrent socket inserts.
          if (knownName === "generate_image" && evt.ok && evt.data) {
            // evt.data is the full handler return value. image-tools.ts
            // returns `{ data: { messageId, queued, provider } }` — the
            // same `{ data: ... }` wrapping pattern web_search etc use,
            // so the actual payload lives at evt.data.data.
            const payload = (evt.data as any)?.data ?? evt.data;
            const newId =
              typeof payload?.messageId === "string"
                ? payload.messageId
                : "";
            if (newId && !seenIds.current.has(newId)) {
              seenIds.current.add(newId);
              // Pull the prompt out of the agent's tool_call args so
              // the placeholder bubble can show it under the spinner.
              let promptShown: string | undefined;
              try {
                const a = JSON.parse(knownArgs || "{}");
                if (typeof a?.prompt === "string") {
                  promptShown =
                    a.prompt.length > 80
                      ? a.prompt.slice(0, 80) + "…"
                      : a.prompt;
                }
              } catch {}
              const startedAt = new Date().toISOString();
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === agentMessageId);
                const insertAt = idx >= 0 ? idx : prev.length;
                const next = [...prev];
                next.splice(insertAt, 0, {
                  id: newId,
                  senderType: "agent",
                  senderId: agentIdRef.current,
                  senderName: agentName,
                  content: "",
                  contentType: "image-pending",
                  createdAt: startedAt,
                  imageGen: {
                    prompt: promptShown,
                    phase: "排队中",
                    startedAt,
                  },
                });
                return next;
              });
            }
          }
          // `speak` resolution: live-attach the audio metadata to the
          // in-flight agent message so the 🔊 button shows up right
          // when the tool fires, not only after reload. stream.ts
          // persists the same blob server-side.
          if (knownName === "speak" && evt.ok && knownArgs) {
            try {
              const args = JSON.parse(knownArgs);
              if (typeof args?.text === "string" && args.text.trim()) {
                updateAgentBubble((m) => ({
                  ...m,
                  audio: {
                    text: args.text.trim(),
                    ...(typeof args?.voiceId === "string"
                      ? { voiceId: args.voiceId }
                      : {}),
                  },
                }));
              }
            } catch {}
          }
          if (knownName && VISIBLE_TOOLS.has(knownName)) {
            updateAgentBubble((m) => {
              const list = [...(m.toolInvocations || [])];
              // Find the matching pending row (latest for this tool
              // name) and replace it with the resolved data.
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
                evt.data,
                evt.ok
              );
              if (idx >= 0) {
                list[idx] = resolved;
              } else {
                list.push(resolved);
              }
              return { ...m, toolInvocations: list };
            });
          }
        }
      }
    } catch {
      updateAgentBubble((m) => ({
        ...m,
        content: "错误:未能获取回复。",
      }));
    } finally {
      setIsStreaming(false);
      // B1 (副作用工具不留空文字气泡): if the streaming bubble has
      // nothing to render — no text, no audio button, no thinking
      // panel, no visible tool card — then either an image bubble
      // (spliced separately above) or audio metadata IS the reply,
      // and showing an empty agent bubble next to it looks broken.
      // Keep the bubble whenever there's *anything* to display.
      setMessages((prev) =>
        prev.filter((m) => {
          if (m.id !== agentMessageId) return true;
          const empty =
            !m.content &&
            !m.audio &&
            !m.reasoning &&
            (!m.toolInvocations || m.toolInvocations.length === 0);
          return !empty;
        })
      );
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
    // Same scroll-snap reasoning as sendMessage — engaging with send
    // means we want to see the new bubble regardless of current
    // scroll position.
    shouldAutoScroll.current = true;
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
    longPressTimerRef.current = setTimeout(() => {
      console.log("[diag] long-press timer fired → opening menu for", id);
      setMenuForId(id);
    }, 450);
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
   *  we've hit the top of the room. */
  const jumpToMessage = useCallback(async (id: string) => {
    if (!id) return;
    // The auto-scroll-to-bottom effect would otherwise fight us:
    // loadOlderMessages mutates messages, the effect runs, sees
    // shouldAutoScroll=true (when user happened to be near bottom
    // before clicking the chip) and yanks us back down. Suppress for
    // the duration of this jump; if the user is already near bottom
    // after the jump completes, the scroll handler will flip it back
    // on the next scroll event.
    shouldAutoScroll.current = false;

    const highlight = async (el: HTMLElement) => {
      // Explicit scroll-to math via getBoundingClientRect (NOT
      // offsetTop — the outer wrapper is the offsetParent because of
      // the "↓ 最新" button's `relative` anchor, and offsetTop would
      // include the scroll container's distance from it).
      const container = scrollContainerRef.current;
      if (!container) {
        el.scrollIntoView({ block: "center" });
        el.classList.add("ring-2", "ring-primary/60");
        setTimeout(() => el.classList.remove("ring-2", "ring-primary/60"), 1200);
        return;
      }
      const computeTargetTop = (): number => {
        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const elTopInContainer =
          elRect.top - containerRect.top + container.scrollTop;
        return Math.max(
          0,
          elTopInContainer - container.clientHeight / 2 + elRect.height / 2
        );
      };
      // Multi-pass scroll. content-visibility:auto bubbles are sized
      // by their contain-intrinsic-size (120px placeholder) until they
      // first paint. The first scrollTo lands using those placeholder
      // heights — close-but-wrong because real bubbles vary from 60-
      // 600px. Once the target's neighborhood scrolls into view those
      // bubbles render with real heights, the layout shifts, and a
      // re-measure gives the correct center. Iterate until the
      // computed top stabilizes (within 2px) or we've spent 4 frames,
      // whichever comes first.
      let prev = -1;
      for (let i = 0; i < 4; i++) {
        const target = computeTargetTop();
        if (Math.abs(target - prev) < 2) break;
        container.scrollTo({ top: target, behavior: "auto" });
        prev = target;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      el.classList.add("ring-2", "ring-primary/60");
      setTimeout(() => el.classList.remove("ring-2", "ring-primary/60"), 1200);
    };

    // Poll the DOM for up to `ms` waiting for the target id to appear.
    // One rAF after setMessages isn't always enough — concurrent-mode
    // commits can land on a later frame, and a fresh batch of 50
    // bubbles takes real time to paint with React.memo'd children.
    const waitForEl = async (ms: number): Promise<HTMLElement | null> => {
      const start = performance.now();
      while (performance.now() - start < ms) {
        const el = document.getElementById(`msg-${id}`);
        if (el) return el;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      return null;
    };

    // Fast path — already loaded.
    const fast = document.getElementById(`msg-${id}`);
    if (fast) {
      await highlight(fast);
      return;
    }
    // Slow path. Each iteration: load older page, give the DOM up to
    // 500ms to commit + paint, retry. Cap at 12 batches (≈600 msgs)
    // so a bogus id can't pin the UI loading forever.
    for (let i = 0; i < 12; i++) {
      if (!hasMoreRef.current) break;
      await loadOlderRef.current();
      const el = await waitForEl(500);
      if (el) {
        await highlight(el);
        return;
      }
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

  // Poll fallback for in-flight generate_image placeholders. Without
  // realtime-gateway the BG-promise's "message-updated" Redis event
  // never reaches the browser — the spinner spins forever and the
  // final image only shows on next page reload. Poll
  // /api/messages/<id> every 3s; also picks up phase changes when
  // the gateway IS up but Socket.IO has lagged.
  //
  // CRITICAL: deps are [pendingImageCount] ONLY — adding `messages`
  // makes the effect re-run on every setMessages call (e.g. each
  // agent-text-streaming chunk) which clears the previous interval
  // before it ever ticks. The inner closure reads messages via a ref
  // so it still sees the latest list.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const pendingImageCount = messages.filter(
    (m) => m.contentType === "image-pending" && m.id
  ).length;
  useEffect(() => {
    if (pendingImageCount === 0) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const targets = messagesRef.current
        .filter((m) => m.contentType === "image-pending" && m.id)
        .map((m) => m.id!);
      if (targets.length === 0) return;
      const updates = await Promise.all(
        targets.map(async (id) => {
          try {
            const res = await fetch(`/api/messages/${id}`);
            if (!res.ok) return null;
            const d = await res.json();
            return d?.message;
          } catch {
            return null;
          }
        })
      );
      if (stopped) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (!m.id) return m;
          const u = updates.find((u) => u && u.id === m.id);
          if (!u) return m;
          if (u.contentType !== "image-pending") {
            return {
              ...m,
              content: u.content,
              contentType: u.contentType,
              imageGen: undefined,
            };
          }
          const ig = u.metadata?.imageGen;
          if (ig && ig.phase !== m.imageGen?.phase) {
            return { ...m, imageGen: ig };
          }
          return m;
        })
      );
    };
    // 5s rather than 3s — Doubao gen is ~20s so we don't need a
    // tighter cadence, and halving the load on /api/messages/<id>
    // takes pressure off the Postgres connection pool.
    const interval = setInterval(tick, 5000);
    tick();
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [pendingImageCount]);

  // Click-anywhere closes the open action menu. We arm the listener
  // after a short delay so the synthesized `click` that browsers fire
  // right after `touchend` (following the long-press setTimeout that
  // opened the menu) doesn't slam it shut on the same gesture.
  useEffect(() => {
    if (!menuForId) return;
    let armed = false;
    const armTimer = setTimeout(() => {
      armed = true;
    }, 100);
    const onDocClick = () => {
      if (!armed) return;
      setMenuForId(null);
    };
    document.addEventListener("click", onDocClick);
    return () => {
      clearTimeout(armTimer);
      document.removeEventListener("click", onDocClick);
    };
  }, [menuForId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="relative flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden" data-theme="dark">
      {farFromBottom && (
        // Floats above the input dock, anchored to the outer relative
        // container. Appears once the user scrolls more than ~500px
        // above bottom, vanishes again on jump or when they scroll
        // close enough that auto-scroll-on-new-message would catch
        // them anyway.
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute right-3 bottom-24 z-10 flex items-center gap-1 px-3 h-8 rounded-full bg-base-100 border border-base-content/30 shadow text-xs text-base-content/80 hover:bg-base-200 active:bg-base-300"
          title="跳到最新"
          aria-label="跳到最新"
        >
          <span aria-hidden>↓</span>
          <span>最新</span>
        </button>
      )}
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
