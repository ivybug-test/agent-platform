"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import type {
  Category,
  FriendOption,
  FriendRow,
  Importance,
  Memory,
  RelationshipKind,
  RelationshipRow,
  Tab,
} from "./types";
import MineTab from "./components/MineTab";
import PendingTab from "./components/PendingTab";
import RelationshipsTab from "./components/RelationshipsTab";

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
      const memUrl = opts.q
        ? `/api/memories?q=${encodeURIComponent(opts.q)}`
        : "/api/memories";
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
    if (!confirm("遗忘这条记忆?后台抽取器将被告知不要重新创建。")) return;
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
            <span className="badge badge-primary badge-xs">{pending.length}</span>
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
        {tab === "pending" && (
          <PendingTab pending={pending} accept={accept} reject={reject} />
        )}

        {tab === "relationships" && (
          <RelationshipsTab
            confirmedRels={confirmedRels}
            pendingRels={pendingRels}
            outgoingRels={outgoingRels}
            friendList={friendList}
            relAddOpen={relAddOpen}
            setRelAddOpen={setRelAddOpen}
            relFriendId={relFriendId}
            setRelFriendId={setRelFriendId}
            relKind={relKind}
            setRelKind={setRelKind}
            relContent={relContent}
            setRelContent={setRelContent}
            saving={saving}
            proposeRelationship={proposeRelationship}
            acceptRel={acceptRel}
            removeRel={removeRel}
          />
        )}

        {tab === "mine" && (
          <MineTab
            mine={mine}
            query={query}
            setQuery={setQuery}
            addOpen={addOpen}
            newContent={newContent}
            setNewContent={setNewContent}
            newCategory={newCategory}
            setNewCategory={setNewCategory}
            newImportance={newImportance}
            setNewImportance={setNewImportance}
            newSubject={newSubject}
            setNewSubject={setNewSubject}
            friendOpts={friendOpts}
            saving={saving}
            create={create}
            editingId={editingId}
            draft={draft}
            setDraft={setDraft}
            startEdit={startEdit}
            cancelEdit={cancelEdit}
            saveEdit={saveEdit}
            remove={remove}
            allOpen={allOpen}
            setAllOpen={setAllOpen}
          />
        )}
      </div>
    </main>
  );
}
