import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Render chat-bubble markdown. Sized for the chat-bubble context — headings
 *  shrunk so they don't blow up the line height, tables compacted, code
 *  styled inline, links open in a new tab. Streaming-safe: react-markdown
 *  re-parses every render, partial syntax (unclosed bold, half table) just
 *  renders as raw text until the rest arrives. */
export default function MarkdownContent({ children }: { children: string }) {
  if (!children) return null;
  return (
    <div className="markdown-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
          a: ({ children, href, ...p }) => (
            <a
              className="link link-primary"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              {...p}
            >
              {children}
            </a>
          ),
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
              <code className="px-1 py-0.5 rounded bg-base-content/10 text-xs" {...p}>
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
