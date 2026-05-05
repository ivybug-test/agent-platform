import { useEffect, useState } from "react";

export type ChatModel = "flash" | "pro";

/** Per-room DeepSeek model toggle: flash (fast/cheap default) or pro
 *  (thinking/reasoning). Persisted in localStorage so a user's choice
 *  survives reload but stays scoped to that room. */
export function useChatModel(roomId: string) {
  const [model, setModel] = useState<ChatModel>("flash");

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
      const next: ChatModel = prev === "flash" ? "pro" : "flash";
      try {
        localStorage.setItem(`chat-model-${roomId}`, next);
      } catch {}
      return next;
    });
  };

  return { model, toggleModel };
}
