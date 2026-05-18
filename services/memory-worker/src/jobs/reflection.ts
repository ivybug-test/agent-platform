/**
 * Reflection v1 — Park-style pattern extraction from event clusters.
 *
 * Why this exists: even after Phase α M2/M3 the system can recall
 * individual fragments ("2026-04-18 熬夜赶论文") but doesn't see the
 * pattern ("经常熬夜赶 ddl"). The cure is offline synthesis: cluster
 * semantically-near event memories and ask an LLM whether the cluster
 * reveals a stable pattern.
 *
 * Pipeline per user:
 *   1. Load category='event' user_memories from last REFLECTION_WINDOW_DAYS
 *      that have a non-null embedding and aren't deleted/tombstoned
 *   2. Greedy ball-clustering on cosine distance (≤ CLUSTER_DISTANCE)
 *   3. For each cluster of size ≥ MIN_CLUSTER_SIZE, run LLM synthesis
 *   4. Validate output (hasPattern=true + non-empty pattern)
 *   5. Dedupe vs existing kind='reflection' rows for this user (cosine
 *      ≤ DEDUP_DISTANCE → reinforce; else insert)
 *
 * Convention (per user_memories.kind column doc):
 *   kind='reflection' rows store *memory* ids in source_message_ids
 *   (the chain of fact rows that motivated the synthesis), not message
 *   ids. evidence_quote = the LLM-picked representative event line.
 */

import { db, userMemories, users } from "@agent-platform/db";
import { and, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { llmCompleteJSON, llmCompleteStrongJSON } from "../llm.js";
import { embedOne } from "../embeddings.js";
import { buildReflectionPrompt } from "../prompts/reflection.js";
import { createLogger } from "@agent-platform/logger";
import { detectLanguage, formatWallClock } from "../lib/format.js";

const log = createLogger("memory-worker:reflection");

interface ReflectionData {
  userId: string;
}

const REFLECTION_WINDOW_DAYS = 30;
// Greedy ball-clustering radius. 0.35 cosine distance ≈ 0.65 similarity —
// loose enough to group "熬夜赶论文" with "凌晨 2 点睡 ppt" but tight
// enough that "熬夜" doesn't cluster with "睡懒觉".
const CLUSTER_DISTANCE = 0.35;
const MIN_CLUSTER_SIZE = 3;
// Reflection-vs-reflection dedup — tighter than fact dedup because the
// pattern statements are inherently abstract. Two reflections with
// cosine similarity ≥ 0.80 are almost certainly restating the same
// pattern.
const DEDUP_DISTANCE = 0.20;
// Cap how many clusters we synthesise per run. A spike user could
// theoretically have a dozen distinct event clusters; one reflection
// job already costs ~$0.05 of LLM calls, so we cap to keep runs cheap.
const MAX_CLUSTERS_PER_RUN = 5;

interface EventRow {
  id: string;
  content: string;
  importance: string;
  eventAt: Date | null;
  createdAt: Date;
  embedding: number[] | null;
  sourceMessageIds: string[] | null;
}

interface ReflectionOutput {
  hasPattern?: boolean;
  pattern?: string;
  importance?: "high" | "medium" | "low";
  representativeQuote?: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

/** Importance rank for picking seeds — higher first. */
function importanceRank(s: string): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}

/** Greedy ball-clustering: pick the highest-importance unclustered row,
 *  gather every other unclustered row within CLUSTER_DISTANCE, mark them
 *  clustered, repeat. Order: importance DESC, then recency DESC.
 *  Returns clusters sorted by size DESC. */
function cluster(rows: EventRow[]): EventRow[][] {
  const seeds = [...rows].sort((a, b) => {
    const ri = importanceRank(b.importance) - importanceRank(a.importance);
    if (ri !== 0) return ri;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const claimed = new Set<string>();
  const clusters: EventRow[][] = [];

  for (const seed of seeds) {
    if (claimed.has(seed.id)) continue;
    if (!seed.embedding) {
      claimed.add(seed.id);
      continue;
    }
    const group: EventRow[] = [seed];
    claimed.add(seed.id);
    for (const other of seeds) {
      if (claimed.has(other.id)) continue;
      if (!other.embedding) continue;
      const d = cosineDistance(seed.embedding, other.embedding);
      if (d <= CLUSTER_DISTANCE) {
        group.push(other);
        claimed.add(other.id);
      }
    }
    if (group.length >= MIN_CLUSTER_SIZE) {
      clusters.push(group);
    }
  }

  return clusters.sort((a, b) => b.length - a.length);
}

function renderClusterForPrompt(group: EventRow[]): string {
  // Chronological order for the LLM (oldest first) so "recurrence over
  // time" is easy to see.
  return [...group]
    .sort((a, b) => {
      const at = (a.eventAt ?? a.createdAt).getTime();
      const bt = (b.eventAt ?? b.createdAt).getTime();
      return at - bt;
    })
    .map((r) => {
      const when = formatWallClock(r.eventAt ?? r.createdAt);
      return `- [${when}] (memId=${r.id}) ${r.content}`;
    })
    .join("\n");
}

export async function processReflection(data: ReflectionData) {
  const { userId } = data;

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) {
    log.info({ userId }, "reflection.skip-no-user");
    return;
  }

  // Pull eligible event memories. We deliberately scope to category='event'
  // because patterns over identity/preference/relationship don't have the
  // "fragment" shape — those facts are already meant to be stable.
  const cutoff = new Date(
    Date.now() - REFLECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );

  const eventRows = (await db
    .select({
      id: userMemories.id,
      content: userMemories.content,
      importance: userMemories.importance,
      eventAt: userMemories.eventAt,
      createdAt: userMemories.createdAt,
      embedding: userMemories.embedding,
      sourceMessageIds: userMemories.sourceMessageIds,
    })
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, userId),
        eq(userMemories.category, "event"),
        eq(userMemories.kind, "fact"),
        isNull(userMemories.deletedAt),
        isNotNull(userMemories.embedding),
        sql`(${userMemories.eventAt} >= ${cutoff} OR ${userMemories.createdAt} >= ${cutoff})`
      )
    )
    .orderBy(desc(userMemories.createdAt))) as EventRow[];

  if (eventRows.length < MIN_CLUSTER_SIZE) {
    log.info(
      { userId, eventCount: eventRows.length },
      "reflection.skip-too-few-events"
    );
    return;
  }

  const clusters = cluster(eventRows);
  if (clusters.length === 0) {
    log.info(
      { userId, eventCount: eventRows.length },
      "reflection.no-clusters"
    );
    return;
  }

  // Existing reflection rows for this user — feed to dedup. We only need
  // their content + embedding.
  const existingReflections = await db
    .select({
      id: userMemories.id,
      content: userMemories.content,
      embedding: userMemories.embedding,
    })
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, userId),
        eq(userMemories.kind, "reflection"),
        isNull(userMemories.deletedAt)
      )
    );

  const nowIso = formatWallClock(new Date());

  let synthesized = 0;
  let skippedNoPattern = 0;
  let reinforced = 0;
  let llmFailed = 0;

  for (const group of clusters.slice(0, MAX_CLUSTERS_PER_RUN)) {
    const clusterText = renderClusterForPrompt(group);
    const language = detectLanguage(group.map((g) => g.content).join("\n"));

    let result: ReflectionOutput;
    try {
      // Reflection synthesis is a "consolidation" task — use the strong
      // model (M4.2 convention) so subtle pattern judgments don't get
      // botched by the cheap chat model.
      result = await llmCompleteStrongJSON<ReflectionOutput>(
        buildReflectionPrompt(language, nowIso, user.name),
        `Cluster of ${group.length} event memories (chronological):\n\n${clusterText}\n\nDecide if this reveals a stable pattern. Output strict JSON.`
      );
    } catch (err) {
      log.warn(
        { userId, clusterSize: group.length, err: (err as Error).message },
        "reflection.llm-error"
      );
      llmFailed++;
      continue;
    }

    if (!result?.hasPattern || typeof result.pattern !== "string") {
      log.info(
        { userId, clusterSize: group.length },
        "reflection.no-pattern"
      );
      skippedNoPattern++;
      continue;
    }
    const pattern = result.pattern.trim();
    if (!pattern) {
      skippedNoPattern++;
      continue;
    }
    const importance: "high" | "medium" | "low" =
      result.importance === "high" || result.importance === "low"
        ? result.importance
        : "medium";
    const representativeQuote =
      typeof result.representativeQuote === "string"
        ? result.representativeQuote.trim().slice(0, 120)
        : null;

    // Embed the pattern so dedup + future search can use it.
    let embedding: number[] | null = null;
    try {
      embedding = await embedOne(pattern);
    } catch (err) {
      log.warn(
        { userId, pattern, err: (err as Error).message },
        "reflection.embed-failed"
      );
    }

    // Dedup vs existing reflections — cosine ≤ DEDUP_DISTANCE → reinforce
    // the matching row, else insert new.
    let matched: { id: string; sim: number } | null = null;
    if (embedding) {
      for (const r of existingReflections) {
        if (!r.embedding) continue;
        const d = cosineDistance(embedding, r.embedding);
        const sim = 1 - d;
        if (d <= DEDUP_DISTANCE && (!matched || sim > matched.sim)) {
          matched = { id: r.id, sim };
        }
      }
    }

    // Source chain: union of all cluster members' ids. Per the schema doc
    // for kind='reflection', this column carries memory ids (not message
    // ids).
    const sourceChain = Array.from(new Set(group.map((g) => g.id)));

    if (matched) {
      await db
        .update(userMemories)
        .set({
          strength: sql`${userMemories.strength} + 1`,
          lastReinforcedAt: new Date(),
          // Refresh source chain to include any new cluster members. We
          // overwrite rather than merge — the cluster is computed fresh
          // each run from the current 30-day window, so the new list is
          // strictly more current.
          sourceMessageIds: sourceChain,
          ...(representativeQuote ? { evidenceQuote: representativeQuote } : {}),
          updatedAt: new Date(),
        })
        .where(eq(userMemories.id, matched.id));
      log.info(
        {
          userId,
          reflectionId: matched.id,
          pattern,
          similarity: matched.sim,
          clusterSize: group.length,
        },
        "reflection.reinforce"
      );
      reinforced++;
      continue;
    }

    await db.insert(userMemories).values({
      userId,
      content: pattern,
      category: "context",
      importance,
      kind: "reflection",
      source: "extracted",
      lastReinforcedAt: new Date(),
      sourceMessageIds: sourceChain,
      evidenceQuote: representativeQuote ?? undefined,
      embedding: embedding ?? undefined,
    });
    log.info(
      {
        userId,
        pattern,
        importance,
        clusterSize: group.length,
        sourceChainLength: sourceChain.length,
      },
      "reflection.create"
    );
    synthesized++;

    // Keep the in-memory existingReflections list in sync so subsequent
    // clusters in this same run don't synthesise a near-twin.
    if (embedding) {
      existingReflections.push({
        id: "local",
        content: pattern,
        embedding,
      });
    }
  }

  log.info(
    {
      userId,
      eventCount: eventRows.length,
      clusters: clusters.length,
      synthesized,
      reinforced,
      skippedNoPattern,
      llmFailed,
    },
    "reflection.result"
  );
}

/** Fan-out daily cron: enqueue one reflection job per user who has at
 *  least MIN_CLUSTER_SIZE event memories in the window. Idempotent
 *  per-day via jobId. */
export async function processReflectionScan(queue: import("bullmq").Queue) {
  const cutoff = new Date(
    Date.now() - REFLECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );

  // Find users with enough recent event memories that clustering could
  // possibly find a pattern. Anything below MIN_CLUSTER_SIZE total is
  // not worth queueing.
  const rows = await db
    .select({
      userId: userMemories.userId,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(userMemories)
    .where(
      and(
        eq(userMemories.category, "event"),
        eq(userMemories.kind, "fact"),
        isNull(userMemories.deletedAt),
        isNotNull(userMemories.embedding),
        sql`(${userMemories.eventAt} >= ${cutoff} OR ${userMemories.createdAt} >= ${cutoff})`
      )
    )
    .groupBy(userMemories.userId)
    .having(sql`count(*) >= ${MIN_CLUSTER_SIZE}`);

  const dayBucket = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  for (const r of rows) {
    await queue.add(
      "reflection",
      { userId: r.userId },
      { jobId: `reflection-${r.userId}-${dayBucket}` }
    );
  }

  log.info({ eligibleUsers: rows.length, dayBucket }, "reflection.scan-fanout");
}
