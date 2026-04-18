"use client";

import { useEffect, useState } from "react";

type Importance = "high" | "medium" | "low";

interface RoomMemory {
  id: string;
  content: string;
  importance: Importance;
  source: "extracted" | "user_explicit";
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

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

export default function RoomSettings({
  roomId,
  roomName,
  onClose,
}: {
  roomId: string;
  roomName: string;
  onClose: () => void;
}) {
  const [facts, setFacts] = useState<RoomMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [newContent, setNewContent] = useState("");
  const [newImportance, setNewImportance] = useState<Importance>("medium");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<RoomMemory>>({});

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/memories`);
      if (res.ok) setFacts(await res.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const create = async () => {
    if (!newContent.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: newContent.trim(),
          importance: newImportance,
        }),
      });
      if (res.ok) {
        const created: RoomMemory = await res.json();
        setFacts((prev) => [created, ...prev]);
        setNewContent("");
      }
    } finally {
      setSaving(false);
    }
  };

  const save = async (id: string) => {
    if (!draft.content?.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/memories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: draft.content,
          importance: draft.importance,
        }),
      });
      if (res.ok) {
        const updated: RoomMemory = await res.json();
        setFacts((prev) => prev.map((f) => (f.id === id ? updated : f)));
        setEditingId(null);
        setDraft({});
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("删除这条房间共享事实?")) return;
    const res = await fetch(`/api/rooms/${roomId}/memories/${id}`, {
      method: "DELETE",
    });
    if (res.ok) setFacts((prev) => prev.filter((f) => f.id !== id));
  };

  return (
    <div className="modal modal-open" onClick={onClose}>
      <div
        className="modal-box w-[calc(100%-2rem)] max-w-lg"
        data-theme="dark"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <div>
            <h3 className="font-bold text-lg">房间共享事实</h3>
            <p className="text-xs text-base-content/50 mt-0.5 truncate">
              {roomName}
            </p>
          </div>
          <button className="btn btn-sm btn-circle btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Add */}
        <div className="card bg-base-200 p-3 mb-4 space-y-2">
          <textarea
            className="textarea textarea-bordered w-full text-sm"
            placeholder="例如:本群讨论像素游戏开发,项目代号 Nightfall"
            rows={2}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <select
              className="select select-bordered select-sm"
              value={newImportance}
              onChange={(e) =>
                setNewImportance(e.target.value as Importance)
              }
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
              添加
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-6">
            <span className="loading loading-spinner loading-sm"></span>
          </div>
        ) : facts.length === 0 ? (
          <div className="text-center text-sm text-base-content/40 py-8">
            还没有共享事实。添加一条,房间里所有人(含 agent)都会看到。
          </div>
        ) : (
          <ul className="space-y-2">
            {facts.map((f) => (
              <li key={f.id} className="card bg-base-200 px-3 py-2.5">
                {editingId === f.id ? (
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
                    <div className="flex gap-2 items-center">
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
                          onClick={() => {
                            setEditingId(null);
                            setDraft({});
                          }}
                          disabled={saving}
                        >
                          取消
                        </button>
                        <button
                          className="btn btn-primary btn-xs"
                          onClick={() => save(f.id)}
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
                      {f.content}
                    </div>
                    <div className="flex items-center flex-wrap gap-1 mt-1.5">
                      <span
                        className={`badge badge-xs ${IMPORTANCE_COLORS[f.importance]}`}
                      >
                        {IMPORTANCE_LABELS[f.importance]}
                      </span>
                      {f.source === "user_explicit" && (
                        <span className="badge badge-xs badge-info">
                          手动
                        </span>
                      )}
                      <div className="ml-auto flex gap-0.5">
                        <button
                          className="btn btn-ghost btn-xs h-6 min-h-0 px-2"
                          onClick={() => {
                            setEditingId(f.id);
                            setDraft({
                              content: f.content,
                              importance: f.importance,
                            });
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="btn btn-ghost btn-xs h-6 min-h-0 px-2 text-error"
                          onClick={() => remove(f.id)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
