/** Collapsible chain-of-thought panel — DeepSeek v4-pro returns
 *  reasoning_content as a separate stream channel; we surface it above
 *  the actual answer in a muted, italic, expandable block. Default-
 *  expanded while the message is still streaming reasoning, default-
 *  collapsed once the final answer is in. */
export default function ThinkingPanel({
  reasoning,
  reasoningMs,
  streaming,
}: {
  reasoning: string;
  reasoningMs?: number;
  streaming: boolean;
}) {
  const seconds =
    reasoningMs && reasoningMs > 0
      ? Math.max(1, Math.round(reasoningMs / 1000))
      : 0;
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
