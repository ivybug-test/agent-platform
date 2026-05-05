import { useCallback, useEffect, useRef, useState } from "react";
import {
  play as playTts,
  stopAll as stopAllTts,
} from "@/lib/audio/streaming-player";

function ttsErrorLabel(raw: string): string {
  if (/2061|plan/i.test(raw)) return "TTS 套餐未开通或当日配额已满";
  if (/2049|api key|invalid.*key/i.test(raw)) return "TTS 鉴权失败";
  if (/429|rate/i.test(raw)) return "TTS 频率被限，稍后再试";
  if (/502|503|504|timeout/i.test(raw)) return "TTS 服务暂时无响应";
  return "TTS 失败：" + raw.replace(/^.*?:\s*/, "").slice(0, 60);
}

/** Click-to-play TTS for the agent's `speak` tool output. Only one
 *  bubble plays at a time; clicking another (or the playing one) calls
 *  stopAll first. Switching rooms kills any audio in flight. */
export function useTTSPlayer(roomId: string) {
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  // Tracks which agent we're chatting with (for /api/tts agentId param).
  // Populated from the first agent message we see; chat already enforces
  // single-agent-per-room so this is stable.
  const agentIdRef = useRef<string | null>(null);

  // Auto-dismiss error toast after 4s.
  useEffect(() => {
    if (!ttsError) return;
    const t = setTimeout(() => setTtsError(null), 4000);
    return () => clearTimeout(t);
  }, [ttsError]);

  // NOTE: deps are intentionally empty to match the pre-refactor handler.
  // The early-return on `playingMessageId === messageId` reads a stale
  // null at memo time so it never short-circuits in practice — clicking
  // the playing bubble restarts playback rather than pausing. Preserved
  // verbatim until someone explicitly chooses to fix the UX.
  const toggleAudioPlayback = useCallback(
    (messageId: string, text: string, voiceId?: string) => {
      if (playingMessageId === messageId) {
        stopAllTts();
        setPlayingMessageId(null);
        return;
      }
      stopAllTts();
      setPlayingMessageId(messageId);
      setTtsError(null);
      playTts({
        body: {
          text,
          agentId: agentIdRef.current,
          ...(voiceId ? { voiceId } : {}),
        },
        onEnd: () => {
          setPlayingMessageId((cur) => (cur === messageId ? null : cur));
        },
        onError: (err) => {
          setPlayingMessageId((cur) => (cur === messageId ? null : cur));
          const raw = err?.message || String(err);
          if (/abort/i.test(raw)) return;
          setTtsError(ttsErrorLabel(raw));
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Switching room kills any audio in flight. Same on unmount.
  useEffect(() => {
    if (!roomId) return;
    stopAllTts();
    setPlayingMessageId(null);
  }, [roomId]);
  useEffect(() => {
    return () => {
      stopAllTts();
    };
  }, []);

  return {
    playingMessageId,
    setPlayingMessageId,
    ttsError,
    setTtsError,
    agentIdRef,
    toggleAudioPlayback,
  };
}
