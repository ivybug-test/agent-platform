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

type Tab = "mine" | "pending";

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
  const [tab, setTab] = useState<Tab>("mine");
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
      const res = await fetch("/api/memories");
      if (res.ok) {
        const data = await res.json();
        setMine(data.mine || []);
        setPending(data.pending || []);
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
