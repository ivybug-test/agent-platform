"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import FriendsPanel from "@/components/FriendsPanel";
import { RECENT_COMMITS } from "@/lib/build-info.generated";
import {
  play as playTts,
  stopAll as stopAllTts,
} from "@/lib/audio/streaming-player";

interface UpdatesResp {
  commits: { sha: string; subject: string; date: string }[];
  summary?: string;
  expired?: boolean;
}

interface AgentRow {
  id: string;
  name: string;
  voiceProvider: string | null;
  voiceId: string | null;
  voiceName: string | null;
}

interface VoiceOption {
  id: string;
  name: string;
  provider: string;
  gender?: "male" | "female" | "neutral";
}

const VOICE_PREVIEW_TEXT = "你好，我是你的语音助手。这是一段试听样本。";

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

  // Voice picker state — list of agents I share a room with (typically
  // just one in this single-agent product), plus preset voices from the
  // active TTS provider, plus which voice is currently previewing.
  const [agentList, setAgentList] = useState<AgentRow[]>([]);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voiceProviderName, setVoiceProviderName] = useState<string>("");
  const [voiceSavingId, setVoiceSavingId] = useState<string | null>(null);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);

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
    (async () => {
      const r = await fetch("/api/agents");
      if (r.ok) {
        const d = await r.json();
        setAgentList(d.agents || []);
      }
    })();
    (async () => {
      const r = await fetch("/api/tts/voices");
      if (r.ok) {
        const d = await r.json();
        setVoices(d.voices || []);
        setVoiceProviderName(d.provider || "");
      }
    })();
  }, [status, showFriends]);

  // Stop preview audio when navigating away from /me.
  useEffect(() => {
    return () => stopAllTts();
  }, []);

  const selectVoice = async (agentId: string, voice: VoiceOption) => {
    setVoiceSavingId(agentId);
    try {
      const res = await fetch(`/api/agents/${agentId}/voice`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceProvider: voice.provider,
          voiceId: voice.id,
          voiceName: voice.name,
        }),
      });
      if (res.ok) {
        const updated = await res.json();
        setAgentList((prev) =>
          prev.map((a) =>
            a.id === agentId ? { ...a, ...updated } : a
          )
        );
      }
    } finally {
      setVoiceSavingId(null);
    }
  };

  const previewVoice = (voice: VoiceOption) => {
    // Re-clicking the same row stops the preview.
    if (previewingVoiceId === voice.id) {
      stopAllTts();
      setPreviewingVoiceId(null);
      return;
    }
    setPreviewingVoiceId(voice.id);
    playTts({
      body: {
        text: VOICE_PREVIEW_TEXT,
        voiceId: voice.id,
        voiceProvider: voice.provider,
      },
      onEnd: () => setPreviewingVoiceId(null),
      onError: () => setPreviewingVoiceId(null),
    });
  };

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

        {/* Voice picker. One card per agent the user shares a room
            with — usually just one, but the UI scales if more get added.
            Click a voice row to save (auto-PATCH); click ▶ to preview
            without saving; click the same ▶ again to stop. */}
        {agentList.map((agent) => (
          <section key={agent.id} className="card bg-base-200 px-4 py-3">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg" aria-hidden>
                🎙️
              </span>
              <div className="flex-1 text-sm font-medium">
                {agent.name} 的语音音色
              </div>
              <span className="text-[11px] opacity-50">
                当前：{agent.voiceName || "默认"}
              </span>
            </div>
            {voices.length === 0 ? (
              <div className="text-xs opacity-50 italic">
                语音服务（{voiceProviderName || "—"}）未配置或加载中…
              </div>
            ) : (
              <ul className="space-y-1">
                {voices.map((v) => {
                  const selected = agent.voiceId === v.id;
                  const previewing = previewingVoiceId === v.id;
                  const saving = voiceSavingId === agent.id && !selected;
                  return (
                    <li
                      key={v.id}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors cursor-pointer ${
                        selected
                          ? "bg-primary/15 border border-primary/40"
                          : "hover:bg-base-300/60 border border-transparent"
                      }`}
                      onClick={() => !selected && selectVoice(agent.id, v)}
                    >
                      <span
                        className={`w-3 h-3 rounded-full shrink-0 border-2 ${
                          selected
                            ? "bg-primary border-primary"
                            : "border-base-content/30"
                        }`}
                      />
                      <span className="flex-1 text-sm">{v.name}</span>
                      {saving && (
                        <span className="loading loading-spinner loading-xs" />
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          previewVoice(v);
                        }}
                        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs transition-colors ${
                          previewing
                            ? "bg-error text-error-content"
                            : "bg-base-300 hover:bg-base-content/20"
                        }`}
                        aria-label={previewing ? "停止试听" : "试听"}
                        title={previewing ? "停止试听" : "试听"}
                      >
                        {previewing ? "■" : "▶"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}

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
