import type { Category, Importance, RelationshipKind } from "./types";

export const RECENT_LIMIT = 8;

export const KIND_LABELS: Record<RelationshipKind, string> = {
  spouse: "伴侣",
  family: "家人",
  colleague: "同事",
  friend: "朋友",
  custom: "其他",
};

export const CATEGORY_ORDER: Category[] = [
  "identity",
  "preference",
  "relationship",
  "event",
  "opinion",
  "context",
];

export const CATEGORY_LABELS: Record<Category, string> = {
  identity: "身份",
  preference: "偏好",
  relationship: "人际",
  event: "事件",
  opinion: "观点",
  context: "近况",
};

export const IMPORTANCE_LABELS: Record<Importance, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export const IMPORTANCE_COLORS: Record<Importance, string> = {
  high: "badge-error",
  medium: "badge-warning",
  low: "badge-ghost",
};
