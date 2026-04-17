"use client";

import { useEffect, useState } from "react";

const COMMIT = process.env.NEXT_PUBLIC_GIT_COMMIT || "";
const SUBJECT = process.env.NEXT_PUBLIC_GIT_SUBJECT || "";
const STORAGE_KEY = "lastSeenCommit";

/**
 * Shows a one-line banner after each deployment, dismissable. The current
 * commit sha is baked in at build time via next.config.ts. If the user's
 * localStorage doesn't match, we assume they haven't seen this version yet.
 */
export default function UpdateBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!COMMIT || !SUBJECT) return;
    try {
      const last = localStorage.getItem(STORAGE_KEY);
      // First-ever visit: silently record — don't pop a banner on a brand-new
      // user's first login (they have no stale version to worry about).
      if (!last) {
        localStorage.setItem(STORAGE_KEY, COMMIT);
        return;
      }
      if (last !== COMMIT) setShow(true);
    } catch {
      // ignore storage errors (SSR / private mode)
    }
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, COMMIT);
    } catch {}
    setShow(false);
  };

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[60] flex items-center gap-2 px-3 py-1.5 text-xs bg-primary text-primary-content shadow-md"
      role="status"
    >
      <span className="font-semibold whitespace-nowrap">✨ 新版本</span>
      <span className="flex-1 truncate">{SUBJECT}</span>
      <code className="opacity-60 hidden sm:inline">{COMMIT}</code>
      <button
        onClick={dismiss}
        className="btn btn-ghost btn-xs h-6 min-h-0 px-2 text-primary-content hover:bg-primary-content/10"
      >
        知道了
      </button>
    </div>
  );
}
