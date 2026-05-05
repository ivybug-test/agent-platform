import { db, messages, rooms } from "@agent-platform/db";
import type { ToolInvocation, ToolInvocationHit } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { pushMemoryJobs } from "@/lib/queue";
import { publishRoomEvent, getRedisClient } from "@/lib/redis";
import { publishRoomActivity } from "@/lib/chat/room-activity";
import { createLogger } from "@agent-platform/logger";
import { signToolToken } from "@/lib/tool-token";
import { agentToolDefs } from "@/lib/tools";
import type { LLMMessageContent } from "@/lib/chat/context";

/** Tool names whose results we surface to the user as a "搜索网页" card.
 *  Memory tools (search_memories / remember / etc.) stay invisible because
 *  they're internal bookkeeping the user doesn't care about. */
const VISIBLE_TOOL_NAMES = new Set([
  "web_search",
  "search_lyrics",
  "search_music",
  "fetch_url",
]);

/** Pull a free-form display label out of the JSON-stringified tool args. The
 *  agent's call may stream incrementally so the args string can be partial
 *  garbage by the time we see it — callers must tolerate `undefined`. */
function extractQueryLabel(name: string, argsJson: string): string | undefined {
  if (!argsJson) return undefined;
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>;
    if (name === "search_lyrics") {
      const song = typeof obj.song === "string" ? obj.song : "";
      const artist = typeof obj.artist === "string" ? obj.artist : "";
      return artist ? `${song} ${artist}` : song || undefined;
    }
    if (name === "fetch_url") {
      return typeof obj.url === "string" ? obj.url : undefined;
    }
    // web_search / search_music both use `query`.
    return typeof obj.query === "string" ? obj.query : undefined;
  } catch {
    return undefined;
  }
}

/** Shape of the `tool_result.data` payload — matches what
 *  apps/web/src/lib/tools/web-search-tools.ts returns. */
interface ToolResultPayload {
  data?: {
    results?: ToolInvocationHit[];
    provider?: string;
    url?: string;
    title?: string;
    charCount?: number;
  };
  error?: string;
}

function buildInvocation(
  name: string,
  argsJson: string,
  payload: ToolResultPayload | null,
  ok: boolean
): ToolInvocation {
  const inv: ToolInvocation = { name };
  const query = extractQueryLabel(name, argsJson);
  if (query) inv.query = query;

  if (!ok || !payload) {
    inv.error = payload?.error || "tool call failed";
    return inv;
  }

  if (name === "fetch_url") {
    if (payload.data?.url) {
      inv.fetched = {
        url: payload.data.url,
        title: payload.data.title,
        charCount: payload.data.charCount,
      };
    }
    if (payload.data?.provider) inv.provider = payload.data.provider;
    if (payload.error) inv.error = payload.error;
    return inv;
  }

  // web_search / search_lyrics / search_music — list of hits.
  if (Array.isArray(payload.data?.results)) {
    inv.results = payload.data.results.map((r) => ({
      title: r.title || r.url,
      url: r.url,
      snippet: r.snippet,
    }));
  }
  if (payload.data?.provider) inv.provider = payload.data.provider;
  if (payload.error) inv.error = payload.error;
  return inv;
}

const log = createLogger("web");
const AGENT_RUNTIME_URL =
  process.env.AGENT_RUNTIME_URL!;

type ToolChoice =
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

/** Cheap input-classification → tool_choice override. When the user's
 *  message obviously demands a specific tool ("画一张猫" / "学猫叫" /
 *  "唱一段") we force tool_choice to that function, denying the model
 *  the option of writing "(点 🔊 听语音版)" without actually calling
 *  it. Anything that doesn't match falls back to "auto" so the model
 *  still has full freedom for ambiguous cases.
 *
 *  Design: high precision over recall. Two layers:
 *    1. Trigger regex — short phrase patterns, must include quantifier
 *       or article so plain nouns ("画家", "唱片") don't false-match.
 *    2. Negation lookahead — if any of NEGATION_PREFIXES appears in
 *       the 8 chars BEFORE the trigger, skip ("别画了" / "刚才画的"
 *       are NOT new-image requests). */
const NEGATION_PREFIXES = [
  "不",
  "别",
  "不要",
  "不用",
  "不想",
  "拒绝",
  "刚才",
  "刚刚",
  "上次",
  "之前",
  "刚画",
  "那张",
];
function hasNegationBefore(text: string, matchIndex: number): boolean {
  const window = text.slice(Math.max(0, matchIndex - 8), matchIndex);
  return NEGATION_PREFIXES.some((p) => window.includes(p));
}

// "New image" triggers: user wants a fresh image with no reference to
// prior ones. Trim aggressively (NO image markers in context) so the
// model doesn't blend prior images as `referenceMessageIds`.
const IMAGE_NEW_TRIGGERS: RegExp[] = [
  // "画一张" / "画个" / "画头" — quantifier-anchored so "画家" can't match
  /画[一]?[张个幅条只头份片群]/,
  // "画...张" with up to 4 chars between
  /画.{0,4}[张个幅条只片]/,
  // "帮我画一张" / "帮你画个"
  /帮.{0,4}画[一]?[张个幅条只]/,
  // "我想看 X 的样子" / "X 长什么样" — visual-implying paraphrases
  /我?想?看看?\s*[一-龥]+(的样子|长什么样)/,
  // "搞一张图" / "来一张图"
  /搞[一]?张图/,
  /来[一]?张(图|画)/,
  // "给我来一张/个" — implicitly visual
  /给我?来[一]?[张个幅]/,
  // English: must have article or "me" to avoid bare verbs in unrelated contexts
  /\bdraw\s+(me|a|an|some|the)\b/i,
  /\bpaint\s+(me|a|an|the)\b/i,
  /\bgenerate\b.*\bimage\b/i,
  /\bshow me (a|an|the|some|what)\b/i,
];

// "Edit image" triggers: user wants to modify a prior image. Keep
// image markers in context so the model can pick the right reference.
// Patterns require an image-relevant noun OR an unambiguous color/
// style modifier — "改图书馆" / "改我的代码" / "调音量" must not fire.
const IMAGE_EDIT_TRIGGERS: RegExp[] = [
  // "改成绿色调" / "改成原来的样子" — explicit transform target
  /改.{0,3}成.{0,5}(色|风格|样式|样子|滤镜|背景|主题)/,
  // "改这张图" / "改一下那幅画"
  /改.{0,5}[这那][张幅个]?(图|画)/,
  // "换个颜色" / "换种风格" / "换张图"
  /换[个种]?.{0,3}(颜色|色调|风格|样式|背景|滤镜|主题)/,
  /换[一]?[张幅](图|画)/,
  // "调成暗色" / "调一下色调"
  /调.{0,5}(色|色调|风格|滤镜)/,
  // "重新画" / "重画一张"
  /重新.{0,2}画/,
  /重画[一]?[张只个幅]?/,
  // "再画一只" / "再画一张" — usually a continuation of the same subject
  /再画[一]?[张只个幅]/,
  // "再来一张" — same idea
  /再来[一]?张/,
];

// EDIT first so "重新画一张" / "再画一只" classify as edit (continuing
// a subject) before the broader "画一[张只]" NEW pattern grabs them.
// pickToolChoice still routes both to generate_image — the order only
// affects the new-vs-edit classification used by trim.
const IMAGE_GEN_TRIGGERS: RegExp[] = [
  ...IMAGE_EDIT_TRIGGERS,
  ...IMAGE_NEW_TRIGGERS,
];

/** True iff the user message looks like an EDIT request (vs new image).
 *  Used to decide whether to keep image markers in the trimmed context.
 *  Edit patterns are checked BEFORE classifying as new — "重新画一张"
 *  contains "画一张" (NEW pattern) but is semantically an edit ("redo
 *  the previous one"), so we must match EDIT first.
 *  Negation lookahead is applied so "别再画了" / "刚才画的" don't fire. */
function isImageEditIntent(userContent: string): boolean {
  if (!userContent) return false;
  for (const re of IMAGE_EDIT_TRIGGERS) {
    const m = re.exec(userContent);
    if (m && !hasNegationBefore(userContent, m.index)) return true;
  }
  return false;
}
const SPEAK_TRIGGERS: RegExp[] = [
  // "学猫叫" / "学X叫"
  /学.{0,3}叫/,
  // "模仿X声" / "模仿X的声音"
  /模仿.{0,3}声/,
  // "用语音(说/回复/聊/讲)"
  /用语音(说|回复|聊|讲)?/,
  // "念一下/遍/段"
  /念一[下遍段]/,
  // "读一下/遍/段"
  /读一[下遍段]/,
  // "朗读"
  /朗读/,
  // "唱一段/首/个/曲" — REQUIRE quantifier so "唱片" can't match
  /唱[一]?(段|首|个|曲|歌)/,
  // "哼一段/首/个/曲" — same
  /哼[一]?(段|首|个|曲|歌)/,
  // "(用|换)男声/女声"
  /(用|换)[一]?(种|个)?[男女](声|的声音)/,
  // English: must have object so "I sing every Sunday" can't match
  /\b(sing|hum)\s+(me|a|to me|something|the)\b/i,
  /\bread.*aloud\b/i,
  /\bsay.{0,5}out loud\b/i,
];
function pickToolChoice(userContent: string): ToolChoice {
  if (!userContent) return "auto";
  for (const re of IMAGE_GEN_TRIGGERS) {
    const m = re.exec(userContent);
    if (m && !hasNegationBefore(userContent, m.index)) {
      return { type: "function", function: { name: "generate_image" } };
    }
  }
  for (const re of SPEAK_TRIGGERS) {
    const m = re.exec(userContent);
    if (m && !hasNegationBefore(userContent, m.index)) {
      return { type: "function", function: { name: "speak" } };
    }
  }
  return "auto";
}

/** Cheap user-feedback correction loop. After router forces a tool, we
 *  remember the fire in Redis (TTL 5 min). On the user's NEXT turn, if
 *  their message looks like a "wait, I didn't mean that" correction,
 *  fall through to plain "auto" so the model isn't railroaded into
 *  re-firing the same tool. The 5-min TTL is conservative — slow
 *  conversations can still recover from a misroute, fast back-and-forth
 *  doesn't accumulate stale state.
 *
 *  Note: NEGATIVE_FEEDBACK is a tight regex. "别画了" / "我没让你说话"
 *  / "stop" / "cancel" should hit; "好的" / "继续" must not. */
const ROUTER_FIRED_TTL_S = 300;
const NEGATIVE_FEEDBACK_RE =
  /(我没让|没让你|不是让你|没说要|没要你|别再|不要再|停止|cancel|^停$|^停\s|^别$|^别\s)/i;
async function pickToolChoiceWithCorrection(
  userId: string,
  roomId: string,
  userContent: string
): Promise<{ toolChoice: ToolChoice; correctedFrom: string | null }> {
  const redis = getRedisClient();
  const key = `router-fired:${roomId}:${userId}`;
  let lastFired: string | null = null;
  try {
    lastFired = await redis.get(key);
  } catch {
    // Redis hiccup — skip the correction layer; pure regex still works.
  }
  if (lastFired && NEGATIVE_FEEDBACK_RE.test(userContent)) {
    redis.del(key).catch(() => {});
    return { toolChoice: "auto", correctedFrom: lastFired };
  }
  const choice = pickToolChoice(userContent);
  if (choice !== "auto" && typeof choice === "object") {
    redis
      .set(key, choice.function.name, "EX", ROUTER_FIRED_TTL_S)
      .catch(() => {});
  }
  return { toolChoice: choice, correctedFrom: null };
}
const WEB_BASE_URL =
  process.env.WEB_BASE_URL || "http://localhost:3000";

/** Detects messages whose content carries `[图片#N (msgId=...)]` markers
 *  (both user-uploaded and agent-generated images get this format from
 *  llm-messages.ts). Used by trimToImageGenContext below. */
const IMAGE_MARKER_RE = /\[图片#\d+\s*\(msgId=/;

/** Strip past textual chat from the messages we send to Kimi when the
 *  router routed this turn for `generate_image`. Two trim levels:
 *
 *  - **New-image intent** (`keepImageMarkers=false`, e.g. "画一只狗"):
 *    keep ONLY system + current user message. No prior images at all,
 *    so the model can't pull them as `referenceMessageIds`. Otherwise
 *    "画狗" → "画助手" produces a 助手-with-dog-background as the model
 *    treats the dog as a visual reference.
 *  - **Edit-image intent** (`keepImageMarkers=true`, e.g. "改这张图"):
 *    additionally keep messages whose content has `[图片#N (msgId=...)]`
 *    markers, so the model can pick the right reference.
 *
 *  Always keep:
 *    1. The system prompt (always first)
 *    2. The current user message (always last user role) — including
 *       any `> [回复 ...]` formal-quote prefix already inlined
 *
 *  formal-quote prefix scenario: even with `keepImageMarkers=false`,
 *  the quote prefix in the current message text still carries the
 *  msgId, so the model can reference it explicitly. The marker on
 *  prior messages just isn't needed in that case. */
function trimToImageGenContext<
  T extends { role: string; content: LLMMessageContent },
>(llmMessages: T[], keepImageMarkers: boolean): T[] {
  if (llmMessages.length === 0) return llmMessages;
  let lastUserIdx = -1;
  for (let i = llmMessages.length - 1; i >= 0; i--) {
    if (llmMessages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return llmMessages.filter((m, i) => {
    if (i === 0 && m.role === "system") return true;
    if (i === lastUserIdx) return true;
    if (!keepImageMarkers) return false;
    const content = typeof m.content === "string" ? m.content : "";
    return IMAGE_MARKER_RE.test(content);
  });
}

export type Provider = "deepseek" | "kimi";
export type DeepSeekMode = "flash" | "pro";

/** Call agent-runtime and return a streaming Response */
export async function streamAgentResponse(
  llmMessages: { role: string; content: LLMMessageContent }[],
  agentMsgId: string,
  roomId: string,
  userContent: string,
  userId: string,
  provider: Provider = "deepseek",
  mode: DeepSeekMode = "flash",
  agentName: string = "agent"
): Promise<Response> {
  const toolAuth = await signToolToken({ userId, roomId });
  const { toolChoice: rawToolChoice, correctedFrom } =
    await pickToolChoiceWithCorrection(userId, roomId, userContent);
  if (correctedFrom) {
    log.info(
      {
        roomId,
        userId,
        correctedFrom,
        contentPreview: userContent.slice(0, 60),
      },
      "chat.router-corrected"
    );
  }
  // DeepSeek's API rejects forced tool_choice (`required` and `{function:
  // {name}}`) with 400 (verified 2026-05-05). Kimi accepts both. So when
  // the router fires AND the requested provider is deepseek, route THIS
  // SINGLE TURN to Kimi — Kimi can honor the forced tool_choice, and
  // subsequent turns return to deepseek automatically because
  // streamAgentResponse is called fresh for each user message.
  //
  // What the model produces (tool_call ids, tool_results in the
  // `messages` history) is provider-agnostic OpenAI shape — DeepSeek
  // accepts those just fine on the next round, so context carries over
  // cleanly.
  const toolChoice: ToolChoice = rawToolChoice;
  let effectiveProvider: Provider = provider;
  const isForcedRoute = typeof rawToolChoice === "object";
  if (isForcedRoute && provider === "deepseek") {
    effectiveProvider = "kimi";
    log.info(
      {
        roomId,
        userId,
        forcedTool: rawToolChoice.function.name,
        originalProvider: provider,
      },
      "chat.routing-to-kimi-for-forced-tool"
    );
  }
  // DeepSeek-pro thinking-mode + forced tool_choice has occasional bad
  // interactions; the deep-thinking budget is also wasted when we already
  // know the tool to call. Drop to flash whenever the router fires
  // (only matters when we stayed on deepseek, since kimi ignores mode).
  const effectiveMode: DeepSeekMode =
    isForcedRoute && mode === "pro" && effectiveProvider === "deepseek"
      ? "flash"
      : mode;
  if (toolChoice !== "auto") {
    log.info(
      {
        roomId,
        userId,
        forcedTool:
          typeof toolChoice === "object" ? toolChoice.function.name : toolChoice,
        modeRequested: mode,
        modeEffective: effectiveMode,
        providerRequested: provider,
        providerEffective: effectiveProvider,
      },
      "chat.tool-choice-forced"
    );
  }

  // Context trimming for the image-gen route. Only when we're about to
  // send to Kimi for a forced generate_image call do we strip prior
  // textual chat — that path needs to avoid bleeding "画狗" context
  // into a later "画助手" prompt. New-image vs edit-image trims
  // differently (see trimToImageGenContext doc). The speak path keeps
  // full context because speak's prompt depends on conversation flow
  // ("再说一遍" requires prior turns).
  const isGenerateImageRoute =
    isForcedRoute &&
    typeof rawToolChoice === "object" &&
    rawToolChoice.function.name === "generate_image" &&
    effectiveProvider === "kimi";
  const isEditIntent =
    isGenerateImageRoute && isImageEditIntent(userContent);
  const messagesToSend = isGenerateImageRoute
    ? trimToImageGenContext(llmMessages, isEditIntent)
    : llmMessages;
  if (isGenerateImageRoute) {
    log.info(
      {
        roomId,
        userId,
        intent: isEditIntent ? "edit" : "new",
        keepImageMarkers: isEditIntent,
        fromCount: llmMessages.length,
        toCount: messagesToSend.length,
      },
      "chat.trimmed-context-for-image-gen"
    );
  }

  const response = await fetch(`${AGENT_RUNTIME_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: messagesToSend,
      tools: agentToolDefs,
      toolCallbackUrl: `${WEB_BASE_URL}/api/agent/tool`,
      toolAuth,
      provider: effectiveProvider,
      model: effectiveMode,
      toolChoice,
    }),
  });

  if (!response.ok || !response.body) {
    log.error({ roomId, agentMsgId, status: response.status }, "stream.runtime-error");
    await db
      .update(messages)
      .set({ status: "failed" })
      .where(eq(messages.id, agentMsgId));
    return new Response("Agent runtime error", { status: 502 });
  }

  const streamStartTime = Date.now();
  let fullContent = "";
  // DeepSeek v4-pro chain-of-thought, captured for the collapsible
  // "thinking" UI block. NOT fed back into the next turn's context.
  let fullReasoning = "";
  let reasoningStartedAt = 0;
  let reasoningEndedAt = 0;
  // Pair tool_call (id, name, args) with the matching tool_result so we can
  // persist the user-visible search hits onto the message. Memory tools are
  // filtered out at persistence time.
  const pendingToolCalls = new Map<string, { name: string; args: string }>();
  const toolInvocations: ToolInvocation[] = [];
  // `speak` tool result → metadata.audio. Captured here so the play
  // button survives reload (the live SSE branch in ChatPanel mirrors
  // this on its own state for immediate feedback).
  let audioPayload: { text: string; voiceId?: string } | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      // Buffer for partial-line carry-over across reads. SSE events end
      // in `\n\n`, but a single fetch chunk can split a line in the
      // middle (TCP/reverse-proxy buffering). Without carry-over, the
      // partial JSON in the tail of one chunk + the head of the next
      // both fail to parse silently, the inner try/catch swallows
      // them, and the corresponding event is lost. Manifests as
      // "stream completes with empty content" when round 2 of an
      // hallucination retry happens to land on a chunk boundary.
      let pending = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
          pending += decoder.decode(value, { stream: true });
          // Hold back the last (potentially incomplete) segment until
          // the next chunk arrives.
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const evt = JSON.parse(data) as {
                content?: string;
                reasoning?: string;
                content_retracted?: boolean;
                tool_call?: { id: string; name: string; args: string };
                tool_result?: {
                  id: string;
                  name?: string;
                  ok: boolean;
                  data?: ToolResultPayload;
                };
              };
              if (evt.reasoning) {
                if (!reasoningStartedAt) reasoningStartedAt = Date.now();
                fullReasoning += evt.reasoning;
              }
              if (evt.content_retracted) {
                // Validator caught a content/tool_call mismatch and is
                // re-running the round. Throw away the partial content
                // we'd been accumulating so the eventual db.update at
                // turn end persists only the corrected reply.
                fullContent = "";
              }
              if (evt.content) {
                if (reasoningStartedAt && !reasoningEndedAt) {
                  reasoningEndedAt = Date.now();
                }
                fullContent += evt.content;
              }
              if (evt.tool_call) {
                pendingToolCalls.set(evt.tool_call.id, {
                  name: evt.tool_call.name,
                  args: evt.tool_call.args,
                });
              }
              if (evt.tool_result) {
                const pending = pendingToolCalls.get(evt.tool_result.id);
                const name = pending?.name || evt.tool_result.name || "";
                const argsJson = pending?.args || "";
                if (name && VISIBLE_TOOL_NAMES.has(name)) {
                  toolInvocations.push(
                    buildInvocation(
                      name,
                      argsJson,
                      (evt.tool_result.data ?? null) as ToolResultPayload | null,
                      !!evt.tool_result.ok
                    )
                  );
                }
                if (name === "speak" && evt.tool_result.ok && argsJson) {
                  try {
                    const parsed = JSON.parse(argsJson) as {
                      text?: unknown;
                      voiceId?: unknown;
                    };
                    if (typeof parsed.text === "string" && parsed.text.trim()) {
                      audioPayload = {
                        text: parsed.text.trim(),
                        ...(typeof parsed.voiceId === "string"
                          ? { voiceId: parsed.voiceId }
                          : {}),
                      };
                    }
                  } catch {}
                }
                pendingToolCalls.delete(evt.tool_result.id);
              }
            } catch {}
          }
        }
      } finally {
        const duration = Date.now() - streamStartTime;
        log.info(
          {
            roomId,
            agentMsgId,
            contentLength: fullContent.length,
            reasoningLength: fullReasoning.length,
            duration,
          },
          "stream.complete"
        );
        log.debug({ roomId, agentMsgId, content: fullContent }, "stream.content");

        const reasoningMs =
          reasoningStartedAt && reasoningEndedAt
            ? reasoningEndedAt - reasoningStartedAt
            : reasoningStartedAt
              ? Date.now() - reasoningStartedAt
              : 0;
        // Only attach a metadata blob when there's a reason to (reasoning
        // trace, tool-result card, or audio button). Plain non-pro /
        // no-tool turns still leave the column NULL.
        const metadata =
          fullReasoning || toolInvocations.length > 0 || audioPayload
            ? {
                ...(fullReasoning ? { reasoning: fullReasoning, reasoningMs } : {}),
                ...(toolInvocations.length > 0 ? { toolInvocations } : {}),
                ...(audioPayload ? { audio: audioPayload } : {}),
              }
            : undefined;

        await db
          .update(messages)
          .set({
            content: fullContent,
            status: "completed",
            metadata,
            updatedAt: new Date(),
          })
          .where(eq(messages.id, agentMsgId));

        // Broadcast completed agent message to room
        log.info({ roomId, eventType: "agent-message", agentMsgId }, "stream.publish");
        publishRoomEvent({
          type: "agent-message",
          roomId,
          triggeredBy: userId,
          message: {
            id: agentMsgId,
            senderType: "agent",
            senderId: null,
            senderName: agentName,
            content: fullContent,
            status: "completed",
          },
        });

        // Bubble this room to the top of every member's sidebar.
        publishRoomActivity(roomId);

        // Auto-generate room title (fire and forget)
        maybeGenerateRoomTitle(roomId, userContent, fullContent);

        // Push memory extraction jobs (async, non-blocking)
        pushMemoryJobs(roomId, userId).catch(() => {});

        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/** Generate room title from first conversation */
async function maybeGenerateRoomTitle(
  roomId: string,
  userContent: string,
  agentContent: string
) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
  if (!room || room.name !== "New Chat") return;

  try {
    const res = await fetch(`${AGENT_RUNTIME_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content:
              "Generate a short title (under 20 characters) for this conversation. Reply with only the title, nothing else.",
          },
          { role: "user", content: userContent },
          { role: "assistant", content: agentContent },
        ],
      }),
    });

    if (!res.ok || !res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let title = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const { content } = JSON.parse(data);
          if (content) title += content;
        } catch {}
      }
    }

    title = title.trim().replace(/^["']|["']$/g, "");
    if (title) {
      await db
        .update(rooms)
        .set({ name: title, updatedAt: new Date() })
        .where(eq(rooms.id, roomId));
    }
  } catch {}
}
