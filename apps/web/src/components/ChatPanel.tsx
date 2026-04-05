"use client";

import { useState, useRef, useEffect } from "react";
import { useSession } from "next-auth/react";

interface Message {
  senderType: "user" | "agent";
  senderId: string | null;
  senderName: string | null;
  content: string;
}

interface ChatPanelProps {
  roomId: string;
  onChatComplete?: () => void;
}

const userColors = ["bg-primary", "bg-orange-700", "bg-purple-700", "bg-green-700", "bg-red-800", "bg-cyan-700"];
function colorClassForUser(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return userColors[Math.abs(hash) % userColors.length];
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
      if (contentType.includes("application/json")) {
        return;
      }

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
                updated[updated.length - 1] = {
                  ...last,
                  content: last.content + content,
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
    <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto flex flex-col gap-2 p-3">
        {messages.length === 0 && (
          <p className="text-text-dim text-center mt-[30vh]">
            Send a message to start chatting.
          </p>
        )}
        {messages.map((msg, i) => {
          const isMe = msg.senderType === "user" && msg.senderId === currentUserId;
          const isAgent = msg.senderType === "agent";
          const displayName = isMe
            ? "You"
            : msg.senderName || (isAgent ? "Agent" : "User");
          const bgClass = isAgent
            ? "bg-bg-tertiary"
            : isMe
              ? "bg-primary"
              : colorClassForUser(msg.senderId || "unknown");

          return (
            <div
              key={i}
              className={`max-w-[80%] px-3 py-2 rounded-lg text-sm leading-relaxed text-white ${bgClass} ${isMe ? "self-end" : "self-start"}`}
            >
              <div className="text-[11px] opacity-60 mb-0.5">{displayName}</div>
              <div className="whitespace-pre-wrap">{msg.content}</div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2 px-4 py-2 border-t border-border">
        <textarea
          className="flex-1 px-3 py-2.5 rounded-lg border border-border bg-bg-secondary text-white text-sm resize-none outline-none"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          disabled={isStreaming}
        />
        <button
          className="px-5 py-2.5 rounded-lg bg-primary text-white text-sm cursor-pointer disabled:opacity-50"
          onClick={sendMessage}
          disabled={isStreaming}
        >
          {isStreaming ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}
