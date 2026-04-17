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
}

const CATEGORY_ORDER: Category[] = [
  "identity",
  "preference",
  "relationship",
  "event",
  "opinion",
  "context",
];

const CATEGORY_LABELS: Record<Category, string> = {
  identity: "Identity",
  preference: "Preferences",
  relationship: "Relationships",
  event: "Events",
  opinion: "Opinions",
  context: "Context",
};

const IMPORTANCE_COLORS: Record<Importance, string> = {
  high: "badge-error",
  medium: "badge-warning",
  low: "badge-ghost",
};

export default function MemoriesPage() {
  const { status } = useSession();
  const router = useRouter();

  const [memories, setMemories] = useState<Memory[]>([]);
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
      if (res.ok) setMemories(await res.json());
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
        setMemories((prev) => prev.map((m) => (m.id === id ? updated : m)));
        cancelEdit();
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Forget this memory? The agent will be told not to recreate it."))
      return;
    const res = await fetch(`/api/memories/${id}`, { method: "DELETE" });
    if (res.ok) setMemories((prev) => prev.filter((m) => m.id !== id));
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
        setMemories((prev) => [created, ...prev]);
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
    items: memories.filter((m) => m.category === cat),
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
        <Link href="/" className="btn btn-ghost btn-sm btn-square" aria-label="Back">
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
          My Memories
          <span className="text-base-content/40 font-normal ml-2">
            {memories.length}
          </span>
        </h1>
        <button
          className={`btn btn-sm ${addOpen ? "btn-ghost" : "btn-primary"}`}
          onClick={() => setAddOpen((v) => !v)}
        >
          {addOpen ? "Cancel" : "+ Add"}
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-3 py-3 md:px-4">
        {/* Add form (collapsible) */}
        {addOpen && (
          <div className="card bg-base-200 p-3 mb-4 space-y-2">
            <textarea
              className="textarea textarea-bordered w-full text-sm"
              placeholder="e.g. 我住在深圳,是后端工程师。"
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
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
              <button
                className="btn btn-primary btn-sm ml-auto"
                onClick={create}
                disabled={saving || !newContent.trim()}
              >
                Save
              </button>
            </div>
          </div>
        )}

        {grouped.length === 0 && (
          <div className="text-center text-sm text-base-content/40 py-16">
            No memories yet. Tap “+ Add” to create one, or chat with the agent.
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
                              <option value="high">high</option>
                              <option value="medium">medium</option>
                              <option value="low">low</option>
                            </select>
                            <div className="ml-auto flex gap-1">
                              <button
                                className="btn btn-ghost btn-xs"
                                onClick={cancelEdit}
                                disabled={saving}
                              >
                                Cancel
                              </button>
                              <button
                                className="btn btn-primary btn-xs"
                                onClick={() => saveEdit(m.id)}
                                disabled={saving || !draft.content?.trim()}
                              >
                                Save
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
                              {m.importance}
                            </span>
                            {m.source === "user_explicit" && (
                              <span className="badge badge-xs badge-info">
                                locked
                              </span>
                            )}
                            <div className="ml-auto flex gap-0.5">
                              <button
                                className="btn btn-ghost btn-xs h-6 min-h-0 px-2"
                                onClick={() => startEdit(m)}
                              >
                                Edit
                              </button>
                              <button
                                className="btn btn-ghost btn-xs h-6 min-h-0 px-2 text-error"
                                onClick={() => remove(m.id)}
                              >
                                Forget
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
      </div>
    </main>
  );
}
