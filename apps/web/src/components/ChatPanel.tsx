"use client";

import { useState, useRef, useEffect } from "react";
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
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    (async () => {
      const res = await fetch(`/api/messages?roomId=${roomId}`);
      if (!res.ok) return;
      const data = await res.json();
      setMessages(
        data.messages
          .filter((r: any) => r.senderType !== "system")
          .map((r: any) => ({
            senderType: r.senderType,
            senderId: r.senderId,
            senderName: r.senderName,
            content: r.content,
          }))
      );
    })();
  }, [roomId]);

  // WebSocket: listen for real-time messages from other users
  const socketRef = useRef<Socket | null>(null);
  const seenIds = useRef(new Set<string>());

  useEffect(() => {
    const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
    if (!gatewayUrl) return;

    const socket = io(gatewayUrl, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join-room", roomId);
    });

    socket.on("room-message", (event: any) => {
      const msg = event.message;
      if (!msg) return;
      // Skip our own messages (we already show them locally)
      if (msg.senderType === "user" && msg.senderId === currentUserId) return;
      // Skip duplicates
      if (msg.id && seenIds.current.has(msg.id)) return;
      if (msg.id) seenIds.current.add(msg.id);

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
  }, [roomId, currentUserId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
          if (data === "[DONE]") break;
          try {
            const { content } = JSON.parse(data);
            if (content) {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                updated[updated.length - 1] = { ...last, content: last.content + content };
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
        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2 px-3 py-2 md:px-4 md:py-3 border-t border-base-300 safe-area-bottom">
        <textarea
          className="textarea textarea-bordered flex-1 min-h-[2.5rem] max-h-32 text-sm leading-normal resize-none bg-base-200"
          value={input}
          onChange={(e) => setInput(e.target.value)}
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
