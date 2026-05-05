import type { ToolInvocation } from "./types";
import { TOOL_LABEL, safeHost } from "@/lib/chat/tool-invocations";

/** Compact "已搜索 N 个网页" card rendered above the agent bubble. Open it
 *  to see each result (title, host, snippet) as a clickable row. */
export default function ToolInvocationsCard({
  invocations,
}: {
  invocations: ToolInvocation[];
}) {
  if (!invocations || invocations.length === 0) return null;
  return (
    <div className="mb-1 space-y-1">
      {invocations.map((inv, idx) => {
        const label = TOOL_LABEL[inv.name] || inv.name;
        const hits = inv.results || [];
        const isFetch = inv.name === "fetch_url";
        const summary = inv.pending
          ? `${label}中…${inv.query ? ` "${inv.query}"` : ""}`
          : inv.error
            ? `${label}失败${inv.query ? ` "${inv.query}"` : ""}`
            : isFetch
              ? `已读取 ${inv.fetched?.title || safeHost(inv.fetched?.url || "")}`
              : `已${label} ${hits.length} 个结果${inv.query ? ` "${inv.query}"` : ""}`;
        return (
          <details
            key={idx}
            className="text-xs opacity-80 select-none cursor-pointer rounded border border-base-content/15 bg-base-100/40 px-2 py-1"
          >
            <summary className="flex items-center gap-1 list-none [&::-webkit-details-marker]:hidden">
              <span>{isFetch ? "📄" : "🔎"}</span>
              <span className={inv.pending ? "animate-pulse" : ""}>{summary}</span>
              {!inv.pending && (hits.length > 0 || isFetch || inv.error) && (
                <span className="opacity-60">▾</span>
              )}
            </summary>
            {!inv.pending && hits.length > 0 && (
              <ol className="mt-1 space-y-1 pl-1">
                {hits.map((h, i) => (
                  <li key={i} className="leading-snug">
                    <a
                      href={h.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="link link-hover font-medium break-all"
                    >
                      {h.title || h.url}
                    </a>
                    <span className="ml-1 opacity-50">{safeHost(h.url)}</span>
                    {h.snippet && (
                      <div className="opacity-70 line-clamp-2">{h.snippet}</div>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {!inv.pending && isFetch && inv.fetched?.url && (
              <div className="mt-1 pl-1 leading-snug">
                <a
                  href={inv.fetched.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link link-hover break-all"
                >
                  {inv.fetched.title || inv.fetched.url}
                </a>
                <span className="ml-1 opacity-50">{safeHost(inv.fetched.url)}</span>
              </div>
            )}
            {inv.error && (
              <div className="mt-1 pl-1 text-error/80 break-all">
                错误：{inv.error}
              </div>
            )}
          </details>
        );
      })}
    </div>
  );
}
