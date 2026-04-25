"use client";

import COS from "cos-js-sdk-v5";

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.8;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Compress an image file: scale long edge to MAX_EDGE, re-encode as JPEG.
 * Returns a Blob. If input is already small and a JPEG, returns as-is.
 */
export async function compressImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);

    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = (canvas as any).getContext("2d");
    if (!ctx) throw new Error("canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0, w, h);

    if (canvas instanceof OffscreenCanvas) {
      return await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
    }
    return await new Promise<Blob>((resolve, reject) => {
      (canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        "image/jpeg",
        JPEG_QUALITY
      );
    });
  } finally {
    bitmap.close?.();
  }
}

interface StsResponse {
  credentials: {
    tmpSecretId: string;
    tmpSecretKey: string;
    sessionToken: string;
  };
  startTime: number;
  expiredTime: number;
  bucket: string;
  region: string;
  key: string;
  publicUrl: string;
}

async function fetchSts(roomId: string): Promise<StsResponse> {
  const res = await fetch("/api/upload/sts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId }),
  });
  if (!res.ok) throw new Error(`STS request failed: ${res.status}`);
  return res.json();
}

/** Upload a blob to COS using STS temp credentials. Returns the public URL. */
export async function uploadToCOS(blob: Blob, roomId: string): Promise<string> {
  const sts = await fetchSts(roomId);

  const cos = new COS({
    getAuthorization: (_opts, callback) => {
      callback({
        TmpSecretId: sts.credentials.tmpSecretId,
        TmpSecretKey: sts.credentials.tmpSecretKey,
        SecurityToken: sts.credentials.sessionToken,
        StartTime: sts.startTime,
        ExpiredTime: sts.expiredTime,
      });
    },
  });

  await new Promise<void>((resolve, reject) => {
    cos.putObject(
      {
        Bucket: sts.bucket,
        Region: sts.region,
        Key: sts.key,
        Body: blob,
      },
      (err) => (err ? reject(err) : resolve())
    );
  });

  return sts.publicUrl;
}

export interface ImageMessageResult {
  id: string;
  senderType: string;
  senderId: string | null;
  senderName: string | null;
  content: string;
  contentType: string;
  createdAt: string;
  replyToMessageId?: string | null;
  replyTo?: {
    id: string;
    senderName: string | null;
    content: string;
    contentType?: string;
  } | null;
}

/** End-to-end: compress → upload to COS → persist image message on server. */
export async function sendImageMessage(
  file: File,
  roomId: string,
  replyToMessageId?: string | null
): Promise<ImageMessageResult> {
  if (!file.type.startsWith("image/")) throw new Error("not an image");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("file too large");

  const compressed = await compressImage(file);
  const imageUrl = await uploadToCOS(compressed, roomId);

  const res = await fetch("/api/messages/image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, imageUrl, replyToMessageId: replyToMessageId ?? null }),
  });
  if (!res.ok) throw new Error(`persist failed: ${res.status}`);
  const data = await res.json();
  return data.message;
}
