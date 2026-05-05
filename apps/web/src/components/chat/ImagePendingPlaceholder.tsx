import { useEffect, useState } from "react";

/** Spinner card shown while async generate_image is in flight. Reads
 *  the phase / prompt from imageGen metadata; ticks an elapsed-second
 *  counter once a second so the user can see something is moving even
 *  if phase updates from the server are sparse / blocked by realtime-
 *  gateway being down. */
export default function ImagePendingPlaceholder({
  prompt,
  phase,
  startedAt,
}: {
  prompt?: string;
  phase?: string;
  startedAt?: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = startedAt ? new Date(startedAt).getTime() : Date.now();
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <div className="flex flex-col gap-1.5 w-[220px] min-h-[140px] rounded bg-base-100/40 border border-dashed border-base-content/30 px-3 py-2.5 text-xs opacity-90">
      <div className="flex items-center gap-2">
        <span className="loading loading-spinner loading-sm"></span>
        <span className="font-medium">{phase || "生成中"}</span>
        <span className="ml-auto opacity-60">{elapsed}s</span>
      </div>
      {prompt && (
        <div className="opacity-70 leading-snug line-clamp-3 text-[11px]">
          🎨 {prompt}
        </div>
      )}
    </div>
  );
}
