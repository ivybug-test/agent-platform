import type { ReplyToSnippet } from "./types";
import { quotePreview } from "@/lib/chat/quote";

/** Inline quote block rendered above each reply bubble. Click → scroll to
 *  source if it's still in the loaded window; otherwise just highlights. */
export default function QuoteBlock({
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
