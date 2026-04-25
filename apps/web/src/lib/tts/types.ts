/** Shared types for the TTS provider abstraction.
 *
 *  A provider takes a piece of text + a voice id and returns an async
 *  iterable of audio bytes (mp3 chunks). The frontend pipes those chunks
 *  into a MediaSource for streaming playback. AbortSignal is wired so
 *  the player can stop in flight when the user interrupts.
 */

export interface TTSVoice {
  /** Stable identifier the provider uses to address this voice. */
  id: string;
  /** Display name for the picker UI. */
  name: string;
  /** Provider this voice belongs to. Lets us validate that an agent's
   *  saved voice still matches the active provider. */
  provider: string;
  /** Optional gender / language hint for the picker grouping. */
  gender?: "male" | "female" | "neutral";
  language?: string;
}

export interface TTSRequest {
  text: string;
  voiceId?: string;
  signal?: AbortSignal;
}

export interface TTSProvider {
  readonly name: string;
  /** Stream an mp3 audio response chunk-by-chunk for `text`. The response
   *  is consumed through the returned ReadableStream so the frontend can
   *  start playback before generation finishes. */
  synthesize(req: TTSRequest): Promise<ReadableStream<Uint8Array>>;
  /** Static list of voices the provider exposes. Loaded once at boot;
   *  no need to refetch per request. */
  voices(): TTSVoice[];
}
