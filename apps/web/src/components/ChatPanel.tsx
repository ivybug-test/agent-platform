"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { io, Socket } from "socket.io-client";

interface Message {
  id?: string;
  senderType: "user" | "agent";
  senderId: string | null;
  senderName: string | null;
  content: string;
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
function colorForUser(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return bubbleColors[Math.abs(hash) % bubbleColors.length];
}

export default function ChatPanel({ roomId, onChatComplete }: ChatPanelProps) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    seenIds.current.clear();
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
        }));
      for (const m of loaded) {
        if (m.id) seenIds.current.add(m.id);
      }
      setMessages(loaded);
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
      }));
    // Mark all fetched IDs as seen
    for (const m of fetched) {
      if (m.id) seenIds.current.add(m.id);
    }
    setMessages(fetched);
  }, [roomId]);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typingUsers]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMsg: Message = {
      senderType: "user",
      senderId: currentUserId || null,
      senderName: session?.user?.name || "You",
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, content: text }),
      });

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) return;
      if (!res.ok || !res.body) throw new Error("Request failed");

      setMessages((prev) => [
        ...prev,
        { senderType: "agent", senderId: null, senderName: "Agent", content: "" },
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
            if (parsed.content) {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                updated[updated.length - 1] = { ...last, content: last.content + parsed.content };
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
          content: "Error: failed to get response.",
        };
        return updated;
      });
    } finally {
      setIsStreaming(false);
      onChatComplete?.();
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
      <div className="flex-1 overflow-y-auto px-2 py-3 md:px-4">
        {messages.length === 0 && (
          <p className="text-base-content/40 text-center mt-[30vh] text-sm">
            Send a message to start chatting.
          </p>
        )}
        {messages.map((msg, i) => {
          const isMe = msg.senderType === "user" && msg.senderId === currentUserId;
          const isAgent = msg.senderType === "agent";
          const displayName = isMe
            ? "You"
            : msg.senderName || (isAgent ? "Agent" : "User");
          const bubbleColor = isAgent
            ? "chat-bubble-neutral"
            : isMe
              ? "chat-bubble-primary"
              : colorForUser(msg.senderId || "unknown");

          return (
            <div key={i} className={`chat ${isMe ? "chat-end" : "chat-start"}`}>
              <div className="chat-header text-xs opacity-60 mb-0.5">
                {displayName}
              </div>
              <div className={`chat-bubble ${bubbleColor} text-sm`}>
                <div className="whitespace-pre-wrap">{msg.content}</div>
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
        <textarea
          className="textarea textarea-bordered flex-1 min-h-[2.5rem] max-h-32 text-sm leading-normal resize-none bg-base-200"
          value={input}
          onChange={(e) => { setInput(e.target.value); emitTyping(); }}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
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
            "Send"
          )}
        </button>
      </div>
    </div>
  );
}
