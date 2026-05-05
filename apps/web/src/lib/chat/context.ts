/** Barrel re-export. The original 800-line context.ts was split during
 *  the P4 refactor into queries / llm-messages / prompts/. This file
 *  preserves the import surface for callers that still reach in via
 *  "@/lib/chat/context". New code should import from the dedicated
 *  modules directly. */
export {
  loadChatContext,
  getRoomMemberNames,
  getConfirmedRelationshipsForUser,
  getRoomMemories,
  getLatestSummary,
  getUserMemories,
  getRoomUsersMemories,
} from "./queries";

export { buildSystemPrompt } from "./prompts/system-prompt";

export {
  buildLLMMessages,
  type ContextMessage,
  type LLMContentPart,
  type LLMMessageContent,
} from "./llm-messages";
