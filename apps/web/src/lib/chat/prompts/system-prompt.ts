import {
  formatUserMemories,
  formatCurrentTime,
} from "./format-helpers";
import { CAPABILITIES } from "./capabilities";
import { buildToolGuidance } from "./tool-guidance";
import { buildRules } from "./rules";

/** Build the 6-layer system prompt (per CLAUDE.md context strategy).
 *
 *  Layers, in order:
 *  - 1   Agent identity (the agent's own system prompt)
 *  - 1a  Capability declaration (counters "I'm a text model" defaults)
 *  - 1b  Wall-clock anchor (Asia/Shanghai now)
 *  - 2   Room rules (room.system_prompt + roster)
 *  - 2b  Room context (shared facts across all members)
 *  - 2c  Known relationships involving the speaker
 *  - 3   Pinned memory snapshot (identity + high-importance only)
 *  - 4   Latest room summary
 *  - 5   (recent messages added separately as user/assistant turns)
 *  - 6   Tool usage hints + IMPORTANT RULES 1–10
 */
export function buildSystemPrompt(opts: {
  agentPrompt: string | null;
  roomPrompt: string | null;
  roomName: string;
  memberNames: string[];
  agentName: string;
  currentUserName: string;
  roomSummary: string | null;
  roomMemories?: { content: string; importance: string }[];
  relationships?: { otherName: string; kind: string; content: string | null }[];
  allUsersMemories: Map<string, { category: string; content: string }[]>;
}): string {
  // Layer 3: Pinned memory snapshot (identity + high-importance only).
  // Everything else is retrievable via the search_memories tool on demand.
  let memorySection: string | null = null;
  if (opts.allUsersMemories.size > 0) {
    const parts: string[] = [];
    for (const [name, memories] of opts.allUsersMemories) {
      const formatted = formatUserMemories(memories);
      if (formatted) {
        parts.push(`Pinned facts about ${name}:\n${formatted}`);
      }
    }
    if (parts.length > 0) memorySection = parts.join("\n\n");
  }

  // Room context (Phase 3): facts shared across all members of the room.
  const roomMemoriesSection =
    opts.roomMemories && opts.roomMemories.length > 0
      ? `Room context (facts shared by all members of this room):\n${opts.roomMemories
          .map((r) => `- ${r.content}`)
          .join("\n")}`
      : null;

  // Known relationships (Phase 4): only bidirectionally confirmed edges
  // involving the current speaker and present room members.
  const relationshipsSection =
    opts.relationships && opts.relationships.length > 0
      ? `Known relationships involving ${opts.currentUserName}:\n${opts.relationships
          .map(
            (r) =>
              `- ${opts.currentUserName} 和 ${r.otherName} 是 ${r.kind}${
                r.content ? `(${r.content})` : ""
              }`
          )
          .join("\n")}`
      : null;

  const nowLine = `Current time: ${formatCurrentTime()}. When the user says "今天" / "昨天" / "刚才" / "上周", resolve them against this timestamp before storing anything in memory.`;

  return [
    // Layer 1: Agent identity (system prompt)
    opts.agentPrompt || "You are a helpful assistant.",
    // Layer 1a: Capability declaration
    CAPABILITIES,
    // Layer 1b: Wall-clock anchor for resolving relative time phrases
    nowLine,
    // Layer 2: Room rules (room system_prompt)
    [
      opts.roomPrompt,
      `Room: "${opts.roomName}". Members: ${opts.memberNames.join(", ")}.`,
    ]
      .filter(Boolean)
      .join("\n"),
    // Layer 2b: Room context (shared facts)
    roomMemoriesSection,
    // Layer 2c: Known relationships involving the speaker
    relationshipsSection,
    // Layer 3: Pinned memory snapshot
    memorySection,
    // Layer 4: Room summary
    opts.roomSummary
      ? `Previous conversation summary:\n${opts.roomSummary}`
      : null,
    // Layer 5: (recent messages are added separately as user/assistant turns)
    // Tool usage hints
    buildToolGuidance({ currentUserName: opts.currentUserName }),
    // Layer 6: User context + rules
    buildRules({
      currentUserName: opts.currentUserName,
      agentName: opts.agentName,
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}
