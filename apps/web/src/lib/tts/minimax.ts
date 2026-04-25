import type { TTSProvider, TTSRequest, TTSVoice } from "./types";
import { MINIMAX_VOICES } from "./voices";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("web");

const DEFAULT_VOICE_ID = "female-yujie";

/** MiniMax T2A V2 streaming endpoint. Returns audio chunks via Server-Sent
 *  Events — each event has `audio` field with hex-encoded bytes. We unwrap
 *  the SSE stream and emit raw mp3 bytes for the browser MediaSource to
 *  consume.
 *
 *  Docs: https://www.minimaxi.com/document/guides/t2a-v2-stream
 *  API:  https://api.minimax.chat/v1/t2a_v2 (set group_id query param)
 */
export const minimaxProvider: TTSProvider = {
  name: "minimax",

  voices(): TTSVoice[] {
    return MINIMAX_VOICES;
  },

  async synthesize(req: TTSRequest): Promise<ReadableStream<Uint8Array>> {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey) {
      throw new Error("MINIMAX_API_KEY not configured");
    }
    const baseUrl =
      process.env.MINIMAX_BASE_URL || "https://api.minimax.chat/v1";

    const voiceId = req.voiceId || DEFAULT_VOICE_ID;
    // Newer accounts authenticate purely via the bearer key; the old
    // GroupId query parameter is only required for legacy provisioning.
    const groupId = process.env.MINIMAX_GROUP_ID;
    const url = groupId
      ? `${baseUrl}/t2a_v2?GroupId=${encodeURIComponent(groupId)}`
      : `${baseUrl}/t2a_v2`;

    // Model id matrix (April 2026):
    //   speech-2.8-hd       — Plus 标准版（"Speech 2.8" in marketing copy）
    //   speech-2.8-turbo    — Plus 极速版
    //   speech-02-hd        — Max 标准版
    //   speech-02-turbo     — Max 极速版 / pay-per-call legacy
    // Pick the one your token plan covers via MINIMAX_TTS_MODEL.
    const model = process.env.MINIMAX_TTS_MODEL || "speech-2.8-hd";

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        text: req.text,
        stream: true,
        voice_setting: {
          voice_id: voiceId,
          speed: 1.0,
          vol: 1.0,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: "mp3",
          channel: 1,
        },
      }),
      signal: req.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      throw new Error(`minimax ${upstream.status}: ${text.slice(0, 200)}`);
    }

    // MiniMax loves to return 200 OK with an error encoded in the JSON
    // body (auth failures, plan-doesn't-support-model, parameter errors
    // all come back as 200 + base_resp.status_code != 0). The streaming
    // SSE happy path uses Content-Type text/event-stream — anything else
    // is an error envelope we should surface immediately, not pipe into
    // the audio decoder where it'll become silent gibberish.
    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.includes("event-stream")) {
      const text = await upstream.text().catch(() => "");
      try {
        const parsed = JSON.parse(text) as {
          base_resp?: { status_code?: number; status_msg?: string };
        };
        const code = parsed.base_resp?.status_code;
        const msg = parsed.base_resp?.status_msg || "unknown";
        if (typeof code === "number" && code !== 0) {
          throw new Error(`minimax ${code}: ${msg}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("minimax ")) throw err;
      }
      throw new Error(`minimax unexpected response: ${text.slice(0, 200)}`);
    }

    return upstream.body.pipeThrough(makeSseAudioTransformer());
  },
};

/** Decode MiniMax's SSE event stream into raw mp3 bytes.
 *
 *  Each SSE chunk looks like `data: {"data":{"audio":"<hex>"},...}\n\n`.
 *  We pull `audio` (hex string), convert to bytes, and emit. The final
 *  event has `is_final: true` and no audio. */
function makeSseAudioTransformer(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const evt = JSON.parse(payload) as {
            data?: { audio?: string };
            is_final?: boolean;
          };
          const hex = evt.data?.audio;
          if (hex) {
            const bytes = hexToBytes(hex);
            if (bytes.byteLength > 0) controller.enqueue(bytes);
          }
        } catch (err) {
          log.warn(
            { err: (err as Error)?.message, line: line.slice(0, 100) },
            "minimax.sse-parse-error"
          );
        }
      }
    },
  });
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 1 ? "0" + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.substr(i, 2), 16);
  }
  return out;
}
