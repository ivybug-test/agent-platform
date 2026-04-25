"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";

type Category =
  | "identity"
  | "preference"
  | "relationship"
  | "event"
  | "opinion"
  | "context";
type Importance = "high" | "medium" | "low";
type Source = "extracted" | "user_explicit";

interface Memory {
  id: string;
  content: string;
  category: Category;
  importance: Importance;
  source: Source;
  createdAt: string;
  updatedAt: string;
  lastReinforcedAt: string | null;
  authoredByUserId: string | null;
  confirmedAt: string | null;
  authoredByName?: string | null;
}

type Tab = "mine" | "pending" | "relationships";

type RelationshipKind = "spouse" | "family" | "colleague" | "friend" | "custom";

interface RelationshipRow {
  id: string;
  kind: RelationshipKind;
  content: string | null;
  createdAt: string;
  other: { id: string; name: string; email: string };
}

interface FriendRow {
  id: string;
  status: string;
  direction: "mutual" | "incoming" | "outgoing";
  friend: { id: string; name: string; email: string };
}

interface FriendOption {
  id: string;
  name: string;
}

const RECENT_LIMIT = 8;

const KIND_LABELS: Record<RelationshipKind, string> = {
  spouse: "伴侣",
  family: "家人",
  colleague: "同事",
  friend: "朋友",
  custom: "其他",
};

const CATEGORY_ORDER: Category[] = [
  "identity",
  "preference",
  "relationship",
  "event",
  "opinion",
  "context",
];

const CATEGORY_LABELS: Record<Category, string> = {
  identity: "身份",
  preference: "偏好",
  relationship: "人际",
  event: "事件",
  opinion: "观点",
  context: "近况",
};

const IMPORTANCE_LABELS: Record<Importance, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

const IMPORTANCE_COLORS: Record<Importance, string> = {
  high: "badge-error",
  medium: "badge-warning",
  low: "badge-ghost",
};

/** Compact relative timestamp for memory list rows. Within a day shows
 *  HH:mm, within a week shows weekday + HH:mm, else MM-DD. */
function fmtMemoryTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = Date.now();
  const ms = d.getTime();
  const diffH = (now - ms) / 3600000;
  const sh = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = sh.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  if (diffH < 24) return `${get("hour")}:${get("minute")}`;
  if (diffH < 24 * 7) return `${get("weekday")} ${get("hour")}:${get("minute")}`;
  return `${get("month")}-${get("day")}`;
}

export default function MemoriesPage() {
  const { status } = useSession();
  const router = useRouter();

  const [mine, setMine] = useState<Memory[]>([]);
  const [pending, setPending] = useState<Memory[]>([]);
  const [confirmedRels, setConfirmedRels] = useState<RelationshipRow[]>([]);
  const [pendingRels, setPendingRels] = useState<RelationshipRow[]>([]);
  const [outgoingRels, setOutgoingRels] = useState<RelationshipRow[]>([]);
  const [friendList, setFriendList] = useState<FriendRow[]>([]);
  const [tab, setTab] = useState<Tab>("mine");
  const [relAddOpen, setRelAddOpen] = useState(false);
  const [relFriendId, setRelFriendId] = useState("");
  const [relKind, setRelKind] = useState<RelationshipKind>("friend");
  const [relContent, setRelContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Memory>>({});
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState<Category>("preference");
  const [newImportance, setNewImportance] = useState<Importance>("medium");
  // "self" → write to self; otherwise, a friend's userId (writes land
  // pending in their /memories tab until they accept).
  const [newSubject, setNewSubject] = useState<"self" | string>("self");
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // _ retained for legacy edit handlers — no longer used in the new UI.
  // Search box on the "mine" tab. Empty → recent + collapsed all sections.
  // Non-empty → flat filtered results (case-insensitive substring on
  // content, server-side via ?q=).
  const [query, setQuery] = useState("");
  // Friends from /api/memories — used to populate the new-memory subject
  // selector. Cheaper than refetching /api/friends here too.
  const [friendOpts, setFriendOpts] = useState<FriendOption[]>([]);
  const [allOpen, setAllOpen] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  const load = async (opts: { q?: string } = {}) => {
    setLoading(true);
    try {
      const memUrl = opts.q ? `/api/memories?q=${encodeURIComponent(opts.q)}` : "/api/memories";
      const [memRes, relRes, friRes] = await Promise.all([
        fetch(memUrl),
        fetch("/api/relationships"),
        fetch("/api/friends"),
      ]);
      if (memRes.ok) {
        const data = await memRes.json();
        setMine(data.mine || []);
        setPending(data.pending || []);
        setFriendOpts(data.friends || []);
      }
      if (relRes.ok) {
        const data = await relRes.json();
        setConfirmedRels(data.confirmed || []);
        setPendingRels(data.pending || []);
        setOutgoingRels(data.outgoing || []);
      }
      if (friRes.ok) {
        const raw: FriendRow[] = await friRes.json();
        setFriendList(raw.filter((f) => f.direction === "mutual"));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (status === "authenticated") load();
  }, [status]);

  // Debounce query → server-side ?q= refetch. Local filter would be
  // simpler but burns through the user's whole memory list each
  // keystroke; server-side ILIKE is fine for the volumes we handle.
  useEffect(() => {
    if (status !== "authenticated") return;
    const t = setTimeout(() => {
      load({ q: query.trim() });
    }, 200);
    return () => clearTimeout(t);
  }, [query, status]);

  const startEdit = (m: Memory) => {
    setEditingId(m.id);
    setDraft({
      content: m.content,
      category: m.category,
      importance: m.importance,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft({});
  };

  const saveEdit = async (id: string) => {
    if (!draft.content?.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/memories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (res.ok) {
        const updated: Memory = await res.json();
        setMine((prev) => prev.map((m) => (m.id === id ? updated : m)));
        cancelEdit();
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("遗忘这条记忆?后台抽取器将被告知不要重新创建。"))
      return;
    const res = await fetch(`/api/memories/${id}`, { method: "DELETE" });
    if (res.ok) setMine((prev) => prev.filter((m) => m.id !== id));
  };

  const accept = async (id: string) => {
    const res = await fetch(`/api/memories/${id}/confirm`, { method: "POST" });
    if (res.ok) {
      const confirmed: Memory = await res.json();
      setPending((prev) => prev.filter((m) => m.id !== id));
      setMine((prev) => [confirmed, ...prev]);
    }
  };

  const reject = async (id: string) => {
    if (!confirm("拒绝这条待确认记忆?将被软删除且不会被重新创建。")) return;
    const res = await fetch(`/api/memories/${id}`, { method: "DELETE" });
    if (res.ok) setPending((prev) => prev.filter((m) => m.id !== id));
  };

  const create = async () => {
    if (!newContent.trim() || saving) return;
    setSaving(true);
    try {
      const isThirdParty = newSubject !== "self";
      const res = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: newContent.trim(),
          category: newCategory,
          importance: newImportance,
          subjectUserId: isThirdParty ? newSubject : undefined,
        }),
      });
      if (res.ok) {
        const created = (await res.json()) as Memory & { pending?: boolean };
        // Third-party writes land in the SUBJECT's pending list — they
        // don't show up in the author's own lists at all. Just clear the
        // form and show a brief confirmation by re-loading.
        if (created.pending) {
          const friend = friendOpts.find((f) => f.id === newSubject);
          alert(
            `已发送给 ${friend?.name || "对方"}，他/她在 /memories 的"待确认"里能看到。`
          );
        } else {
          setMine((prev) => [created, ...prev]);
        }
        setNewContent("");
        setNewSubject("self");
        setAddOpen(false);
      }
    } finally {
      setSaving(false);
    }
  };

  // Relationships actions
  const proposeRelationship = async () => {
    if (!relFriendId) return;
    setSaving(true);
    try {
      const res = await fetch("/api/relationships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          otherUserId: relFriendId,
          kind: relKind,
          content: relContent.trim() || undefined,
        }),
      });
      if (res.ok) {
        setRelFriendId("");
        setRelContent("");
        setRelAddOpen(false);
        load();
      }
    } finally {
      setSaving(false);
    }
  };

  const acceptRel = async (id: string) => {
    const res = await fetch(`/api/relationships/${id}/confirm`, {
      method: "POST",
    });
    if (res.ok) {
      const row = pendingRels.find((r) => r.id === id);
      setPendingRels((prev) => prev.filter((r) => r.id !== id));
      if (row) setConfirmedRels((prev) => [{ ...row }, ...prev]);
    }
  };

  const removeRel = async (id: string) => {
    if (!confirm("删除这条关系?")) return;
    const res = await fetch(`/api/relationships/${id}`, { method: "DELETE" });
    if (res.ok) {
      setConfirmedRels((p) => p.filter((r) => r.id !== id));
      setPendingRels((p) => p.filter((r) => r.id !== id));
      setOutgoingRels((p) => p.filter((r) => r.id !== id));
    }
  };

  // mine is already updatedAt-DESC sorted by the API. recent = top N.
  // byCategory groups for the expandable "全部" section.
  const recent = mine.slice(0, RECENT_LIMIT);
  const byCategory = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    items: mine.filter((m) => m.category === cat),
  })).filter((g) => g.items.length > 0);
  const isSearching = query.trim().length > 0;

  if (status === "loading" || loading) {
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

  return (
    <main
      className="flex flex-col bg-base-100 text-base-content overflow-hidden"
      style={{ height: "100dvh" }}
      data-theme="dark"
    >
      {/* Sticky header — always visible */}
      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-2 border-b border-base-300 bg-base-100">
        <Link href="/" className="btn btn-ghost btn-sm btn-square" aria-label="返回">
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
        <h1 className="text-sm font-semibold flex-1 truncate">
          我的记忆
          <span className="text-base-content/40 font-normal ml-2">
            {tab === "mine" ? mine.length : pending.length}
          </span>
        </h1>
        {tab === "mine" && (
          <button
            className={`btn btn-sm ${addOpen ? "btn-ghost" : "btn-primary"}`}
            onClick={() => setAddOpen((v) => !v)}
          >
            {addOpen ? "取消" : "+ 新增"}
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 px-3 pt-2 bg-base-100 border-b border-base-300">
        <button
          className={`px-3 py-1.5 text-xs rounded-t-md border-b-2 ${
            tab === "mine"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-base-content/60"
          }`}
          onClick={() => setTab("mine")}
        >
          我的记忆
        </button>
        <button
          className={`px-3 py-1.5 text-xs rounded-t-md border-b-2 flex items-center gap-1 ${
            tab === "pending"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-base-content/60"
          }`}
          onClick={() => setTab("pending")}
        >
          待确认
          {pending.length > 0 && (
            <span className="badge badge-primary badge-xs">
              {pending.length}
            </span>
          )}
        </button>
        <button
          className={`px-3 py-1.5 text-xs rounded-t-md border-b-2 flex items-center gap-1 ${
            tab === "relationships"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-base-content/60"
          }`}
          onClick={() => setTab("relationships")}
        >
          关系
          {pendingRels.length > 0 && (
            <span className="badge badge-primary badge-xs">
              {pendingRels.length}
            </span>
          )}
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-3 py-3 md:px-4">
        {/* Pending tab: simple list of third-party-authored rows awaiting confirmation */}
        {tab === "pending" && (
          pending.length === 0 ? (
            <div className="text-center text-sm text-base-content/40 py-16">
              没有待确认的记忆。其他成员对你写入的事实会出现在这里。
            </div>
          ) : (
            <ul className="space-y-2">
              {pending.map((m) => (
                <li key={m.id} className="card bg-base-200 px-3 py-2.5">
                  <div className="text-sm break-words leading-relaxed">
                    {m.content}
                  </div>
                  <div className="flex items-center flex-wrap gap-1 mt-1.5">
                    <span className="badge badge-xs badge-ghost">
                      {CATEGORY_LABELS[m.category]}
                    </span>
                    <span
                      className={`badge badge-xs ${IMPORTANCE_COLORS[m.importance]}`}
                    >
                      {IMPORTANCE_LABELS[m.importance]}
                    </span>
                    <span className="text-[11px] text-base-content/50 ml-1">
                      来自 {m.authoredByName || "其他用户"}
                    </span>
                    <div className="ml-auto flex gap-0.5">
                      <button
                        className="btn btn-primary btn-xs h-6 min-h-0 px-2"
                        onClick={() => accept(m.id)}
                      >
                        接受
                      </button>
                      <button
                        className="btn btn-ghost btn-xs h-6 min-h-0 px-2 text-error"
                        onClick={() => reject(m.id)}
                      >
                        拒绝
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )
        )}

        {/* Relationships tab */}
        {tab === "relationships" && (
          <div className="space-y-5">
            {/* Add relationship */}
            <div className="card bg-base-200 p-3 space-y-2">
              <button
                className="btn btn-primary btn-sm w-full"
                onClick={() => setRelAddOpen((v) => !v)}
              >
                {relAddOpen ? "取消" : "+ 新增关系"}
              </button>
              {relAddOpen && (
                friendList.length === 0 ? (
                  <div className="text-xs text-base-content/50">
                    先在"好友"里添加对方为好友,然后才能建立关系。
                  </div>
                ) : (
                  <div className="space-y-2 pt-1">
                    <select
                      className="select select-bordered select-sm w-full"
                      value={relFriendId}
                      onChange={(e) => setRelFriendId(e.target.value)}
                    >
                      <option value="">选择好友...</option>
                      {friendList.map((f) => (
                        <option key={f.friend.id} value={f.friend.id}>
                          {f.friend.name}
                        </option>
                      ))}
                    </select>
                    <select
                      className="select select-bordered select-sm w-full"
                      value={relKind}
                      onChange={(e) =>
                        setRelKind(e.target.value as RelationshipKind)
                      }
                    >
                      {(Object.keys(KIND_LABELS) as RelationshipKind[]).map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input input-bordered input-sm w-full"
                      placeholder="附加说明(可选)例如:认识 10 年"
                      value={relContent}
                      onChange={(e) => setRelContent(e.target.value)}
                    />
                    <button
                      className="btn btn-primary btn-sm w-full"
                      disabled={saving || !relFriendId}
                      onClick={proposeRelationship}
                    >
                      提议建立
                    </button>
                  </div>
                )
              )}
            </div>

            {/* Pending (incoming) */}
            {pendingRels.length > 0 && (
              <section>
                <h2 className="text-xs font-bold text-base-content/60 mb-2 px-1">
                  待确认({pendingRels.length})
                </h2>
                <ul className="space-y-2">
                  {pendingRels.map((r) => (
                    <li
                      key={r.id}
                      className="card bg-base-200 px-3 py-2.5"
                    >
                      <div className="text-sm">
                        <span className="font-medium">{r.other.name}</span>
                        <span className="text-base-content/60"> 提议是你的 </span>
                        <span className="badge badge-xs badge-ghost">
                          {KIND_LABELS[r.kind]}
                        </span>
                      </div>
                      {r.content && (
                        <div className="text-xs text-base-content/60 mt-0.5">
                          {r.content}
                        </div>
                      )}
                      <div className="flex gap-1 justify-end mt-1.5">
                        <button
                          className="btn btn-primary btn-xs h-6 min-h-0 px-2"
                          onClick={() => acceptRel(r.id)}
                        >
                          接受
                        </button>
                        <button
                          className="btn btn-ghost btn-xs h-6 min-h-0 px-2 text-error"
                          onClick={() => removeRel(r.id)}
                        >
                          拒绝
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Confirmed */}
            <section>
              <h2 className="text-xs font-bold text-base-content/60 mb-2 px-1">
                已确认({confirmedRels.length})
              </h2>
              {confirmedRels.length === 0 ? (
                <div className="text-center text-sm text-base-content/40 py-6">
                  还没有已确认的关系。
                </div>
              ) : (
                <ul className="space-y-2">
                  {confirmedRels.map((r) => (
                    <li
                      key={r.id}
                      className="card bg-base-200 px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{r.other.name}</span>
                        <span className="badge badge-xs badge-info">
                          {KIND_LABELS[r.kind]}
                        </span>
                        <button
                          className="btn btn-ghost btn-xs h-6 min-h-0 px-2 text-error ml-auto"
                          onClick={() => removeRel(r.id)}
                        >
                          解除
                        </button>
                      </div>
                      {r.content && (
                        <div className="text-xs text-base-content/60 mt-0.5">
                          {r.content}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Outgoing (waiting for other) */}
            {outgoingRels.length > 0 && (
              <section>
                <h2 className="text-xs font-bold text-base-content/60 mb-2 px-1">
                  已发出,等待对方确认({outgoingRels.length})
                </h2>
                <ul className="space-y-2">
                  {outgoingRels.map((r) => (
                    <li
                      key={r.id}
                      className="card bg-base-200 px-3 py-2.5 opacity-70"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{r.other.name}</span>
                        <span className="badge badge-xs badge-ghost">
                          {KIND_LABELS[r.kind]}
                        </span>
                        <button
                          className="btn btn-ghost btn-xs h-6 min-h-0 px-2 text-error ml-auto"
                          onClick={() => removeRel(r.id)}
                        >
                          撤回
                        </button>
                      </div>
                      {r.content && (
                        <div className="text-xs text-base-content/60 mt-0.5">
                          {r.content}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {/* Mine tab */}
        {tab === "mine" && (<>
        {/* New-memory form */}
        {addOpen && (
          <div className="card bg-base-200 p-3 mb-4 space-y-2">
            <textarea
              className="textarea textarea-bordered w-full text-sm"
              placeholder="例如:住在深圳,是后端工程师。"
              rows={2}
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              autoFocus
            />
            <div className="flex flex-wrap gap-2 items-center">
              {/* Subject selector — defaults to self; pick a friend to
                  send a pending memory to them. */}
              <select
                className="select select-bordered select-sm"
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                title="记给谁"
              >
                <option value="self">关于我</option>
                {friendOpts.map((f) => (
                  <option key={f.id} value={f.id}>
                    关于 {f.name}（待对方确认）
                  </option>
                ))}
              </select>
              <select
                className="select select-bordered select-sm"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value as Category)}
              >
                {CATEGORY_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
              <select
                className="select select-bordered select-sm"
                value={newImportance}
                onChange={(e) => setNewImportance(e.target.value as Importance)}
              >
                <option value="high">高</option>
                <option value="medium">中</option>
                <option value="low">低</option>
              </select>
              <button
                className="btn btn-primary btn-sm ml-auto"
                onClick={create}
                disabled={saving || !newContent.trim()}
              >
                {newSubject === "self" ? "保存" : "发送"}
              </button>
            </div>
            {newSubject !== "self" && (
              <div className="text-[11px] text-base-content/50">
                这条会进入对方的"待确认"列表，需要他们接受后才生效。
              </div>
            )}
          </div>
        )}

        {/* Search box */}
        <div className="relative mb-3">
          <input
            className="input input-bordered input-sm w-full pr-8 text-sm"
            placeholder="搜索记忆..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-base-content/40 hover:text-base-content text-sm"
              aria-label="清空"
            >
              ×
            </button>
          )}
        </div>

        {mine.length === 0 && !isSearching && (
          <div className="text-center text-sm text-base-content/40 py-16">
            还没有记忆。点击右上角"+ 新增"手动添加，或在聊天中让 agent 记录。
          </div>
        )}

        {mine.length === 0 && isSearching && (
          <div className="text-center text-sm text-base-content/40 py-16">
            没有匹配"{query}"的记忆。
          </div>
        )}

        {/* Search results — flat list */}
        {isSearching && mine.length > 0 && (
          <div>
            <h2 className="text-xs font-bold text-base-content/60 mb-2 px-1">
              搜索结果（{mine.length}）
            </h2>
            <ul className="space-y-1.5">
              {mine.map((m) => (
                <MineRow
                  key={m.id}
                  m={m}
                  isEditing={editingId === m.id}
                  draft={draft}
                  setDraft={setDraft}
                  saving={saving}
                  startEdit={startEdit}
                  cancelEdit={cancelEdit}
                  saveEdit={saveEdit}
                  remove={remove}
                />
              ))}
            </ul>
          </div>
        )}

        {/* Default view: recent + collapsed all-by-category */}
        {!isSearching && mine.length > 0 && (
          <>
            <section className="mb-4">
              <h2 className="text-xs font-bold text-base-content/60 mb-2 px-1">
                最近（{recent.length}）
              </h2>
              <ul className="space-y-1.5">
                {recent.map((m) => (
                  <MineRow
                    key={m.id}
                    m={m}
                    isEditing={editingId === m.id}
                    draft={draft}
                    setDraft={setDraft}
                    saving={saving}
                    startEdit={startEdit}
                    cancelEdit={cancelEdit}
                    saveEdit={saveEdit}
                    remove={remove}
                  />
                ))}
              </ul>
            </section>

            {mine.length > RECENT_LIMIT && (
              <section>
                <button
                  type="button"
                  onClick={() => setAllOpen((v) => !v)}
                  className="w-full flex items-center gap-2 px-2 py-2 text-xs font-bold text-base-content/60 hover:text-base-content transition-colors border-t border-base-300"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    strokeWidth={2.2}
                    stroke="currentColor"
                    className={`w-3 h-3 transition-transform ${allOpen ? "rotate-90" : ""}`}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
                  </svg>
                  <span>全部 {mine.length} 条（按分类）</span>
                </button>
                {allOpen && (
                  <div className="mt-2 space-y-3">
                    {byCategory.map(({ category, items }) => (
                      <section key={category}>
                        <h3 className="text-[11px] uppercase tracking-wider text-base-content/40 mb-1 px-1">
                          {CATEGORY_LABELS[category]}（{items.length}）
                        </h3>
                        <ul className="space-y-1.5">
                          {items.map((m) => (
                            <MineRow
                              key={m.id}
                              m={m}
                              isEditing={editingId === m.id}
                              draft={draft}
                              setDraft={setDraft}
                              saving={saving}
                              startEdit={startEdit}
                              cancelEdit={cancelEdit}
                              saveEdit={saveEdit}
                              remove={remove}
                            />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
        </>)}
      </div>
    </main>
  );
}

/** Single row in the mine list. Inline-edit toggle, inline metadata
 *  (importance + locked badge + relative time), and edit/forget actions
 *  on the right. Extracted so the recent / search / by-category sections
 *  can share the same renderer without duplicating ~80 lines of JSX. */
function MineRow({
  m,
  isEditing,
  draft,
  setDraft,
  saving,
  startEdit,
  cancelEdit,
  saveEdit,
  remove,
}: {
  m: Memory;
  isEditing: boolean;
  draft: Partial<Memory>;
  setDraft: (fn: (d: Partial<Memory>) => Partial<Memory>) => void;
  saving: boolean;
  startEdit: (m: Memory) => void;
  cancelEdit: () => void;
  saveEdit: (id: string) => void;
  remove: (id: string) => void;
}) {
  if (isEditing) {
    return (
      <li className="card bg-base-200 px-3 py-2.5">
        <div className="space-y-2">
          <textarea
            className="textarea textarea-bordered w-full text-sm"
            rows={2}
            value={draft.content ?? ""}
            onChange={(e) =>
              setDraft((d) => ({ ...d, content: e.target.value }))
            }
            autoFocus
          />
          <div className="flex flex-wrap gap-1.5 items-center">
            <select
              className="select select-bordered select-xs"
              value={draft.category}
              onChange={(e) =>
                setDraft((d) => ({ ...d, category: e.target.value as Category }))
              }
            >
              {CATEGORY_ORDER.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
            <select
              className="select select-bordered select-xs"
              value={draft.importance}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  importance: e.target.value as Importance,
                }))
              }
            >
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
            <div className="ml-auto flex gap-1">
              <button
                className="btn btn-ghost btn-xs"
                onClick={cancelEdit}
                disabled={saving}
              >
                取消
              </button>
              <button
                className="btn btn-primary btn-xs"
                onClick={() => saveEdit(m.id)}
                disabled={saving || !draft.content?.trim()}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      </li>
    );
  }
  return (
    <li className="card bg-base-200 px-3 py-2.5">
      <div className="text-sm break-words leading-relaxed">{m.content}</div>
      <div className="flex items-center flex-wrap gap-1 mt-1.5">
        <span className="badge badge-xs badge-ghost">
          {CATEGORY_LABELS[m.category]}
        </span>
        <span
          className={`badge badge-xs ${IMPORTANCE_COLORS[m.importance]}`}
        >
          {IMPORTANCE_LABELS[m.importance]}
        </span>
        {m.source === "user_explicit" && (
          <span className="badge badge-xs badge-info">已锁定</span>
        )}
        <span
          className="text-[11px] text-base-content/40 ml-1"
          title={m.updatedAt}
        >
          {fmtMemoryTime(m.updatedAt)}
        </span>
        <div className="ml-auto flex gap-0.5">
          <button
            className="btn btn-ghost btn-xs h-6 min-h-0 px-2"
            onClick={() => startEdit(m)}
          >
            编辑
          </button>
          <button
            className="btn btn-ghost btn-xs h-6 min-h-0 px-2 text-error"
            onClick={() => remove(m.id)}
          >
            遗忘
          </button>
        </div>
      </div>
    </li>
  );
}
