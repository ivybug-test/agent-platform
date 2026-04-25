import { db, messages, users, agents } from "@agent-platform/db";
import { eq, inArray } from "drizzle-orm";
import type { ReplyToSnippet } from "@/lib/redis";

const QUOTE_PREVIEW_MAX = 140;

/** Trim a message body for inline quoting. Keeps the first ~140 chars
 *  and replaces newlines with spaces — quoted text is shown in a single
 *  collapsed line above the reply. */
export function previewForQuote(
  content: string,
  contentType: string | null | undefined
): string {
  if (contentType === "image") return "[图片]";
  const oneLine = (content || "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= QUOTE_PREVIEW_MAX) return oneLine;
  return oneLine.slice(0, QUOTE_PREVIEW_MAX) + "…";
}

/** Look up a single quoted message and pack it into a snippet. Returns
 *  null when the target was deleted. Used by /api/chat &
 *  /api/messages/image when the user's reply targets a message that
 *  isn't already in the same payload. */
export async function fetchReplySnippet(
  messageId: string
): Promise<ReplyToSnippet | null> {
  const [target] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!target) return null;

  let senderName: string | null = null;
  if (target.senderId) {
    if (target.senderType === "user") {
      const [u] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, target.senderId));
      senderName = u?.name ?? null;
    } else if (target.senderType === "agent") {
      const [a] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, target.senderId));
      senderName = a?.name ?? null;
    }
  }
  return {
    id: target.id,
    senderName,
    content: previewForQuote(target.content, target.contentType),
    contentType: target.contentType ?? "text",
  };
}

/** Bulk lookup for the messages list endpoint: given a set of target
 *  IDs, returns a Map keyed by messageId. Single round-trip per kind. */
export async function bulkReplySnippets(
  targetIds: string[]
): Promise<Map<string, ReplyToSnippet>> {
  if (targetIds.length === 0) return new Map();
  const targets = await db
    .select()
    .from(messages)
    .where(inArray(messages.id, targetIds));

  const userSenderIds = [
    ...new Set(
      targets
        .filter((t) => t.senderType === "user" && t.senderId)
        .map((t) => t.senderId!)
    ),
  ];
  const agentSenderIds = [
    ...new Set(
      targets
        .filter((t) => t.senderType === "agent" && t.senderId)
        .map((t) => t.senderId!)
    ),
  ];
  const [userRows, agentRows] = await Promise.all([
    userSenderIds.length > 0
      ? db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, userSenderIds))
      : [],
    agentSenderIds.length > 0
      ? db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, agentSenderIds))
      : [],
  ]);
  const nameMap = new Map<string, string>();
  for (const u of userRows) nameMap.set(u.id, u.name);
  for (const a of agentRows) nameMap.set(a.id, a.name);

  const out = new Map<string, ReplyToSnippet>();
  for (const t of targets) {
    out.set(t.id, {
      id: t.id,
      senderName: t.senderId ? nameMap.get(t.senderId) ?? null : null,
      content: previewForQuote(t.content, t.contentType),
      contentType: t.contentType ?? "text",
    });
  }
  return out;
}
