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
        setMemories((prev) =>
          prev.map((m) => (m.id === id ? updated : m))
        );
        cancelEdit();
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Forget this memory? The agent will be told not to recreate it.")) return;
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
      }
    } finally {
      setSaving(false);
    }
  };

  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    items: memories.filter((m) => m.category === cat),
  })).filter((g) => g.items.length > 0);

  if (status === "loading" || loading) {
    return (
      <main
        className="flex h-screen items-center justify-center"
        data-theme="dark"
      >
        <span className="loading loading-spinner loading-lg"></span>
      </main>
    );
  }

  return (
    <main
      className="min-h-screen bg-base-100 text-base-content"
      data-theme="dark"
    >
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold">My Memories</h1>
            <p className="text-xs text-base-content/50 mt-1">
              What the agent remembers about you. Edits and deletes are final
              — the background extractor will respect them.
            </p>
          </div>
          <Link href="/" className="btn btn-ghost btn-sm">
            ← Back
          </Link>
        </div>

        {/* New memory form */}
        <div className="card bg-base-200 p-4 mb-6 space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-base-content/50">
            Add a memory
          </div>
          <textarea
            className="textarea textarea-bordered w-full text-sm"
            placeholder="e.g. Lives in Shenzhen. Works as a backend engineer."
            rows={2}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
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
              Add
            </button>
          </div>
        </div>

        {grouped.length === 0 && (
          <div className="text-center text-sm text-base-content/40 py-10">
            No memories yet. Chat with the agent or add one above.
          </div>
        )}

        {grouped.map(({ category, items }) => (
          <section key={category} className="mb-6">
            <h2 className="text-xs font-bold uppercase tracking-wider text-base-content/50 mb-2 px-1">
              {CATEGORY_LABELS[category]}
            </h2>
            <ul className="space-y-2">
              {items.map((m) => (
                <li
                  key={m.id}
                  className="card bg-base-200 p-3"
                >
                  {editingId === m.id ? (
                    <div className="space-y-2">
                      <textarea
                        className="textarea textarea-bordered w-full text-sm"
                        rows={2}
                        value={draft.content ?? ""}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, content: e.target.value }))
                        }
                      />
                      <div className="flex flex-wrap gap-2 items-center">
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
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm break-words">{m.content}</div>
                        <div className="flex flex-wrap gap-1 mt-1.5">
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
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <button
                          className="btn btn-ghost btn-xs"
                          onClick={() => startEdit(m)}
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-ghost btn-xs text-error"
                          onClick={() => remove(m.id)}
                        >
                          Forget
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
