import { memo, useMemo, useRef, useState } from "react";
import LinkPreviewCard from "../LinkPreviewCard";
import MarkdownContent from "../MarkdownContent";
import ThinkingPanel from "./ThinkingPanel";
import ToolInvocationsCard from "./ToolInvocationsCard";
import QuoteBlock from "./QuoteBlock";
import ImagePendingPlaceholder from "./ImagePendingPlaceholder";
import type { MessageBubbleProps } from "./types";
import { extractUrls } from "@/lib/chat/extract-urls";
import {
  colorForUser,
  isImageMessage,
} from "@/lib/chat/message-helpers";
import { fmtTime, dayKey, dayDividerLabel } from "@/lib/chat/format-time";

function MessageBubbleInner({
  msg,
  prevCreatedAt,
  agentName,
  currentUserId,
  isMenuOpen,
  isPlaying,
  isStreamingThinking,
  onContextMenu,
  onLongPressStart,
  onLongPressCancel,
  onJumpToMessage,
  onBeginQuote,
  onCloseMenu,
  onToggleAudio,
}: MessageBubbleProps) {
  const isMe = msg.senderType === "user" && msg.senderId === currentUserId;
  const isAgent = msg.senderType === "agent";
  const displayName = isMe
    ? "我"
    : msg.senderName || (isAgent ? agentName : "用户");
  const bubbleColor = isAgent
    ? "chat-bubble-neutral"
    : isMe
      ? "chat-bubble-primary"
      : colorForUser(msg.senderId || "unknown");
  const showDayDivider =
    msg.createdAt &&
    (!prevCreatedAt || dayKey(prevCreatedAt) !== dayKey(msg.createdAt));
  const timeLabel = fmtTime(msg.createdAt);
  const urls = useMemo(() => extractUrls(msg.content), [msg.content]);

  // Long-press tolerance: tiny finger jitter shouldn't kill the timer.
  // Cancel only once the touch has moved >10px from where it landed,
  // matching iMessage / WeChat behavior.
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // Image-load failure flag. Flipped by the <img onError> below; once
  // true we render a friendly "图片已失效" pill instead of the broken
  // image icon. Also fires a telemetry event so we can quantify how
  // often agent-images URLs go dead (NoSuchKey / lifecycle / etc).
  const [imgBroken, setImgBroken] = useState(false);

  return (
    <div
      id={msg.id ? `msg-${msg.id}` : undefined}
      // content-visibility: auto lets the browser skip layout / paint
      // for off-screen bubbles. Drop the directive while the action
      // menu is open — paint containment clips the floating menu
      // (positioned at -top-9, outside the wrapper's box).
      className={
        isMenuOpen
          ? "rounded transition-shadow"
          : "rounded transition-shadow [content-visibility:auto] [contain-intrinsic-size:auto_120px]"
      }
    >
      {showDayDivider && (
        <div className="flex justify-center my-3">
          <span className="text-[10px] px-2 py-0.5 rounded bg-base-300/60 text-base-content/50">
            {dayDividerLabel(msg.createdAt)}
          </span>
        </div>
      )}
      <div className={`chat ${isMe ? "chat-end" : "chat-start"} relative`}>
        <div className="chat-header text-xs opacity-60 mb-0.5">
          {displayName}
          {timeLabel && (
            <time className="ml-1.5 opacity-60 text-[10px]">{timeLabel}</time>
          )}
        </div>
        <div
          className={`chat-bubble ${bubbleColor} text-sm select-none [-webkit-touch-callout:none] [-webkit-user-select:none]`}
          onContextMenu={(e) => {
            if (!msg.id) return;
            e.preventDefault();
            onContextMenu(msg.id);
          }}
          // Pointer events instead of touch events — on iOS Safari the
          // scroll-gesture predictor fires `touchcancel` early for any
          // touch inside a scroll container. Pointer events only emit
          // `pointercancel` once an actual pan has started.
          onPointerDown={(e) => {
            console.log("[diag] pointerdown", { type: e.pointerType, msgId: msg.id });
            if (e.pointerType === "mouse") return;
            if (!msg.id) return;
            touchStartRef.current = { x: e.clientX, y: e.clientY };
            onLongPressStart(msg.id);
          }}
          onPointerMove={(e) => {
            if (e.pointerType === "mouse") return;
            const start = touchStartRef.current;
            if (!start) return;
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 10) {
              console.log("[diag] pointermove → cancel (moved", Math.round(dist), "px)");
              touchStartRef.current = null;
              onLongPressCancel();
            }
          }}
          onPointerUp={(e) => {
            if (e.pointerType === "mouse") return;
            console.log("[diag] pointerup → cancel");
            touchStartRef.current = null;
            onLongPressCancel();
          }}
          onPointerCancel={(e) => {
            if (e.pointerType === "mouse") return;
            console.log("[diag] pointercancel → cancel");
            touchStartRef.current = null;
            onLongPressCancel();
          }}
        >
          {msg.replyTo && <QuoteBlock reply={msg.replyTo} onJump={onJumpToMessage} />}
          {msg.contentType === "image-pending" ? (
            <ImagePendingPlaceholder
              prompt={msg.imageGen?.prompt}
              phase={msg.imageGen?.phase}
              startedAt={msg.imageGen?.startedAt || msg.createdAt}
            />
          ) : msg.contentType === "image-failed" ? (
            <div className="px-3 py-2 rounded bg-error/10 border border-error/30 text-xs text-error max-w-[240px]">
              {msg.content || "(生成失败)"}
            </div>
          ) : isImageMessage(msg) ? (
            imgBroken ? (
              <div className="px-3 py-2 rounded bg-error/10 border border-error/30 text-xs text-error max-w-[240px]">
                图片已失效
              </div>
            ) : (
              <a href={msg.content} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={msg.content}
                  alt="sent image"
                  className="max-w-[240px] max-h-[320px] rounded object-contain"
                  loading="lazy"
                  onError={() => {
                    setImgBroken(true);
                    fetch("/api/telemetry", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        event: "image-broken",
                        messageId: msg.id ?? null,
                        url: msg.content,
                        senderType: msg.senderType,
                      }),
                    }).catch(() => {});
                  }}
                />
              </a>
            )
          ) : (
            <>
              {isAgent && msg.toolInvocations && msg.toolInvocations.length > 0 && (
                <ToolInvocationsCard invocations={msg.toolInvocations} />
              )}
              {msg.reasoning && (
                <ThinkingPanel
                  reasoning={msg.reasoning}
                  reasoningMs={msg.reasoningMs}
                  streaming={isStreamingThinking}
                />
              )}
              {isAgent ? (
                <MarkdownContent>{msg.content}</MarkdownContent>
              ) : (
                <div className="whitespace-pre-wrap">{msg.content}</div>
              )}
              {isAgent && msg.audio && msg.id && (
                <button
                  type="button"
                  onClick={() =>
                    onToggleAudio(msg.id!, msg.audio!.text, msg.audio!.voiceId)
                  }
                  className="mt-1.5 flex items-center gap-1.5 px-2.5 h-7 rounded-full text-xs bg-base-100/60 border border-base-content/20 hover:bg-base-content/5 transition-colors select-none"
                  title={isPlaying ? "停止" : "播放语音"}
                >
                  <span aria-hidden>{isPlaying ? "⏹" : "🔊"}</span>
                  <span>{isPlaying ? "播放中…" : "语音"}</span>
                </button>
              )}
              {urls.map((u) => (
                <LinkPreviewCard key={u} url={u} />
              ))}
            </>
          )}
        </div>
        {isMenuOpen && msg.id && (
          // Floats above the bubble (iMessage-style reaction bar).
          <div
            className={`absolute z-20 ${isMe ? "right-1" : "left-1"} -top-9 flex bg-base-100 border border-base-300 rounded-full shadow-lg text-xs overflow-hidden divide-x divide-base-300`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="px-3 py-1.5 hover:bg-base-200 active:bg-base-300"
              onClick={() => onBeginQuote(msg)}
            >
              引用
            </button>
            {!isImageMessage(msg) && (
              <button
                type="button"
                className="px-3 py-1.5 hover:bg-base-200 active:bg-base-300"
                onClick={() => {
                  navigator.clipboard?.writeText(msg.content).catch(() => {});
                  onCloseMenu();
                }}
              >
                复制
              </button>
            )}
            {isImageMessage(msg) && (
              <button
                type="button"
                className="px-3 py-1.5 hover:bg-base-200 active:bg-base-300"
                onClick={() => {
                  window.open(msg.content, "_blank", "noopener");
                  onCloseMenu();
                }}
              >
                新标签打开
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const MessageBubble = memo(MessageBubbleInner);
export default MessageBubble;
