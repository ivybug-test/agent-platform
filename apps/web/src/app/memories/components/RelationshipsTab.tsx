import type { FriendRow, RelationshipKind, RelationshipRow } from "../types";
import { KIND_LABELS } from "../constants";

export default function RelationshipsTab({
  confirmedRels,
  pendingRels,
  outgoingRels,
  friendList,
  relAddOpen,
  setRelAddOpen,
  relFriendId,
  setRelFriendId,
  relKind,
  setRelKind,
  relContent,
  setRelContent,
  saving,
  proposeRelationship,
  acceptRel,
  removeRel,
}: {
  confirmedRels: RelationshipRow[];
  pendingRels: RelationshipRow[];
  outgoingRels: RelationshipRow[];
  friendList: FriendRow[];
  relAddOpen: boolean;
  setRelAddOpen: (fn: (v: boolean) => boolean) => void;
  relFriendId: string;
  setRelFriendId: (id: string) => void;
  relKind: RelationshipKind;
  setRelKind: (k: RelationshipKind) => void;
  relContent: string;
  setRelContent: (s: string) => void;
  saving: boolean;
  proposeRelationship: () => void;
  acceptRel: (id: string) => void;
  removeRel: (id: string) => void;
}) {
  return (
    <div className="space-y-5">
      {/* Add relationship */}
      <div className="card bg-base-200 p-3 space-y-2">
        <button
          className="btn btn-primary btn-sm w-full"
          onClick={() => setRelAddOpen((v) => !v)}
        >
          {relAddOpen ? "取消" : "+ 新增关系"}
        </button>
        {relAddOpen &&
          (friendList.length === 0 ? (
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
          ))}
      </div>

      {/* Pending (incoming) */}
      {pendingRels.length > 0 && (
        <section>
          <h2 className="text-xs font-bold text-base-content/60 mb-2 px-1">
            待确认({pendingRels.length})
          </h2>
          <ul className="space-y-2">
            {pendingRels.map((r) => (
              <li key={r.id} className="card bg-base-200 px-3 py-2.5">
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
              <li key={r.id} className="card bg-base-200 px-3 py-2.5">
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
              <li key={r.id} className="card bg-base-200 px-3 py-2.5 opacity-70">
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
  );
}
