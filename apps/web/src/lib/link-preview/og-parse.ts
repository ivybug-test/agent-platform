/** Lightweight HTML metadata extractor.
 *
 *  Pulls the standard set of preview-card fields out of a page's static
 *  HTML — works on most news sites, blogs, docs, GitHub. Pages that render
 *  their content via JavaScript (SPAs like QQ Music) usually still ship a
 *  decent OG block in their static HTML; if not, a host-specific adapter
 *  (see ./qq-music.ts) takes over.
 */

export interface PreviewMeta {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
}

// Match `<meta property="og:title" content="..." />` and the
// `content="..." property="og:title"` ordering. HTML attributes can be
// single- or double-quoted.
function metaContent(html: string, key: string, attr: "name" | "property"): string | undefined {
  const re = new RegExp(
    `<meta\\b[^>]*\\b${attr}\\s*=\\s*['"]${key}['"][^>]*\\bcontent\\s*=\\s*['"]([^'"]+)['"]`,
    "i"
  );
  const re2 = new RegExp(
    `<meta\\b[^>]*\\bcontent\\s*=\\s*['"]([^'"]+)['"][^>]*\\b${attr}\\s*=\\s*['"]${key}['"]`,
    "i"
  );
  return html.match(re)?.[1] || html.match(re2)?.[1];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function resolveUrl(maybeRelative: string | undefined, base: string): string | undefined {
  if (!maybeRelative) return undefined;
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return undefined;
  }
}

/** Parse the head of an HTML document into a normalized preview record. */
export function parseHtmlMeta(html: string, baseUrl: string): PreviewMeta {
  const og = (key: string) => metaContent(html, `og:${key}`, "property");
  const tw = (key: string) => metaContent(html, `twitter:${key}`, "name");
  const name = (key: string) => metaContent(html, key, "name");

  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const title = og("title") || tw("title") || titleTag;

  const description =
    og("description") || tw("description") || name("description");

  const image = og("image") || tw("image") || tw("image:src");

  const siteName = og("site_name");

  // <link rel="icon" href="..."> or <link rel="shortcut icon">
  const iconHref =
    html.match(
      /<link\b[^>]*\brel\s*=\s*['"](?:shortcut\s+)?icon['"][^>]*\bhref\s*=\s*['"]([^'"]+)['"]/i
    )?.[1] ||
    html.match(
      /<link\b[^>]*\bhref\s*=\s*['"]([^'"]+)['"][^>]*\brel\s*=\s*['"](?:shortcut\s+)?icon['"]/i
    )?.[1];

  const baseHost = (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return baseUrl;
    }
  })();

  return {
    title: title ? decodeEntities(title).slice(0, 200) : undefined,
    description: description
      ? decodeEntities(description).slice(0, 400)
      : undefined,
    image: resolveUrl(image, baseUrl),
    siteName: siteName ? decodeEntities(siteName).slice(0, 80) : undefined,
    favicon: resolveUrl(iconHref, baseUrl) || `${baseHost}/favicon.ico`,
  };
}
