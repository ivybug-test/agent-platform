const lastRoomRequestTime = new Map<string, number>();
const RATE_LIMIT_MS = 3000;

/** Returns true if the request should be rate-limited */
export function isRateLimited(roomId: string): boolean {
  const now = Date.now();
  const lastTime = lastRoomRequestTime.get(roomId) || 0;
  if (now - lastTime < RATE_LIMIT_MS) return true;
  lastRoomRequestTime.set(roomId, now);
  return false;
}
