import type { Category, Importance, Memory } from "../types";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  IMPORTANCE_COLORS,
  IMPORTANCE_LABELS,
} from "../constants";
import { fmtMemoryTime } from "../lib/format";

/** Single row in the mine list. Inline-edit toggle, inline metadata
 *  (importance + locked badge + relative time), and edit/forget actions
 *  on the right. Shared by recent / search / by-category sections. */
export default function MineRow({
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
        <span className={`badge badge-xs ${IMPORTANCE_COLORS[m.importance]}`}>
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
