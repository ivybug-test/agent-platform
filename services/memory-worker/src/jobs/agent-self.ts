import {
  db,
  agents,
  agentMemories,
  messages,
} from "@agent-platform/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { llmCompleteJSON } from "../llm.js";
import { createLogger } from "@agent-platform/logger";
import { textSimilarity } from "../text-similarity.js";
import { buildAgentSelfPrompt } from "../prompts/agent-self.js";
import {
  detectLanguage,
  formatWallClock,
  messageBody,
} from "../lib/format.js";

const log = createLogger("memory-worker:agent-self");

interface AgentSelfData {
  agentId: string;
}

const SAMPLE_SIZE = 100; // recent agent messages to feed LLM
const DUP_REINFORCE_THRESHOLD = 0.55; // same as user-memory extractor

interface ExtractAction {
  content: string;
  importance: "high" | "medium" | "low";
  evidenceMessageId: string;
  evidenceQuote: string;
}

function normaliseForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
function quoteMatchesMessage(quote: string, source: string): boolean {
  if (!quote || !source) return false;
  const q = normaliseForMatch(quote);
  if (q.length < 2) return false;
  return normaliseForMatch(source).includes(q);
}

export async function processAgentSelfExtract(data: AgentSelfData) {
  const { agentId } = data;

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent) {
    log.warn({ agentId }, "agent-self.skip-no-agent");
    return;
  }

  // Sample the agent's recent assistant messages across ALL rooms it
  // talks in. self_tendency is global to the agent, not per-room.
  const sample = await db
    .select({
      id: messages.id,
      content: messages.content,
      contentType: messages.contentType,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.senderType, "agent"),
        eq(messages.senderId, agentId),
        eq(messages.status, "completed"),
        sql`${messages.content} <> ''`
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(SAMPLE_SIZE);

  if (sample.length < 10) {
    log.info(
      { agentId, sampleSize: sample.length },
      "agent-self.skip-not-enough-messages"
    );
    return;
  }

  // Existing self_tendency rows so we don't restate them. Cap to 30 rows
  // for the prompt (any more would bloat).
  const existing = await db
    .select({ id: agentMemories.id, content: agentMemories.content })
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.kind, "self_tendency"),
        isNull(agentMemories.deletedAt)
      )
    )
    .orderBy(desc(agentMemories.updatedAt))
    .limit(30);

  const existingText =
    existing.length > 0
      ? existing.map((m) => `- ${m.content}`).join("\n")
      : "";

  // Reverse to chronological — easier for LLM to spot drift over time.
  const orderedSample = [...sample].reverse();
  const messagesText = orderedSample
    .map(
      (m) =>
        `[${formatWallClock(m.createdAt)}] (msgId=${m.id}) ${messageBody(m)}`
    )
    .join("\n");

  const language = detectLanguage(
    orderedSample.map((m) => messageBody(m)).join("\n")
  );

  const msgById = new Map(orderedSample.map((m) => [m.id, m]));

  let result: { tendencies?: ExtractAction[] };
  try {
    result = await llmCompleteJSON(
      buildAgentSelfPrompt(language, existingText),
      `Recent assistant messages (yours), oldest at top:\n\n${messagesText}\n\nIdentify behavioural patterns per the system rules. Output strict JSON.`
    );
  } catch (err) {
    log.error({ agentId, err }, "agent-self.llm-error");
    return;
  }

  const tendencies = Array.isArray(result?.tendencies) ? result.tendencies : [];
  if (tendencies.length === 0) {
    log.info({ agentId, sampleSize: sample.length }, "agent-self.no-new");
    return;
  }

  let created = 0;
  let reinforced = 0;
  let evidenceMismatch = 0;
  let restatement = 0;

  for (const t of tendencies) {
    if (
      typeof t?.content !== "string" ||
      typeof t?.evidenceMessageId !== "string" ||
      typeof t?.evidenceQuote !== "string"
    ) {
      continue;
    }
    const content = t.content.trim();
    if (!content) continue;
    const importance =
      t.importance === "high" || t.importance === "low" ? t.importance : "medium";

    // Provenance check (M2 discipline — also applies to self-memory).
    const sourceMsg = msgById.get(t.evidenceMessageId);
    if (!sourceMsg) {
      log.warn({ agentId, content }, "agent-self.bad-source-id");
      evidenceMismatch++;
      continue;
    }
    const sourceText = messageBody(sourceMsg);
    if (!quoteMatchesMessage(t.evidenceQuote, sourceText)) {
      log.warn(
        {
          agentId,
          content,
          quote: t.evidenceQuote,
          source: sourceText.slice(0, 80),
        },
        "agent-self.evidence-mismatch"
      );
      evidenceMismatch++;
      continue;
    }

    // Dedup against existing self_tendency — if there's a near-twin,
    // REINFORCE it (Phase A semantics) instead of creating a new row.
    let best: { id: string; sim: number } | null = null;
    for (const e of existing) {
      const sim = textSimilarity(content, e.content);
      if (!best || sim > best.sim) best = { id: e.id, sim };
    }
    if (best && best.sim >= DUP_REINFORCE_THRESHOLD) {
      await db
        .update(agentMemories)
        .set({
          strength: sql`${agentMemories.strength} + 1`,
          lastReinforcedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentMemories.id, best.id));
      restatement++;
      reinforced++;
      continue;
    }

    await db.insert(agentMemories).values({
      agentId,
      kind: "self_tendency",
      content,
      importance,
      source: "extracted",
      lastReinforcedAt: new Date(),
      sourceMessageIds: [t.evidenceMessageId],
      evidenceQuote: t.evidenceQuote.slice(0, 120),
    });
    created++;
  }

  log.info(
    {
      agentId,
      sampleSize: sample.length,
      created,
      reinforced,
      evidenceMismatch,
      restatement,
    },
    "agent-self.result"
  );
}

/** Fan out one agent-self-extract job per active agent. Called by the
 *  daily scheduler. Idempotent per-day via jobId. */
export async function processAgentSelfScan(queue: import("bullmq").Queue) {
  // Only agents that actually have recent assistant messages — no point
  // running on dormant agents.
  const activeAgents = await db
    .selectDistinct({ id: messages.senderId })
    .from(messages)
    .where(
      and(
        eq(messages.senderType, "agent"),
        eq(messages.status, "completed"),
        sql`${messages.createdAt} > now() - interval '7 days'`
      )
    );
  const ids = activeAgents
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const dayBucket = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  for (const id of ids) {
    await queue.add(
      "agent-self-extract",
      { agentId: id },
      { jobId: `agent-self-extract-${id}-${dayBucket}` }
    );
  }

  log.info(
    { activeAgents: ids.length, dayBucket },
    "agent-self.scan-fanout"
  );
}
