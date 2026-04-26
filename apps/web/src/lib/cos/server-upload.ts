import { createHash, createHmac, randomUUID } from "node:crypto";

/** Server-side Tencent COS PUT helper. The browser path goes through STS
 *  (apps/web/src/app/api/upload/sts/route.ts) because the long-lived
 *  SecretId/Key must never reach a client; here we run inside our trusted
 *  Next.js process for tool callbacks (e.g. generate_image), so the direct
 *  signing approach is fine and saves a round trip.
 *
 *  Signing follows COS V5: the algorithm doc lives at
 *  https://cloud.tencent.com/document/product/436/7778. */

interface CosConfig {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
}

function readConfig(): CosConfig {
  const cfg = {
    secretId: process.env.TENCENT_SECRET_ID || "",
    secretKey: process.env.TENCENT_SECRET_KEY || "",
    bucket: process.env.TENCENT_COS_BUCKET || "",
    region: process.env.TENCENT_COS_REGION || "",
  };
  if (!cfg.secretId || !cfg.secretKey || !cfg.bucket || !cfg.region) {
    throw new Error("COS not configured (TENCENT_SECRET_ID / KEY / BUCKET / REGION)");
  }
  return cfg;
}

function sha1Hex(input: string | Buffer): string {
  return createHash("sha1").update(input).digest("hex");
}

function hmacSha1Hex(key: string, msg: string): string {
  return createHmac("sha1", key).update(msg).digest("hex");
}

/** Build the `Authorization` header value for a single COS object op.
 *  Headers in `signedHeaders` MUST exactly match what gets sent on the
 *  wire — COS rejects on case / whitespace mismatches. */
function buildAuthorization(
  cfg: CosConfig,
  method: string,
  pathname: string,
  signedHeaders: Record<string, string>
): string {
  const now = Math.floor(Date.now() / 1000);
  const expires = now + 600;
  const keyTime = `${now};${expires}`;

  const signKey = hmacSha1Hex(cfg.secretKey, keyTime);

  const lc = Object.fromEntries(
    Object.entries(signedHeaders).map(([k, v]) => [k.toLowerCase(), v])
  );
  const headerKeys = Object.keys(lc).sort();
  const headerList = headerKeys.join(";");
  const headerString = headerKeys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(lc[k])}`)
    .join("&");

  const httpString = [
    method.toLowerCase(),
    pathname,
    "", // q-url-param-list is empty for our PUTs
    headerString,
    "",
  ].join("\n");

  const stringToSign = ["sha1", keyTime, sha1Hex(httpString), ""].join("\n");
  const signature = hmacSha1Hex(signKey, stringToSign);

  return [
    "q-sign-algorithm=sha1",
    `q-ak=${cfg.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    "q-url-param-list=",
    `q-signature=${signature}`,
  ].join("&");
}

export interface UploadResult {
  /** Public https URL of the uploaded object. The bucket is configured
   *  with public-read ACL (see infra/setup-server.sh + the existing
   *  /api/upload/sts flow). */
  url: string;
  key: string;
}

export interface UploadOptions {
  contentType: string;
  /** Path prefix inside the bucket. Final key = `${keyPrefix}/${yyyymm}/${uuid}.${ext}`. */
  keyPrefix: string;
  /** File extension without the dot (e.g. "png" / "jpg"). */
  ext: string;
}

/** PUT a buffer to COS. Throws on non-2xx. */
export async function uploadBufferToCos(
  buf: Buffer,
  opts: UploadOptions
): Promise<UploadResult> {
  const cfg = readConfig();

  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const key = `${opts.keyPrefix.replace(/^\/+|\/+$/g, "")}/${yyyymm}/${randomUUID()}.${opts.ext}`;
  const host = `${cfg.bucket}.cos.${cfg.region}.myqcloud.com`;
  const pathname = `/${key}`;

  // The host header isn't part of the signature on purpose — we only sign
  // content-type + content-length so the signed authorization survives
  // any proxy layer that mucks with Host.
  const signed: Record<string, string> = {
    "content-type": opts.contentType,
    "content-length": String(buf.length),
  };
  const authorization = buildAuthorization(cfg, "PUT", pathname, signed);

  // Web fetch's BodyInit doesn't accept a Node Buffer directly. Copy
  // into a fresh Uint8Array<ArrayBuffer> so the type is unambiguous and
  // we don't accidentally hand fetch a SharedArrayBuffer view.
  const body = new Uint8Array(buf.byteLength);
  body.set(buf);

  const res = await fetch(`https://${host}${pathname}`, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": opts.contentType,
      "Content-Length": String(buf.length),
    },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`COS PUT ${res.status}: ${detail.slice(0, 300)}`);
  }

  return { url: `https://${host}${pathname}`, key };
}
