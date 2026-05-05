import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import type { Message } from "@/components/chat/types";

/** Owns everything that talks to the realtime-gateway + the messages
 *  list itself: initial load, room-id swap reset, Socket.IO subscription
 *  (room-message + typing), refetch on reconnect, scroll-to-top
 *  pagination, and the typing emit. Returns refs / state callers need
 *  for optimistic updates from sendMessage etc. */
export function useRoomChannel(opts: {
  roomId: string;
  currentUserId: string | undefined;
  userName: string;
  agentIdRef: React.MutableRefObject<string | null>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  isInitialLoadRef: React.MutableRefObject<boolean>;
}) {
  const {
    roomId,
    currentUserId,
    userName,
    agentIdRef,
    scrollContainerRef,
    isInitialLoadRef,
  } = opts;

  const [messages, setMessages] = useState<Message[]>([]);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [agentName, setAgentName] = useState("agent");

  const seenIds = useRef<Set<string>>(new Set());
  const socketRef = useRef<Socket | null>(null);
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  // Mirror messages through a ref so loadOlderMessages can read the
  // current list without forcing the callback to depend on `messages`
  // (its useCallback would invalidate on every keystroke / streaming
  // chunk, which would in turn invalidate the scroll-to-top effect's
  // listener on every render).
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Reset + initial load on roomId change.
  useEffect(() => {
    setMessages([]);
    setHasMore(false);
    seenIds.current.clear();
    isInitialLoadRef.current = true;
    (async () => {
      const res = await fetch(`/api/messages?roomId=${roomId}`);
      if (!res.ok) return;
      const data = await res.json();
      const loaded: Message[] = data.messages
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
          imageGen: r.metadata?.imageGen,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

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
        imageGen: r.metadata?.imageGen,
      }));
    for (const m of fetched) {
      if (m.id) seenIds.current.add(m.id);
    }
    setMessages(fetched);
    setHasMore(data.hasMore ?? false);
  }, [roomId]);

  const loadOlderMessages = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    const oldest = messagesRef.current.find((m) => m.createdAt);
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
          imageGen: r.metadata?.imageGen,
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
  }, [roomId, hasMore, isLoadingMore, scrollContainerRef]);

  // Socket.IO: room-message + typing
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
      const existing = typingTimers.current.get(name);
      if (existing) clearTimeout(existing);
      typingTimers.current.set(
        name,
        setTimeout(() => {
          setTypingUsers((prev) => {
            const next = new Set(prev);
            next.delete(name);
            return next;
          });
          typingTimers.current.delete(name);
        }, 3000)
      );
    });

    socket.on("room-message", (event: any) => {
      const msg = event.message;
      if (!msg) return;
      // 'message-updated' refers to a messageId we already have in
      // state — update by id, don't insert.
      if (event.type === "message-updated") {
        if (!msg.id) return;
        // Phase updates for image-pending bubbles arrive via
        // message-updated but the broadcast doesn't carry imageGen
        // metadata — re-fetch /api/messages/<id> and merge in.
        if (msg.contentType === "image-pending") {
          fetch(`/api/messages/${msg.id}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (!data?.message) return;
              const ig = data.message.metadata?.imageGen;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === msg.id ? { ...m, imageGen: ig ?? m.imageGen } : m
                )
              );
            })
            .catch(() => {});
          return;
        }
        // Final swap (image / image-failed) — content has the real
        // URL or the failure / cancel reason. Replace in place.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msg.id
              ? {
                  ...m,
                  content: msg.content ?? m.content,
                  contentType: msg.contentType ?? m.contentType,
                  imageGen: undefined,
                }
              : m
          )
        );
        return;
      }
      // Skip empty messages (image-pending placeholders are an
      // exception — they have content="" but a real contentType).
      if (!msg.content && msg.contentType !== "image-pending") return;
      // Skip our own user messages (already shown locally).
      if (msg.senderType === "user" && msg.senderId === currentUserId) return;
      // Skip agent text messages triggered by us — those streamed in via
      // SSE already; the Redis echo would just duplicate. EXCEPT image
      // messages (real or pending) from generate_image: SSE doesn't
      // carry image bubbles. The tool_result handler already inserted
      // the placeholder; seenIds.has(msg.id) below catches that.
      if (
        msg.senderType === "agent" &&
        event.triggeredBy === currentUserId &&
        msg.contentType !== "image" &&
        msg.contentType !== "image-pending" &&
        msg.contentType !== "image-failed"
      )
        return;
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

  // Scroll-to-top → loadOlderMessages
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
  }, [hasMore, isLoadingMore, loadOlderMessages, scrollContainerRef]);

  // Typing emit (debounced: at most once per 2s)
  const lastTypingEmit = useRef(0);
  const emitTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingEmit.current < 2000) return;
    lastTypingEmit.current = now;
    const socket = socketRef.current;
    if (socket) {
      socket.emit("typing", { roomId, userName });
    }
  }, [roomId, userName]);

  return {
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
  };
}
