import type { TTSProvider, TTSRequest, TTSVoice } from "./types";
import { MOCK_VOICES } from "./voices";

/** Mock provider used when MINIMAX_API_KEY is missing. Emits a 1.2s
 *  silent mp3 split into a few chunks with small delays so the
 *  streaming-player UI exercise its full happy path without burning
 *  real provider quota during dev. */

// 1.2-second silent mp3 (44.1kHz mono, ~0.4KB per 200ms frame). Encoded
// once at module-load time so the array buffer is reused across calls.
// Bytes copied from a known-good silent mp3.
const SILENT_MP3_BASE64 =
  "/+MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV" +
  "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV" +
  "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

function silentBuffer(): Uint8Array {
  const buf = Buffer.from(SILENT_MP3_BASE64, "base64");
  return new Uint8Array(buf);
}

const SILENT_BYTES = silentBuffer();

export const mockProvider: TTSProvider = {
  name: "mock",
  voices(): TTSVoice[] {
    return MOCK_VOICES;
  },
  async synthesize(req: TTSRequest): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        // Fragment the mock buffer into ~4 chunks so the player exercises
        // its append-buffer loop. If the caller aborts mid-stream we exit
        // cleanly instead of pushing more bytes into a dead controller.
        const chunkCount = 4;
        const size = Math.ceil(SILENT_BYTES.byteLength / chunkCount);
        for (let i = 0; i < chunkCount; i++) {
          if (req.signal?.aborted) break;
          const start = i * size;
          const end = Math.min(start + size, SILENT_BYTES.byteLength);
          if (start >= end) break;
          controller.enqueue(SILENT_BYTES.slice(start, end));
          await new Promise((r) => setTimeout(r, 80));
        }
        controller.close();
      },
    });
  },
};
