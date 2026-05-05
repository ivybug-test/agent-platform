import { textSimilarity } from "@/lib/text-similarity";
import { formatShortWallClock } from "./prompts/format-helpers";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("web");

export interface ContextMessage {
  id?: string;
  senderType: string;
  senderId: string | null;
  content: string;
  contentType?: string | null;
  createdAt?: Date | string | null;
  metadata?: {
    vision?: { caption?: string };
    /** Set when the agent called the speak tool. Drives rule #10's
     *  retroactive [平台备注] detection of fake-tool-use claims. */
    audio?: { text: string; voiceId?: string };
  } | null;
  replyToMessageId?: string | null;
}

type LLMTextPart = { type: "text"; text: string };
type LLMImagePart = { type: "image_url"; image_url: { url: string } };
export type LLMContentPart = LLMTextPart | LLMImagePart;
export type LLMMessageContent = string | LLMContentPart[];

/**
 * Deduplicate context messages: when multiple agent responses are highly similar,
 * keep only the most recent one. This prevents the LLM from seeing repetitive
 * context and producing repetitive output.
 */
function deduplicateContext(msgs: ContextMessage[]): ContextMessage[] {
  // Collect all agent message contents (with index) for similarity checking
  const agentEntries = msgs
    .map((m, i) => ({ index: i, content: m.content }))
    .filter((_, i) => msgs[i].senderType === "agent");

  // Find agent messages that are too similar to a LATER agent message
  const skipIndices = new Set<number>();
  for (let i = 0; i < agentEntries.length; i++) {
    for (let j = i + 1; j < agentEntries.length; j++) {
      // Skip lowercasing — context dedup is CJK-dominant; preserves
      // pre-consolidation behavior bit-for-bit.
      if (
        textSimilarity(agentEntries[i].content, agentEntries[j].content, {
          lowercase: false,
        }) > 0.4
      ) {
        // Keep the later one (j), mark the earlier one (i) for removal
        skipIndices.add(agentEntries[i].index);
        break;
      }
    }
  }

  // Also skip the user message right before a skipped agent message
  // (to keep user→agent pairs coherent)
  const skipWithContext = new Set<number>();
  for (const idx of skipIndices) {
    skipWithContext.add(idx);
    if (idx > 0 && msgs[idx - 1].senderType === "user") {
      skipWithContext.add(idx - 1);
    }
  }

  const result = msgs.filter((_, i) => !skipWithContext.has(i));
  if (skipIndices.size > 0) {
    log.info(
      {
        before: msgs.length,
        after: result.length,
        removedAgent: skipIndices.size,
      },
      "context.dedup"
    );
  }
  return result;
}

/** Build messages array for LLM.
 *
 *  Each user/assistant line is prefixed with a compact [YYYY-MM-DD HH:mm]
 *  timestamp so the agent sees time flow in the recent window — not just
 *  the one "Current time" anchor in the system prompt. If more than 6 hours
 *  have elapsed between the most recent message and now, we append a short
 *  note to the system prompt so the agent can acknowledge the gap naturally
 *  ("好久不见" etc) rather than responding as if no time passed.
 */
export function buildLLMMessages(
  systemContent: string,
  recentMessages: ContextMessage[],
  nameMap: Map<string, string>
) {
  const filtered = deduplicateContext(recentMessages);

  // Gap-since-last-message note. Threshold of 6h catches overnight / days-apart
  // sessions without triggering on normal back-and-forth chatting.
  let systemWithGap = systemContent;
  if (filtered.length > 0) {
    const last = filtered[filtered.length - 1];
    const lastTs = last.createdAt ? new Date(last.createdAt).getTime() : NaN;
    if (!isNaN(lastTs)) {
      const gapMs = Date.now() - lastTs;
      if (gapMs > 6 * 3600 * 1000) {
        const hours = gapMs / 3600000;
        const note =
          hours < 48
            ? `Note: about ${Math.round(hours)} hours have passed since the last message in this room.`
            : `Note: about ${Math.round(hours / 24)} days have passed since the last message in this room.`;
        systemWithGap = `${systemContent}\n\n${note}`;
      }
    }
  }

  // Number images by their order of appearance in the window so the agent
  // can disambiguate references like "图2 是什么" / "上面那张图" — without
  // numbering it has to guess which image when several share the window.
  let imageSeq = 0;

  // Map id → ContextMessage for resolving in-window quote targets. If a
  // user replies to a message that's still in the window we render a
  // structured "> [quote]" prefix so the agent can pinpoint it.
  const byId = new Map<string, ContextMessage>();
  for (const m of filtered) if (m.id) byId.set(m.id, m);

  // Sequence number assigned to images by appearance order; reused when a
  // reply targets one of those images so the quote prefix says "图片#N".
  const imageSeqByMessageId = new Map<string, number>();
  let probe = 0;
  for (const m of filtered) {
    if (m.contentType === "image" && m.id) {
      probe += 1;
      imageSeqByMessageId.set(m.id, probe);
    }
  }

  function quotePrefix(replyId: string): string {
    const target = byId.get(replyId);
    if (!target) {
      // Quote target scrolled out of the window — keep the signal that the
      // user explicitly referenced an earlier message but don't make up
      // content the agent can't see.
      return `> [回复了一条更早的消息（已超出最近窗口）]\n`;
    }
    const targetName = target.senderId
      ? nameMap.get(target.senderId) ||
        (target.senderType === "agent" ? "agent" : "User")
      : target.senderType === "agent"
        ? "agent"
        : "User";
    let preview: string;
    if (target.contentType === "image") {
      // Stay consistent with the inline marker: identify by N + msgId.
      // Image quotes carry no caption — agent calls read_image if it
      // wants to know what's in there.
      const seq = imageSeqByMessageId.get(replyId);
      preview = `图片#${seq ?? "?"}`;
    } else {
      const oneLine = (target.content || "").replace(/\s+/g, " ").trim();
      preview = oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
    }
    return `> [回复 ${targetName} (msgId=${replyId}): ${preview}]\n`;
  }

  return [
    { role: "system" as const, content: systemWithGap as LLMMessageContent },
    ...filtered.map((m) => {
      if (m.senderType === "user") {
        // Timestamp prefix is applied to user messages only. Putting it on
        // assistant messages causes the LLM to mimic the pattern and emit
        // "[YYYY-MM-DD HH:mm] ..." at the start of its own replies.
        const tsPrefix = m.createdAt
          ? `[${formatShortWallClock(new Date(m.createdAt))}] `
          : "";
        const name = m.senderId ? nameMap.get(m.senderId) || "User" : "User";
        const qPrefix = m.replyToMessageId
          ? quotePrefix(m.replyToMessageId)
          : "";
        const idPrefix = m.id ? `(msgId=${m.id}) ` : "";
        if (m.contentType === "image" && m.content) {
          // Image bytes never reach the chat LLM. Inline a bare marker
          // with the message id; the agent calls `read_image(messageId)`
          // when it actually wants to know what's in the image.
          imageSeq += 1;
          const visionText = `[图片#${imageSeq} (msgId=${m.id})]`;
          return {
            role: "user" as const,
            content:
              `${qPrefix}${tsPrefix}${idPrefix}${name}: ${visionText}` as LLMMessageContent,
          };
        }
        return {
          role: "user" as const,
          content:
            `${qPrefix}${tsPrefix}${idPrefix}${name}: ${m.content}` as LLMMessageContent,
        };
      }
      // Agent's own past replies stay clean — leading metadata on an
      // assistant turn is the kind of thing the LLM mimics in its next
      // reply ("(msgId=...) ..." would leak into output).
      //
      // EXCEPTION: tool-use hallucination detox. If a past assistant turn
      // wrote phrases that PRESUPPOSE a tool ran (🔊 / 听语音版 / etc) but
      // the matching metadata is absent, the model hallucinated the tool
      // call. Append a [平台备注] so ground truth shows up in its own
      // context window.
      const halluNotes: string[] = [];
      const cnt = m.content || "";
      if (
        !m.metadata?.audio &&
        /🔊|听语音版|语音版|\(点.{0,4}听\)/.test(cnt)
      ) {
        halluNotes.push(
          "你写了 '🔊 / 听语音版' 字样但本轮 metadata.audio 为空 — speak 工具没真调。这是幻觉，下轮别辩护，承认并真调一次。"
        );
      }
      // generate_image hallucination: assistant wrote an "I'm drawing it,
      // hold on" phrase but no agent image-typed message lands in the
      // room within 60s after that turn, meaning the tool was never
      // called.
      if (/画着呢|稍等十几秒|稍等几秒|马上.{0,3}来|马上就好|正在画|开始画/.test(cnt)) {
        const ts = m.createdAt ? new Date(m.createdAt).getTime() : 0;
        const hasNearbyImage =
          ts > 0 &&
          filtered.some((other) => {
            if (other === m) return false;
            if (other.senderType !== "agent") return false;
            const ct = other.contentType ?? "";
            if (
              ct !== "image" &&
              ct !== "image-pending" &&
              ct !== "image-failed"
            )
              return false;
            const otherTs = other.createdAt
              ? new Date(other.createdAt).getTime()
              : 0;
            return otherTs >= ts && otherTs - ts < 60_000;
          });
        if (!hasNearbyImage) {
          halluNotes.push(
            "你写了 '画着呢 / 稍等' 字样但接下来 60 秒内房间里没有任何图片消息出现 — generate_image 工具没真调。这是幻觉。下次别再光说不练，要真的发出 tool_call。"
          );
        }
      }
      if (halluNotes.length > 0) {
        return {
          role: "assistant" as const,
          content:
            `${cnt}\n\n[平台备注: ${halluNotes.join(" / ")}]` as LLMMessageContent,
        };
      }
      return {
        role: "assistant" as const,
        content: m.content as LLMMessageContent,
      };
    }),
  ];
}
