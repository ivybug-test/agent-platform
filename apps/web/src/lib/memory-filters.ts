import { userMemories } from "@agent-platform/db";
import { and, eq, isNotNull, isNull, or, type SQL } from "drizzle-orm";

/**
 * Returns the SQL WHERE fragment that every read path MUST apply so pending
 * third-party writes and tombstoned rows are hidden from normal use.
 *
 * A row is "visible to subject" when:
 *   - it isn't soft-deleted, AND
 *   - either it's self-authored (authored_by_user_id IS NULL OR = user_id),
 *     or the subject has accepted it (confirmed_at IS NOT NULL).
 *
 * Callers should AND this with any user- or room-scoping predicate.
 */
export function visibleToSubject(): SQL {
  return and(
    isNull(userMemories.deletedAt),
    or(
      isNull(userMemories.authoredByUserId),
      eq(userMemories.authoredByUserId, userMemories.userId),
      isNotNull(userMemories.confirmedAt)
    )
  )!;
}

/** The inverse: rows that are soft-deleted OR third-party-authored-and-not-yet-confirmed. Used for the "待确认" listing in /memories. */
export function pendingForSubject(): SQL {
  return and(
    isNull(userMemories.deletedAt),
    isNotNull(userMemories.authoredByUserId),
    // authored_by_user_id != user_id — we filter this in application code to
    // avoid referencing self-join semantics here. Callers should add it.
    isNull(userMemories.confirmedAt)
  )!;
}
