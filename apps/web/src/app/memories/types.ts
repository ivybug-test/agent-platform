export type Category =
  | "identity"
  | "preference"
  | "relationship"
  | "event"
  | "opinion"
  | "context";
export type Importance = "high" | "medium" | "low";
export type Source = "extracted" | "user_explicit";
export type Tab = "mine" | "pending" | "relationships";

export type RelationshipKind =
  | "spouse"
  | "family"
  | "colleague"
  | "friend"
  | "custom";

export interface Memory {
  id: string;
  content: string;
  category: Category;
  importance: Importance;
  source: Source;
  createdAt: string;
  updatedAt: string;
  lastReinforcedAt: string | null;
  authoredByUserId: string | null;
  confirmedAt: string | null;
  authoredByName?: string | null;
}

export interface RelationshipRow {
  id: string;
  kind: RelationshipKind;
  content: string | null;
  createdAt: string;
  other: { id: string; name: string; email: string };
}

export interface FriendRow {
  id: string;
  status: string;
  direction: "mutual" | "incoming" | "outgoing";
  friend: { id: string; name: string; email: string };
}

export interface FriendOption {
  id: string;
  name: string;
}
