import type { Category, FriendOption, Importance, Memory } from "../types";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  RECENT_LIMIT,
} from "../constants";
import MineRow from "./MineRow";

export default function MineTab({
  mine,
  query,
  setQuery,
  addOpen,
  newContent,
  setNewContent,
  newCategory,
  setNewCategory,
  newImportance,
  setNewImportance,
  newSubject,
  setNewSubject,
  friendOpts,
  saving,
  create,
  editingId,
  draft,
  setDraft,
  startEdit,
  cancelEdit,
  saveEdit,
  remove,
  allOpen,
  setAllOpen,
}: {
  mine: Memory[];
  query: string;
  setQuery: (s: string) => void;
  addOpen: boolean;
  newContent: string;
  setNewContent: (s: string) => void;
  newCategory: Category;
  setNewCategory: (c: Category) => void;
  newImportance: Importance;
  setNewImportance: (i: Importance) => void;
  newSubject: "self" | string;
  setNewSubject: (s: "self" | string) => void;
  friendOpts: FriendOption[];
  saving: boolean;
  create: () => void;
  editingId: string | null;
  draft: Partial<Memory>;
  setDraft: (fn: (d: Partial<Memory>) => Partial<Memory>) => void;
  startEdit: (m: Memory) => void;
  cancelEdit: () => void;
  saveEdit: (id: string) => void;
  remove: (id: string) => void;
  allOpen: boolean;
  setAllOpen: (fn: (v: boolean) => boolean) => void;
}) {
  // mine is already updatedAt-DESC sorted by the API. recent = top N.
  // byCategory groups for the expandable "全部" section.
  const recent = mine.slice(0, RECENT_LIMIT);
  const byCategory = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    items: mine.filter((m) => m.category === cat),
  })).filter((g) => g.items.length > 0);
  const isSearching = query.trim().length > 0;

  return (
    <>
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
    </>
  );
}
