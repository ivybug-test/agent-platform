/** Pull every http(s) URL out of a message body. Trailing CJK and ASCII
 *  punctuation gets stripped so "看看 https://example.com。" doesn't try
 *  to fetch "https://example.com。" as one URL. Returns up to 3 unique
 *  URLs per message — beyond that the cards take over the bubble. */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"]+/g) || [];
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    let u = raw;
    while (u.length > 0 && /[)\]\.,，。、;:!?！？]$/.test(u)) {
      u = u.slice(0, -1);
    }
    if (!u || seen.has(u)) continue;
    seen.add(u);
    cleaned.push(u);
    if (cleaned.length >= 3) break;
  }
  return cleaned;
}
