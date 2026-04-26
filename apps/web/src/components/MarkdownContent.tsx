import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Render chat-bubble markdown. Sized for the chat-bubble context — headings
 *  shrunk so they don't blow up the line height, tables compacted, code
 *  styled inline, links open in a new tab. Streaming-safe: react-markdown
 *  re-parses partial syntax (unclosed bold, half table) as raw text until
 *  the rest arrives.
 *
 *  Wrapped in React.memo so we only re-parse when `children` (the markdown
 *  source) actually changes. With 1000+ chat bubbles each holding a
 *  MarkdownContent, an unmemoed parent (e.g. ChatPanel re-rendering on
 *  every keystroke) would re-parse every bubble's markdown N times — the
 *  primary cause of the input-lag-with-history symptom. */
function MarkdownContentInner({ children }: { children: string }) {
  if (!children) return null;
  return (
    // `break-words` + the explicit anywhere wrap on <a>/<code> below
    // keep raw URLs and long tokens from blowing past the chat-bubble
    // width — common in agent replies that cite long search-result URLs.
    <div className="markdown-body text-sm leading-relaxed break-words [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Allow our custom "msg:<id>" scheme through the URL sanitizer
        // (default react-markdown only passes http/https/mailto/tel/...
        // and rewrites everything else to "javascript:void(0)" — that's
        // why agent citations were rendering but the click did nothing).
        // We still pass other URLs through the default safety check by
        // returning them unchanged; only msg: gets the bypass.
        urlTransform={(value) =>
          typeof value === "string" && value.startsWith("msg:") ? value : defaultUrlTransform(value)
        }
        components={{
          h1: ({ children, ...p }) => (
            <h3 className="font-bold text-base mt-2 mb-1" {...p}>
              {children}
            </h3>
          ),
          h2: ({ children, ...p }) => (
            <h4 className="font-bold text-sm mt-2 mb-1" {...p}>
              {children}
            </h4>
          ),
          h3: ({ children, ...p }) => (
            <h5 className="font-semibold text-sm mt-2 mb-1" {...p}>
              {children}
            </h5>
          ),
          h4: ({ children, ...p }) => (
            <h6 className="font-semibold text-sm mt-1.5 mb-0.5" {...p}>
              {children}
            </h6>
          ),
          p: ({ children, ...p }) => (
            <p className="my-1 whitespace-pre-wrap" {...p}>
              {children}
            </p>
          ),
          ul: ({ children, ...p }) => (
            <ul className="list-disc pl-5 my-1 space-y-0.5" {...p}>
              {children}
            </ul>
          ),
          ol: ({ children, ...p }) => (
            <ol className="list-decimal pl-5 my-1 space-y-0.5" {...p}>
              {children}
            </ol>
          ),
          li: ({ children, ...p }) => (
            <li className="my-0" {...p}>
              {children}
            </li>
          ),
          a: ({ children, href, ...p }) => {
            // Special "msg:<id>" href — agent's way of citing an earlier
            // message in the room. Render as a clickable chip that
            // scrolls + briefly highlights the target row instead of a
            // plain link. Self-contained so MarkdownContent stays
            // memo-safe (no callbacks passed in).
            if (href?.startsWith("msg:")) {
              const targetId = href.slice(4);
              return (
                <button
                  type="button"
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 mx-0.5 rounded bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 transition-colors text-xs align-baseline"
                  onClick={(e) => {
                    e.preventDefault();
                    const el = document.getElementById(`msg-${targetId}`);
                    if (!el) return;
                    el.scrollIntoView({ behavior: "smooth", block: "center" });
                    el.classList.add("ring-2", "ring-primary/60");
                    setTimeout(
                      () => el.classList.remove("ring-2", "ring-primary/60"),
                      1200
                    );
                  }}
                >
                  <span aria-hidden>↗</span>
                  <span>{children}</span>
                </button>
              );
            }
            return (
              <a
                className="link link-primary break-all"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                {...p}
              >
                {children}
              </a>
            );
          },
          code: ({ children, className, ...p }) => {
            const isBlock = /language-/.test(className || "");
            if (isBlock) {
              return (
                <code className={`${className} text-xs`} {...p}>
                  {children}
                </code>
              );
            }
            return (
              <code className="px-1 py-0.5 rounded bg-base-content/10 text-xs break-all" {...p}>
                {children}
              </code>
            );
          },
          pre: ({ children, ...p }) => (
            <pre
              className="my-1.5 p-2 rounded bg-base-content/10 overflow-x-auto text-xs"
              {...p}
            >
              {children}
            </pre>
          ),
          blockquote: ({ children, ...p }) => (
            <blockquote
              className="my-1 pl-2 border-l-2 border-base-content/30 opacity-80"
              {...p}
            >
              {children}
            </blockquote>
          ),
          table: ({ children, ...p }) => (
            <div className="my-1.5 overflow-x-auto">
              <table className="text-xs border-collapse" {...p}>
                {children}
              </table>
            </div>
          ),
          thead: ({ children, ...p }) => (
            <thead className="bg-base-content/5" {...p}>
              {children}
            </thead>
          ),
          th: ({ children, ...p }) => (
            <th
              className="px-2 py-1 border border-base-content/20 font-semibold text-left"
              {...p}
            >
              {children}
            </th>
          ),
          td: ({ children, ...p }) => (
            <td
              className="px-2 py-1 border border-base-content/20 align-top"
              {...p}
            >
              {children}
            </td>
          ),
          hr: ({ ...p }) => (
            <hr className="my-2 border-base-content/20" {...p} />
          ),
          strong: ({ children, ...p }) => (
            <strong className="font-semibold" {...p}>
              {children}
            </strong>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

const MarkdownContent = memo(MarkdownContentInner);
export default MarkdownContent;
