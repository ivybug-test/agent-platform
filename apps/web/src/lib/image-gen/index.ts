/** Image-generation client. Three real-world API shapes are supported,
 *  flipped via `IMAGE_GEN_PROVIDER`:
 *
 *    1. `openai` (default) — Nano Banana via OpenAI-compatible chat-
 *       completions with `modalities`. POST {BASE}/chat/completions, body
 *       { model, modalities:["image","text"], messages:[{role:"user",
 *       content:prompt}] }. Image lands at
 *       `choices[0].message.images[0].image_url.url` as a data URL.
 *       OpenRouter and most Chinese resellers (kie.ai / laozhang /
 *       banana2api / etc) mirror this shape.
 *
 *    2. `google` — Direct Gemini API. POST {BASE}/models/{model}:
 *       generateContent with header `x-goog-api-key: KEY`, body
 *       { contents:[…], generationConfig:{responseModalities:["TEXT",
 *       "IMAGE"]}}. Image bytes are base64 in
 *       `candidates[0].content.parts[].inlineData.data`.
 *
 *    3. `volc` — OpenAI-standard /images/generations shape. POST {BASE}/
 *       images/generations, body { model, prompt, size, response_format
 *       }. Returns `data[0].url` (default) or `data[0].b64_json`. This
 *       covers Volcengine Ark / Doubao Seedream (set base to
 *       https://ark.cn-beijing.volces.com/api/v3 + model
 *       doubao-seedream-4-0-…) AND DALL-E AND most generic OpenAI-
 *       images resellers in one branch — Doubao isn't Nano Banana, it's
 *       Seedream, and the request shape is just standard OpenAI images.
 *
 *  Pick by what your key supports; the rest of the tool (COS upload,
 *  message insert, broadcast) doesn't care which provider produced the
 *  bytes. */

interface ImageGenResult {
  bytes: Buffer;
  mimeType: string;
  /** Whatever text the model returned alongside the image. Often empty,
   *  but some providers include a one-line description. The tool surfaces
   *  this back to the agent so its reply can avoid contradicting it. */
  modelText: string;
}

function readEnv() {
  const apiKey = process.env.IMAGE_GEN_API_KEY;
  if (!apiKey) throw new Error("IMAGE_GEN_API_KEY not configured");
  const provider = (process.env.IMAGE_GEN_PROVIDER || "openai").toLowerCase();

  const defaultBase =
    provider === "google"
      ? "https://generativelanguage.googleapis.com/v1beta"
      : provider === "volc"
        ? "https://ark.cn-beijing.volces.com/api/v3"
        : "https://openrouter.ai/api/v1";
  const baseUrl = (process.env.IMAGE_GEN_BASE_URL || defaultBase).replace(/\/+$/, "");

  const defaultModel =
    provider === "google"
      ? "gemini-2.5-flash-image-preview"
      : provider === "volc"
        ? // Doubao Seedream 5.0 lite is the cheapest tier, ample for
          // chat-bubble image gen. Override IMAGE_GEN_MODEL to swap to
          // Pro / Max if the account has them activated. Find the exact
          // model id (with date suffix) on the Ark console "model card"
          // — the date can shift across releases.
          "doubao-seedream-5-0-lite-250928"
        : "google/gemini-2.5-flash-image-preview";
  const model = process.env.IMAGE_GEN_MODEL || defaultModel;

  // Volc / DALL-E need a `size`; Nano Banana derives from prompt.
  // Doubao Seedream is case-sensitive — accepts lowercase "2k" / "3k" /
  // "4k" or "WIDTHxHEIGHT" (pixels). DALL-E uses pixel form so the
  // user is expected to override IMAGE_GEN_SIZE for that backend.
  const size = process.env.IMAGE_GEN_SIZE || "2k";
  return { apiKey, provider, baseUrl, model, size };
}

/** Decode a `data:image/<type>;base64,<payload>` URL into raw bytes. */
function decodeDataUrl(dataUrl: string): { bytes: Buffer; mimeType: string } {
  const m = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/);
  if (!m) throw new Error("malformed data URL");
  const mimeType = m[1] || "image/png";
  const isBase64 = !!m[2];
  const payload = m[3];
  const bytes = isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  return { bytes, mimeType };
}

async function fetchRemoteImage(url: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  const arr = new Uint8Array(await res.arrayBuffer());
  return {
    bytes: Buffer.from(arr),
    mimeType: res.headers.get("content-type") || "image/png",
  };
}

async function callOpenAIChat(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string
): Promise<ImageGenResult> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`image-gen ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json().catch(() => null)) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
        images?: Array<{ image_url?: { url?: string }; url?: string }>;
      };
    }>;
  } | null;

  const msg = json?.choices?.[0]?.message;
  const imageEntry = msg?.images?.[0];
  const url = imageEntry?.image_url?.url || imageEntry?.url;
  if (!url) throw new Error("image-gen: response missing image (choices[0].message.images[0])");

  const modelText =
    typeof msg?.content === "string"
      ? msg.content
      : Array.isArray(msg?.content)
        ? msg.content
            .filter((p) => p?.type === "text" && typeof p.text === "string")
            .map((p) => p.text!)
            .join("")
        : "";

  const { bytes, mimeType } = url.startsWith("data:")
    ? decodeDataUrl(url)
    : await fetchRemoteImage(url);
  return { bytes, mimeType, modelText };
}

async function callGoogleDirect(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string
): Promise<ImageGenResult> {
  const res = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`image-gen ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json().catch(() => null)) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          inlineData?: { mimeType?: string; data?: string };
        }>;
      };
    }>;
  } | null;

  const parts = json?.candidates?.[0]?.content?.parts || [];
  const inline = parts.find((p) => p.inlineData?.data);
  if (!inline?.inlineData?.data) {
    throw new Error("image-gen: response missing inlineData.data");
  }
  const bytes = Buffer.from(inline.inlineData.data, "base64");
  const mimeType = inline.inlineData.mimeType || "image/png";
  const modelText = parts
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text!)
    .join("");
  return { bytes, mimeType, modelText };
}

/** Volcengine Ark / Doubao Seedream / OpenAI DALL-E / generic
 *  /v1/images/generations resellers all share this shape. The model
 *  defaults to `url` for response_format because base64 in JSON is
 *  ~33% bigger and Doubao's URLs live for 24h which is plenty for our
 *  same-request flow (we re-host to COS immediately). */
async function callImagesGenerations(
  apiKey: string,
  baseUrl: string,
  model: string,
  size: string,
  prompt: string,
  referenceImages: string[],
  signal?: AbortSignal
): Promise<ImageGenResult> {
  // Doubao Seedream's image-to-image / multi-reference path is a
  // top-level `image` field on the same /images/generations endpoint —
  // string for a single ref, array for multi-ref fusion. DALL-E doesn't
  // support reference images on this endpoint, so when a non-Doubao
  // provider is configured under `volc` we silently drop the refs
  // (model would 400 otherwise). Practical effect: this branch is
  // image-to-image-capable only when pointed at Doubao.
  const body: Record<string, unknown> = {
    model,
    prompt,
    size,
    response_format: "url",
    n: 1,
  };
  if (referenceImages.length === 1) {
    body.image = referenceImages[0];
  } else if (referenceImages.length > 1) {
    body.image = referenceImages;
  }

  const res = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`image-gen ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json().catch(() => null)) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  } | null;
  const entry = json?.data?.[0];
  if (!entry) throw new Error("image-gen: response missing data[0]");

  if (entry.url) {
    const fetched = await fetchRemoteImage(entry.url);
    return { ...fetched, modelText: "" };
  }
  if (entry.b64_json) {
    return {
      bytes: Buffer.from(entry.b64_json, "base64"),
      mimeType: "image/png",
      modelText: "",
    };
  }
  throw new Error("image-gen: data[0] has neither url nor b64_json");
}

export interface GenerateImageOptions {
  referenceImages?: string[];
  /** Caller cancels in-flight gen via AbortController.signal — fetch
   *  picks it up and rejects with AbortError. Wired through only the
   *  volc path for now (the only one we run async/cancellable in
   *  practice via image-tools.ts); other paths ignore. */
  signal?: AbortSignal;
}

export async function generateImage(
  prompt: string,
  opts?: GenerateImageOptions
): Promise<ImageGenResult> {
  if (!prompt || !prompt.trim()) throw new Error("prompt is required");
  const refs = opts?.referenceImages || [];
  const { apiKey, provider, baseUrl, model, size } = readEnv();
  if (provider === "google") {
    if (refs.length > 0) {
      throw new Error("image-to-image not implemented for google direct");
    }
    return callGoogleDirect(apiKey, baseUrl, model, prompt);
  }
  if (provider === "volc") {
    return callImagesGenerations(apiKey, baseUrl, model, size, prompt, refs, opts?.signal);
  }
  if (refs.length > 0) {
    throw new Error("image-to-image not implemented for openai chat");
  }
  return callOpenAIChat(apiKey, baseUrl, model, prompt);
}
