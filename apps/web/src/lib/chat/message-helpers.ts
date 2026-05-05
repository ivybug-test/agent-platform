const bubbleColors = [
  "chat-bubble-primary",
  "chat-bubble-secondary",
  "chat-bubble-accent",
  "chat-bubble-warning",
  "chat-bubble-error",
  "chat-bubble-info",
];

export function colorForUser(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return bubbleColors[Math.abs(hash) % bubbleColors.length];
}

export function isImageMessage(msg: {
  content: string;
  contentType?: string;
}): boolean {
  if (msg.contentType === "image") return true;
  return /^https:\/\/[^\s]+\.myqcloud\.com\/[^\s]+\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(
    msg.content
  );
}

/** Generate a uuid v4. Prefers crypto.randomUUID (cryptographically
 *  random, ~zero collision risk) but falls back to a Math.random-built
 *  v4 when the page runs in an INSECURE CONTEXT — `crypto.randomUUID`
 *  is gated on HTTPS-or-localhost, so accessing the dev server via an
 *  http:// LAN IP / proxy hostname makes the call throw. The fallback
 *  is fine because message ids are persisted but never used as auth /
 *  capability tokens; a chance collision on Math.random is laughably
 *  smaller than the risk of breaking the send button. */
export function makeMessageId(): string {
  const c = typeof crypto !== "undefined" ? crypto : null;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // Fall through.
    }
  }
  const bytes = new Array(16).fill(0).map(() => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
