"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import FriendsPanel from "@/components/FriendsPanel";
import { RECENT_COMMITS } from "@/lib/build-info.generated";

interface UpdatesResp {
  commits: { sha: string; subject: string; date: string }[];
  summary?: string;
  expired?: boolean;
}

function parseBullets(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .map((l) => l.replace(/^\s*[·•\-*]\s*/, "").trim())
    .filter(Boolean);
}

/** "我的" page — consolidates the four bottom-of-sidebar entry points
 *  (memories / friends / invite / updates) into a single scroll page.
 *  Replaces the old cluttered button row in Sidebar. */
export default function MePage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [memCount, setMemCount] = useState<number | null>(null);
  const [friendCount, setFriendCount] = useState<number | null>(null);
  const [pendingFriends, setPendingFriends] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showFriends, setShowFriends] = useState(false);
  const [updates, setUpdates] = useState<UpdatesResp | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteResult, setInviteResult] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;
    (async () => {
      const r = await fetch("/api/memories");
      if (r.ok) {
        const d = await r.json();
        setMemCount((d.mine?.length || 0) + (d.pending?.length || 0));
      }
    })();
    (async () => {
      const r = await fetch("/api/friends");
      if (r.ok) {
        const list: { direction: string }[] = await r.json();
        setFriendCount(list.filter((f) => f.direction === "mutual").length);
        setPendingFriends(list.filter((f) => f.direction === "incoming").length);
      }
    })();
    (async () => {
      const r = await fetch("/api/invite");
      setIsAdmin(r.ok);
    })();
    (async () => {
      const r = await fetch("/api/updates");
      if (r.ok) setUpdates(await r.json());
    })();
  }, [status, showFriends]);

  const generateInvite = async () => {
    if (inviteBusy) return;
    setInviteBusy(true);
    setInviteResult(null);
    try {
      const res = await fetch("/api/invite", { method: "POST" });
      if (res.ok) {
        const { code } = await res.json();
        const url = `${window.location.origin}/register?code=${code}`;
        try {
          await navigator.clipboard.writeText(url);
        } catch {}
        setInviteResult(url);
      }
    } finally {
      setInviteBusy(false);
    }
  };

  const handleLogout = async () => {
    await signOut({ redirect: false });
    window.location.href = "/login";
  };

  if (status !== "authenticated") {
    return (
      <main
        className="flex items-center justify-center bg-base-100"
        style={{ height: "100dvh" }}
        data-theme="dark"
      >
        <span className="loading loading-spinner loading-lg"></span>
      </main>
    );
  }

  const bullets = updates?.summary ? parseBullets(updates.summary) : [];
  const versionSha =
    updates?.commits?.[0]?.sha || RECENT_COMMITS[0]?.sha || "—";

  return (
    <main
      className="flex flex-col bg-base-100 text-base-content overflow-hidden"
      style={{ height: "100dvh" }}
      data-theme="dark"
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-2 border-b border-base-300 bg-base-100">
        <Link
          href="/"
          className="btn btn-ghost btn-sm btn-square"
          aria-label="返回"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            strokeWidth={2}
            stroke="currentColor"
            className="w-4 h-4"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <h1 className="text-sm font-semibold flex-1 truncate">我的</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 md:px-4 space-y-3">
        {/* User identity card */}
        <section className="card bg-base-200 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 text-primary flex items-center justify-center text-base font-semibold shrink-0">
              {(session.user?.name || "?").slice(0, 1)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">
                {session.user?.name || "用户"}
              </div>
              <div className="text-xs opacity-60 truncate">
                {session.user?.email || ""}
              </div>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="btn btn-ghost btn-xs"
            >
              退出
            </button>
          </div>
        </section>

        {/* Entry: memories */}
        <RowLink
          href="/memories"
          icon="🧠"
          title="记忆"
          right={
            memCount === null ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <span className="text-sm opacity-60">{memCount} 条</span>
            )
          }
        />

        {/* Entry: friends — opens the existing FriendsPanel modal so we
            don't have to duplicate the friends UI yet. */}
        <RowButton
          icon="👥"
          title="好友"
          onClick={() => setShowFriends(true)}
          right={
            friendCount === null ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm opacity-60">{friendCount} 个</span>
                {pendingFriends > 0 && (
                  <span className="badge badge-primary badge-xs">
                    待确认 {pendingFriends}
                  </span>
                )}
              </div>
            )
          }
        />

        {/* Entry: invite (admin only). Inline action — generates a link
            and pops it into a copyable textarea so the admin can share
            without leaving the page. */}
        {isAdmin && (
          <section className="card bg-base-200 px-4 py-3 space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-lg" aria-hidden>
                ✉️
              </span>
              <div className="flex-1 text-sm font-medium">邀请好友</div>
              <button
                type="button"
                onClick={generateInvite}
                disabled={inviteBusy}
                className="btn btn-primary btn-sm"
              >
                {inviteBusy ? "生成中…" : "生成链接"}
              </button>
            </div>
            {inviteResult && (
              <div className="space-y-1">
                <div className="text-[11px] text-success">
                  ✓ 已复制到剪贴板
                </div>
                <input
                  className="input input-bordered input-sm w-full text-xs font-mono"
                  value={inviteResult}
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
            )}
          </section>
        )}

        {/* Entry: updates. Always expanded here (the old AnnouncementPanel
            in the sidebar was collapsible; on this dedicated page there's
            plenty of room). */}
        <section className="card bg-base-200 px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg" aria-hidden>
              ✨
            </span>
            <div className="flex-1 text-sm font-medium">最近更新</div>
            <code className="text-[10px] font-mono opacity-50">
              {versionSha}
            </code>
          </div>
          {bullets.length > 0 ? (
            <ul className="space-y-1.5">
              {bullets.map((b, i) => (
                <li
                  key={i}
                  className="flex gap-2 text-xs leading-relaxed text-base-content/80"
                >
                  <span className="shrink-0 text-base-content/40 mt-[2px]">
                    ·
                  </span>
                  <span className="flex-1 break-words">{b}</span>
                </li>
              ))}
            </ul>
          ) : updates ? (
            <ul className="space-y-1.5">
              {(updates.commits || RECENT_COMMITS).slice(0, 5).map((c) => (
                <li
                  key={c.sha}
                  className="flex gap-2 text-xs leading-relaxed text-base-content/70"
                >
                  <code className="shrink-0 text-base-content/40 font-mono">
                    {c.sha}
                  </code>
                  <span className="flex-1 break-words">{c.subject}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs opacity-60 italic">加载中…</div>
          )}
        </section>
      </div>

      {showFriends && <FriendsPanel onClose={() => setShowFriends(false)} />}
    </main>
  );
}

/** Consistent row card for entries that navigate to another route. */
function RowLink({
  href,
  icon,
  title,
  right,
}: {
  href: string;
  icon: string;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="card bg-base-200 px-4 py-3 flex flex-row items-center gap-3 hover:bg-base-300 transition-colors"
    >
      <span className="text-lg" aria-hidden>
        {icon}
      </span>
      <span className="flex-1 text-sm font-medium">{title}</span>
      {right}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        strokeWidth={2}
        stroke="currentColor"
        className="w-4 h-4 opacity-40"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
      </svg>
    </Link>
  );
}

/** Same shape as RowLink but for entries that open an inline panel
 *  instead of navigating. */
function RowButton({
  icon,
  title,
  onClick,
  right,
}: {
  icon: string;
  title: string;
  onClick: () => void;
  right?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full card bg-base-200 px-4 py-3 flex flex-row items-center gap-3 hover:bg-base-300 transition-colors text-left"
    >
      <span className="text-lg" aria-hidden>
        {icon}
      </span>
      <span className="flex-1 text-sm font-medium">{title}</span>
      {right}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        strokeWidth={2}
        stroke="currentColor"
        className="w-4 h-4 opacity-40"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}
