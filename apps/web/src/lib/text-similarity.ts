/**
 * Character-bigram Jaccard similarity. Works for CJK and English alike.
 * Returns 0..1 — identical bigram multisets = 1.
 *
 * `lowercase` defaults to true so "Hello" and "hello" collide. Pass
 * `false` for purely-CJK signal where lowercasing is wasted work and
 * any future ASCII bleed-in should still be case-sensitive.
 */
export function textSimilarity(
  a: string,
  b: string,
  opts: { lowercase?: boolean } = {}
): number {
  const lowercase = opts.lowercase ?? true;
  const bigrams = (s: string): Map<string, number> => {
    const normalized = lowercase ? s.toLowerCase() : s;
    const chars = [...normalized.replace(/\s+/g, "")];
    const map = new Map<string, number>();
    for (let i = 0; i < chars.length - 1; i++) {
      const bg = chars[i] + chars[i + 1];
      map.set(bg, (map.get(bg) || 0) + 1);
    }
    return map;
  };
  const bgA = bigrams(a);
  const bgB = bigrams(b);
  let intersection = 0;
  let union = 0;
  const allKeys = new Set([...bgA.keys(), ...bgB.keys()]);
  for (const k of allKeys) {
    const ca = bgA.get(k) || 0;
    const cb = bgB.get(k) || 0;
    intersection += Math.min(ca, cb);
    union += Math.max(ca, cb);
  }
  return union === 0 ? 0 : intersection / union;
}
