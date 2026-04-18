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
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<Category>>(new Set());

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  const load = async () => {
    setLoading(true);
    try {
      const [memRes, relRes, friRes] = await Promise.all([
        fetch("/api/memories"),
        fetch("/api/relationships"),
        fetch("/api/friends"),
      ]);
      if (memRes.ok) {
        const data = await memRes.json();
        setMine(data.mine || []);
        setPending(data.pending || []);
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
      const res = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: newContent.trim(),
          category: newCategory,
          importance: newImportance,
        }),
      });
      if (res.ok) {
        const created: Memory = await res.json();
        setMine((prev) => [created, ...prev]);
        setNewContent("");
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

  const toggleCategory = (cat: Category) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    items: mine.filter((m) => m.category === cat),
  })).filter((g) => g.items.length > 0);

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

        {/* Mine tab — existing UI */}
        {tab === "mine" && (<>
        {/* Add form (collapsible) */}
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
                保存
              </button>
            </div>
          </div>
        )}

        {grouped.length === 0 && (
          <div className="text-center text-sm text-base-content/40 py-16">
            还没有记忆。点击右上角“+ 新增”手动添加,或在聊天中让 agent 记录。
          </div>
        )}

        {grouped.map(({ category, items }) => {
          const isCollapsed = collapsed.has(category);
          return (
            <section key={category} className="mb-3">
              <button
                type="button"
                onClick={() => toggleCategory(category)}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-base-content/60 hover:text-base-content transition-colors"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  strokeWidth={2.2}
                  stroke="currentColor"
                  className={`w-3 h-3 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
                </svg>
                <span>{CATEGORY_LABELS[category]}</span>
                <span className="text-base-content/40 font-normal normal-case ml-1">
                  {items.length}
                </span>
              </button>
              {!isCollapsed && (
                <ul className="space-y-1.5 mt-1">
                  {items.map((m) => (
                    <li key={m.id} className="card bg-base-200 px-3 py-2.5">
                      {editingId === m.id ? (
                        <div className="space-y-2">
                          <textarea
                            className="textarea textarea-bordered w-full text-sm"
                            rows={2}
                            value={draft.content ?? ""}
                            onChange={(e) =>
                              setDraft((d) => ({
                                ...d,
                                content: e.target.value,
                              }))
                            }
                            autoFocus
                          />
                          <div className="flex flex-wrap gap-1.5 items-center">
                            <select
                              className="select select-bordered select-xs"
                              value={draft.category}
                              onChange={(e) =>
                                setDraft((d) => ({
                                  ...d,
                                  category: e.target.value as Category,
                                }))
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
                      ) : (
                        <>
                          <div className="text-sm break-words leading-relaxed">
                            {m.content}
                          </div>
                          <div className="flex items-center flex-wrap gap-1 mt-1.5">
                            <span
                              className={`badge badge-xs ${IMPORTANCE_COLORS[m.importance]}`}
                            >
                              {IMPORTANCE_LABELS[m.importance]}
                            </span>
                            {m.source === "user_explicit" && (
                              <span className="badge badge-xs badge-info">
                                已锁定
                              </span>
                            )}
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
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        </>)}
      </div>
    </main>
  );
}
