import { useState } from "react";
import type {
  Memory,
  NarrativeRow,
  ObservationRow,
  RelationshipRow,
} from "../types";
import { KIND_LABELS } from "../constants";

/** Read-only "what does the agent know about me" overview.
 *
 *  Composed entirely from data already fetched at the page level:
 *    - mine (user_memories)    → 身份 + 高重要性 facts + reflection rows
 *    - confirmedRels           → existing relationships data
 *    - narratives              → agent_memories.kind='narrative' (privacy:
 *                                  collapsed by default since these are
 *                                  the agent's subjective writeup)
 *    - observations            → room_observations from user's rooms
 */
export default function ProfileTab({
  mine,
  confirmedRels,
  narratives,
  observations,
  onGoToMine,
  onGoToRelationships,
}: {
  mine: Memory[];
  confirmedRels: RelationshipRow[];
  narratives: NarrativeRow[];
  observations: ObservationRow[];
  onGoToMine: () => void;
  onGoToRelationships: () => void;
}) {
  const [narrativesOpen, setNarrativesOpen] = useState(false);
  const [observationsOpen, setObservationsOpen] = useState(false);

  // Identity / core facts: anything tagged identity OR importance=high,
  // excluding reflection rows (those get their own section).
  const identity = mine.filter(
    (m) =>
      m.kind !== "reflection" &&
      (m.category === "identity" || m.importance === "high")
  );
  const reflections = mine.filter((m) => m.kind === "reflection");

  const empty =
    identity.length === 0 &&
    reflections.length === 0 &&
    confirmedRels.length === 0 &&
    narratives.length === 0 &&
    observations.length === 0;

  if (empty) {
    return (
      <div className="text-center text-sm text-base-content/40 py-16">
        画像还是空的。聊一段时间后，agent 会积累对你的认识。
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Identity */}
      <section>
        <SectionHeader
          title="agent 眼中的你"
          count={identity.length}
          hint="身份和高重要性的事实"
        />
        {identity.length === 0 ? (
          <EmptyHint text="还没有可靠的身份事实。" />
        ) : (
          <ul className="space-y-1.5">
            {identity.map((m) => (
              <li
                key={m.id}
                className="card bg-base-200 px-3 py-2 text-sm leading-snug"
              >
                {m.content}
              </li>
            ))}
          </ul>
        )}
        {mine.length > identity.length && (
          <button
            type="button"
            onClick={onGoToMine}
            className="mt-1.5 text-[11px] text-base-content/50 hover:text-base-content underline-offset-2 hover:underline px-1"
          >
            查看全部 {mine.length} 条原始记忆 →
          </button>
        )}
      </section>

      {/* Recurring patterns (reflection rows) */}
      <section>
        <SectionHeader
          title="反复出现的模式"
          count={reflections.length}
          hint="跨多次对话总结的高阶规律"
        />
        {reflections.length === 0 ? (
          <EmptyHint text="还没有总结出明显的模式（需要 ≥3 条同类事件）。" />
        ) : (
          <ul className="space-y-1.5">
            {reflections.map((m) => (
              <li
                key={m.id}
                className="card bg-base-200 px-3 py-2 text-sm leading-snug border-l-2 border-info/60"
              >
                {m.content}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Relationships */}
      <section>
        <SectionHeader
          title="人际关系"
          count={confirmedRels.length}
          hint="双方都确认过"
        />
        {confirmedRels.length === 0 ? (
          <EmptyHint text="还没有已确认的关系。" />
        ) : (
          <ul className="space-y-1.5">
            {confirmedRels.map((r) => (
              <li
                key={r.id}
                className="card bg-base-200 px-3 py-2 text-sm flex items-center gap-2"
              >
                <span className="font-medium">{r.other.name}</span>
                <span className="badge badge-xs badge-info">
                  {KIND_LABELS[r.kind]}
                </span>
                {r.content && (
                  <span className="text-xs text-base-content/60 truncate">
                    {r.content}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={onGoToRelationships}
          className="mt-1.5 text-[11px] text-base-content/50 hover:text-base-content underline-offset-2 hover:underline px-1"
        >
          管理关系 →
        </button>
      </section>

      {/* Agent narratives — collapsed by default. These are the agent's
          own subjective paragraph about its relationship with you, which
          can be surprising to read; opt-in keeps it from feeling like
          surveillance. */}
      {narratives.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setNarrativesOpen((v) => !v)}
            className="w-full flex items-center gap-2 mb-1"
          >
            <Chevron open={narrativesOpen} />
            <span className="text-xs font-bold text-base-content/60">
              agent 自己的笔记（{narratives.length}）
            </span>
            <span className="text-[10px] text-base-content/40 ml-1">
              主观叙述，点击展开
            </span>
          </button>
          {narrativesOpen && (
            <ul className="space-y-2 pl-1">
              {narratives.map((n) => (
                <li
                  key={n.id}
                  className="card bg-base-200 px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap"
                >
                  <div className="text-[10px] text-base-content/50 mb-1">
                    — {n.agentName}
                  </div>
                  {n.content}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Recent observations — also collapsed: it's a timeline, useful
          but visually long. */}
      {observations.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setObservationsOpen((v) => !v)}
            className="w-full flex items-center gap-2 mb-1"
          >
            <Chevron open={observationsOpen} />
            <span className="text-xs font-bold text-base-content/60">
              最近观察日志（{observations.length}）
            </span>
            <span className="text-[10px] text-base-content/40 ml-1">
              跨房间事件流
            </span>
          </button>
          {observationsOpen && (
            <ul className="space-y-2 pl-1">
              {observations.map((o) => (
                <li
                  key={o.id}
                  className="card bg-base-200 px-3 py-2 text-xs leading-snug whitespace-pre-wrap"
                >
                  <div className="text-[10px] text-base-content/50 mb-1 flex gap-2">
                    <span className="font-medium">{o.roomName}</span>
                    <span>·</span>
                    <span>{formatRange(o.periodStart, o.periodEnd)}</span>
                  </div>
                  {o.content}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  count,
  hint,
}: {
  title: string;
  count: number;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 mb-2 px-1">
      <h2 className="text-xs font-bold text-base-content/70">
        {title}
        <span className="text-base-content/40 font-normal ml-1.5">
          ({count})
        </span>
      </h2>
      {hint && (
        <span className="text-[10px] text-base-content/40">{hint}</span>
      )}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="text-xs text-base-content/40 py-2 px-1">{text}</div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={2.2}
      stroke="currentColor"
      className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 6l6 6-6 6"
      />
    </svg>
  );
}

function formatRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const sameDay =
    s.getFullYear() === e.getFullYear() &&
    s.getMonth() === e.getMonth() &&
    s.getDate() === e.getDate();
  const fmtDate = (d: Date) =>
    `${d.getMonth() + 1}/${d.getDate()}`;
  const fmtTime = (d: Date) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) {
    return `${fmtDate(s)} ${fmtTime(s)}–${fmtTime(e)}`;
  }
  return `${fmtDate(s)}–${fmtDate(e)}`;
}
