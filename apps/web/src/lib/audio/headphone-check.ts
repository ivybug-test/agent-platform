"use client";

/** Best-effort detection of whether the device's currently selected audio
 *  output is a pair of headphones (or similar private listening device)
 *  vs a built-in / external speaker.
 *
 *  Returns:
 *    true  — headphones likely connected, or we can't tell (default-play
 *            so a permissive failure mode doesn't trap users in silence)
 *    false — definitely playing through a speaker
 *
 *  Implementation uses `enumerateDevices()`, which only exposes useful
 *  device labels AFTER the page has been granted some media permission;
 *  on browsers / sessions that haven't (iOS Safari without prior
 *  microphone use is the common case) the labels come back as empty
 *  strings and we treat that as "unknown" → return true. The user
 *  toggle in /me is the authoritative gate; this function is just the
 *  best inference we can make from inside the browser sandbox.
 */
const HEADPHONE_LABEL_RE =
  /headphone|headset|airpods|earphone|earbuds|bluetooth|耳机|蓝牙|有线/i;

export async function isHeadphonesConnected(): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.enumerateDevices
  ) {
    return true;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    if (outputs.length === 0) return true;
    // If at least one output device's label clearly says "headphones"
    // (and that's the default selection on most browsers), trust it.
    // If labels are empty across the board we can't tell — return true.
    const hasLabels = outputs.some((d) => d.label && d.label.length > 0);
    if (!hasLabels) return true;
    return outputs.some((d) => HEADPHONE_LABEL_RE.test(d.label));
  } catch {
    return true;
  }
}
