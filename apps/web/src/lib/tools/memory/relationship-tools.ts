import { db, users, userRelationships } from "@agent-platform/db";
import { and, eq, isNull, isNotNull, or, inArray } from "drizzle-orm";
import type { ToolHandler } from "../index";
import { resolveRoomMemberByName } from "../resolvers";
import {
  VALID_RELATIONSHIP_KINDS,
  type RelationshipKind,
} from "./shared";

// -----------------------------------------------------------------------------
// User relationships (Phase 4 of multi-user memory)
// -----------------------------------------------------------------------------

const relate: ToolHandler = async (args, ctx) => {
  const otherUserName =
    typeof args?.otherUserName === "string" ? args.otherUserName.trim() : "";
  const kind = args?.kind as RelationshipKind;
  const content =
    typeof args?.content === "string" ? args.content.trim() : null;

  if (!otherUserName) return { error: "otherUserName required" };
  if (!VALID_RELATIONSHIP_KINDS.includes(kind)) {
    return { error: "invalid kind" };
  }

  const otherUserId = await resolveRoomMemberByName(ctx.roomId, otherUserName);
  if (!otherUserId) {
    return { error: `no unique room member matches "${otherUserName}"` };
  }
  if (otherUserId === ctx.userId) {
    return { error: "cannot relate to yourself" };
  }

  // Canonical ordering: a_user_id < b_user_id.
  const [aId, bId] =
    ctx.userId < otherUserId
      ? [ctx.userId, otherUserId]
      : [otherUserId, ctx.userId];
  const speakerIsA = ctx.userId === aId;
  const now = new Date();

  // Upsert: find existing row first.
  const [existing] = await db
    .select()
    .from(userRelationships)
    .where(
      and(
        eq(userRelationships.aUserId, aId),
        eq(userRelationships.bUserId, bId),
        eq(userRelationships.kind, kind),
        isNull(userRelationships.deletedAt)
      )
    );

  if (existing) {
    // Update the speaker's confirmation side only.
    const patch = speakerIsA
      ? { confirmedByA: now, updatedAt: now }
      : { confirmedByB: now, updatedAt: now };
    if (content) (patch as any).content = content;
    const [updated] = await db
      .update(userRelationships)
      .set(patch)
      .where(eq(userRelationships.id, existing.id))
      .returning();
    return {
      ok: true,
      relationship: updated,
      fullyConfirmed:
        updated.confirmedByA !== null && updated.confirmedByB !== null,
    };
  }

  const [row] = await db
    .insert(userRelationships)
    .values({
      aUserId: aId,
      bUserId: bId,
      kind,
      content,
      confirmedByA: speakerIsA ? now : null,
      confirmedByB: speakerIsA ? null : now,
    })
    .returning();
  return {
    ok: true,
    relationship: row,
    fullyConfirmed: false,
    note: `Proposed ${kind} edge with ${otherUserName}. They'll see it in their /memories 关系 tab and can accept or reject.`,
  };
};

const searchRelationships: ToolHandler = async (args, ctx) => {
  const withUserName =
    typeof args?.withUserName === "string" ? args.withUserName.trim() : "";

  let otherId: string | null = null;
  if (withUserName) {
    otherId = await resolveRoomMemberByName(ctx.roomId, withUserName);
    if (!otherId) {
      return { error: `no unique room member matches "${withUserName}"` };
    }
  }

  const speakerInvolved = or(
    eq(userRelationships.aUserId, ctx.userId),
    eq(userRelationships.bUserId, ctx.userId)
  )!;
  const conditions = [
    speakerInvolved,
    isNull(userRelationships.deletedAt),
    isNotNull(userRelationships.confirmedByA),
    isNotNull(userRelationships.confirmedByB),
  ];
  if (otherId) {
    conditions.push(
      or(
        and(
          eq(userRelationships.aUserId, ctx.userId),
          eq(userRelationships.bUserId, otherId)
        ),
        and(
          eq(userRelationships.aUserId, otherId),
          eq(userRelationships.bUserId, ctx.userId)
        )
      )!
    );
  }

  const rows = await db
    .select({
      id: userRelationships.id,
      aUserId: userRelationships.aUserId,
      bUserId: userRelationships.bUserId,
      kind: userRelationships.kind,
      content: userRelationships.content,
    })
    .from(userRelationships)
    .where(and(...conditions));

  // Resolve the other side's name for each row.
  const otherIds = [
    ...new Set(
      rows.map((r) => (r.aUserId === ctx.userId ? r.bUserId : r.aUserId))
    ),
  ];
  const nameRows =
    otherIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, otherIds))
      : [];
  const nameMap = new Map(nameRows.map((u) => [u.id, u.name]));

  return {
    results: rows.map((r) => ({
      id: r.id,
      otherUserName:
        nameMap.get(r.aUserId === ctx.userId ? r.bUserId : r.aUserId) || "?",
      kind: r.kind,
      content: r.content,
    })),
  };
};

const unrelate: ToolHandler = async (args, ctx) => {
  const relationshipId =
    typeof args?.relationshipId === "string"
      ? args.relationshipId.trim()
      : "";
  if (!relationshipId) return { error: "relationshipId required" };

  const [row] = await db
    .update(userRelationships)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(userRelationships.id, relationshipId),
        or(
          eq(userRelationships.aUserId, ctx.userId),
          eq(userRelationships.bUserId, ctx.userId)
        )!,
        isNull(userRelationships.deletedAt)
      )
    )
    .returning({ id: userRelationships.id });

  if (!row) return { error: "relationship not found" };
  return { ok: true };
};

export const relationshipToolHandlers: Record<string, ToolHandler> = {
  relate,
  search_relationships: searchRelationships,
  unrelate,
};

export const relationshipToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "relate",
      description:
        "Propose or confirm a typed relationship edge between the current speaker and another room member. Both sides must eventually confirm for the edge to be active and shown to the agent in future chats.",
      parameters: {
        type: "object",
        required: ["otherUserName", "kind"],
        properties: {
          otherUserName: {
            type: "string",
            description:
              "The display name of the other room member. Must match exactly (case-insensitive).",
          },
          kind: {
            type: "string",
            enum: [...VALID_RELATIONSHIP_KINDS],
          },
          content: {
            type: "string",
            description:
              "Optional extra detail, e.g. '认识 10 年' / 'met in college'.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_relationships",
      description:
        "List the current speaker's active (both-sides-confirmed) relationships. Optionally narrow to a specific other member.",
      parameters: {
        type: "object",
        properties: {
          withUserName: {
            type: "string",
            description:
              "If set, only return the relationship with this specific room member.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "unrelate",
      description:
        "Soft-delete a relationship edge. Either side of the edge can remove it.",
      parameters: {
        type: "object",
        required: ["relationshipId"],
        properties: {
          relationshipId: { type: "string" },
        },
      },
    },
  },
];
