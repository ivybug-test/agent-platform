"use client";

import { useState, useEffect } from "react";
import { RECENT_COMMITS, type CommitInfo } from "@/lib/build-info.generated";

type Commit = CommitInfo;

interface UpdatesResp {
  commits: Commit[];
  summary?: string;
  expired?: boolean;
  fromCache?: boolean;
}

const BANNER_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // auto-hide after 3 days

const BAKED = RECENT_COMMITS;

function parseBullets(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .map((l) => l.replace(/^\s*[·•\-*]\s*/, "").trim())
    .filter(Boolean);
}

/**
 * Sits at the bottom of the sidebar (above the user bar). Shows an
 * LLM-generated Chinese summary of the latest deployment plus the current
 * version sha. Auto-hides when the newest commit is older than 3 days;
 * user can also collapse/expand in-session (state not persisted).
 */
export default function AnnouncementPanel() {
  const [data, setData] = useState<UpdatesResp | null>(null);
  const [expanded, setExpanded] = useState(true);

  const earlyHide =
    BAKED.length === 0 ||
    (() => {
      const t = new Date(BAKED[0].date).getTime();
      return !Number.isFinite(t) || Date.now() - t > BANNER_MAX_AGE_MS;
    })();

  useEffect(() => {
    if (earlyHide) return;
    fetch("/api/updates")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json) setData(json);
      })
      .catch(() => {});
  }, [earlyHide]);

  if (earlyHide) return null;
  if (!data || data.expired || !data.commits?.length) return null;

  const bullets = parseBullets(data.summary || "");
  const versionSha = data.commits[0].sha;

  return (
    <div className="border-t border-base-300 bg-base-100/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-base-300/40 transition-colors"
        aria-expanded={expanded}
      >
        <span className="text-xs font-semibold text-primary shrink-0">
          ✨ 最近更新
        </span>
        <code className="text-[10px] font-mono text-base-content/40 shrink-0">
          {versionSha}
        </code>
        <span className="flex-1" />
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          strokeWidth={2.2}
          stroke="currentColor"
          className={`w-3 h-3 shrink-0 text-base-content/40 transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 pb-3">
          {bullets.length > 0 ? (
            <ul className="space-y-1.5">
              {bullets.map((b, i) => (
                <li
                  key={i}
                  className="flex gap-2 text-[11px] leading-relaxed text-base-content/80"
                >
                  <span className="shrink-0 text-base-content/40 mt-[2px]">
                    ·
                  </span>
                  <span className="flex-1 break-words">{b}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[11px] opacity-60 italic">生成摘要中…</div>
          )}
        </div>
      )}
    </div>
  );
}
