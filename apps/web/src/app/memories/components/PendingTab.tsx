import type { Memory } from "../types";
import {
  CATEGORY_LABELS,
  IMPORTANCE_COLORS,
  IMPORTANCE_LABELS,
} from "../constants";

export default function PendingTab({
  pending,
  accept,
  reject,
}: {
  pending: Memory[];
  accept: (id: string) => void;
  reject: (id: string) => void;
}) {
  if (pending.length === 0) {
    return (
      <div className="text-center text-sm text-base-content/40 py-16">
        没有待确认的记忆。其他成员对你写入的事实会出现在这里。
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {pending.map((m) => (
        <li key={m.id} className="card bg-base-200 px-3 py-2.5">
          <div className="text-sm break-words leading-relaxed">{m.content}</div>
          <div className="flex items-center flex-wrap gap-1 mt-1.5">
            <span className="badge badge-xs badge-ghost">
              {CATEGORY_LABELS[m.category]}
            </span>
            <span className={`badge badge-xs ${IMPORTANCE_COLORS[m.importance]}`}>
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
  );
}
