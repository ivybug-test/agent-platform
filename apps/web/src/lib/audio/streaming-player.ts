"use client";

/** Streaming TTS player.
 *
 *  Each `play()` call starts a fresh independent playback session — the
 *  previous one (if any) is aborted first. There is no queue and no
 *  resume: when the user interrupts, the in-flight audio is discarded
 *  and the next agent reply spawns a brand new session.
 *
 *  Implementation: <audio> + MediaSource Extensions + chunked fetch with
 *  AbortController. MSE lets us begin playback while bytes are still
 *  arriving from /api/tts. On unsupported browsers (older Safari) we
 *  fall back to "buffer the whole thing then play" — same UX, slightly
 *  worse latency.
 */

interface PlayOptions {
  /** Endpoint to POST against. Defaults to "/api/tts". */
  url?: string;
  /** JSON body forwarded to the endpoint (text + agentId / voiceId). */
  body: Record<string, unknown>;
  /** Optional callback fired when playback completes naturally (not on
   *  abort). Useful for the chat panel to clear the "playing" indicator. */
  onEnd?: () => void;
  /** Optional callback for hard errors. */
  onError?: (err: Error) => void;
}

export interface PlayHandle {
  /** Stop playback now and discard any buffered audio. Idempotent. */
  stop(): void;
  /** Resolves when playback completes naturally OR on stop / error. */
  donePromise: Promise<void>;
}

let currentHandle: PlayHandle | null = null;

/** Start streaming TTS playback. Aborts any prior session first.
 *  Returns a handle the caller can use to stop manually; the handle
 *  also auto-clears `currentHandle` when playback finishes. */
export function play(opts: PlayOptions): PlayHandle {
  // Cancel anything that's already playing — strict no-resume policy.
  if (currentHandle) {
    try {
      currentHandle.stop();
    } catch {}
    currentHandle = null;
  }

  const url = opts.url || "/api/tts";
  const ac = new AbortController();
  let stopped = false;
  let resolveDone: () => void;
  const donePromise = new Promise<void>((r) => {
    resolveDone = r;
  });

  // Hidden <audio> element appended to body. We keep it off-screen and
  // remove it on stop so a long session doesn't leak DOM nodes.
  const audio = document.createElement("audio");
  audio.style.cssText = "display:none";
  audio.autoplay = true;
  document.body.appendChild(audio);

  let mediaSource: MediaSource | null = null;
  let sourceBuffer: SourceBuffer | null = null;

  const cleanup = (notifyEnd: boolean) => {
    if (stopped) return;
    stopped = true;
    try {
      ac.abort();
    } catch {}
    try {
      audio.pause();
    } catch {}
    try {
      if (mediaSource && mediaSource.readyState === "open") {
        mediaSource.endOfStream();
      }
    } catch {}
    try {
      audio.removeAttribute("src");
      audio.load();
    } catch {}
    try {
      audio.remove();
    } catch {}
    if (currentHandle === handle) currentHandle = null;
    if (notifyEnd) opts.onEnd?.();
    resolveDone();
  };

  const handle: PlayHandle = {
    stop: () => cleanup(false),
    donePromise,
  };
  currentHandle = handle;

  audio.addEventListener("ended", () => cleanup(true));
  audio.addEventListener("error", () => {
    if (stopped) return;
    // MediaError.code values: 1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED.
    // ABORTED fires when something tore down the element mid-play (e.g. our
    // own cleanup raced ahead of this listener) — that's not a real error,
    // suppress it instead of toasting. The other three are genuine and we
    // surface the code + browser-supplied message so the toast tells us
    // whether this is decode / network / format. */
    const me = audio.error;
    if (me && me.code === MediaError.MEDIA_ERR_ABORTED) {
      cleanup(false);
      return;
    }
    const codeName =
      me?.code === MediaError.MEDIA_ERR_NETWORK
        ? "NETWORK"
        : me?.code === MediaError.MEDIA_ERR_DECODE
          ? "DECODE"
          : me?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            ? "SRC_NOT_SUPPORTED"
            : `code=${me?.code ?? "?"}`;
    const detail = me?.message ? ` ${me.message}` : "";
    opts.onError?.(new Error(`audio element error (${codeName})${detail}`));
    cleanup(false);
  });

  const supportsMse =
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported("audio/mpeg");

  // Kick off the fetch + decode pipeline. We don't await this — the
  // caller gets the handle synchronously and `donePromise` settles
  // when playback finishes or is aborted.
  (async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts.body),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        let detail = "";
        try {
          detail = await res.text();
        } catch {}
        throw new Error(`tts request failed: ${res.status} ${detail.slice(0, 200)}`);
      }

      if (supportsMse) {
        await playViaMse(res.body, audio, ac.signal, (ms, sb) => {
          mediaSource = ms;
          sourceBuffer = sb;
        });
      } else {
        // Fallback: buffer the whole stream then play. Worse latency
        // but every browser supports it.
        const buf = await new Response(res.body).arrayBuffer();
        if (stopped) return;
        const blob = new Blob([buf], { type: "audio/mpeg" });
        audio.src = URL.createObjectURL(blob);
      }
    } catch (err) {
      if (stopped) return;
      if ((err as { name?: string })?.name !== "AbortError") {
        opts.onError?.(err as Error);
      }
      cleanup(false);
    }
    void sourceBuffer; // referenced for future use; pleases the linter
  })();

  return handle;
}

/** Stop whatever's currently playing (if anything). Safe to call when
 *  nothing is active. Used by the chat panel on user interruption
 *  triggers (sending new message, switching room, toggling voice off). */
export function stopAll(): void {
  if (currentHandle) {
    try {
      currentHandle.stop();
    } catch {}
    currentHandle = null;
  }
}

async function playViaMse(
  body: ReadableStream<Uint8Array>,
  audio: HTMLAudioElement,
  signal: AbortSignal,
  onSetup: (ms: MediaSource, sb: SourceBuffer) => void
): Promise<void> {
  const mediaSource = new MediaSource();
  audio.src = URL.createObjectURL(mediaSource);

  const sourceBuffer: SourceBuffer = await new Promise((resolve, reject) => {
    const onOpen = () => {
      mediaSource.removeEventListener("sourceopen", onOpen);
      try {
        const sb = mediaSource.addSourceBuffer("audio/mpeg");
        resolve(sb);
      } catch (err) {
        reject(err);
      }
    };
    mediaSource.addEventListener("sourceopen", onOpen);
  });
  onSetup(mediaSource, sourceBuffer);

  const reader = body.getReader();
  const queue: Uint8Array[] = [];
  let appending = false;
  let inputDone = false;

  const drainQueue = () => {
    if (appending || queue.length === 0 || sourceBuffer.updating) return;
    const next = queue.shift()!;
    appending = true;
    try {
      // Copy into a fresh Uint8Array<ArrayBuffer> — TS won't accept
      // ArrayBufferLike (which includes SharedArrayBuffer) into the
      // BufferSource slot, but the runtime call is happy either way.
      const owned = new Uint8Array(next.byteLength);
      owned.set(next);
      sourceBuffer.appendBuffer(owned);
    } catch {
      appending = false;
    }
  };

  sourceBuffer.addEventListener("updateend", () => {
    appending = false;
    if (queue.length > 0) {
      drainQueue();
    } else if (inputDone && mediaSource.readyState === "open") {
      try {
        mediaSource.endOfStream();
      } catch {}
    }
  });

  while (true) {
    if (signal.aborted) {
      try {
        await reader.cancel();
      } catch {}
      return;
    }
    const { done, value } = await reader.read();
    if (done) {
      inputDone = true;
      // If everything has already drained, end the stream now;
      // otherwise the updateend handler above will close it.
      if (!appending && queue.length === 0 && mediaSource.readyState === "open") {
        try {
          mediaSource.endOfStream();
        } catch {}
      }
      return;
    }
    if (value && value.byteLength > 0) {
      queue.push(value);
      drainQueue();
    }
  }
}

/** Strip Markdown noise that doesn't read aloud well — fences, links,
 *  list bullets, headers. The TTS engine will pronounce e.g. "[link
 *  text](url)" verbatim if we don't pre-process. */
export function stripMarkdownForTts(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\[\[song:[^\]]*\]\]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
