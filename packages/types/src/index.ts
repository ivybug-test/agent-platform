// User
export interface User {
  id: string;
  name: string;
  email: string;
}

// Room
export interface Room {
  id: string;
  name: string;
  systemPrompt: string | null;
  status: "active" | "archived";
  autoReply: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// Message
export interface Message {
  id: string;
  roomId: string;
  senderType: "user" | "agent" | "system";
  senderId: string | null;
  content: string;
  contentType: string;
  status: "sending" | "streaming" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

// Message with resolved sender name (returned by API)
export interface MessageWithSender extends Message {
  senderName: string | null;
}

// Friendship
export interface Friendship {
  id: string;
  status: "pending" | "accepted";
  direction: "incoming" | "outgoing" | "mutual";
  friend: User;
  createdAt: string;
}

// Mood / attitude (per-(agent, user) cross-room state).
// See docs/agent_mood_design.md for the full design.
export type AttitudeType =
  | "愤怒"
  | "满意"
  | "恶意"
  | "冷漠"
  | "热情"
  | "平和"
  | "喜欢"
  | "难过";

// Target of the user's expressed attitude. "self" is only valid for 难过.
export type AttitudeTarget = "assistant" | "third_party" | "self";

export interface AttitudeItem {
  type: AttitudeType;
  target: AttitudeTarget;
  strength: number; // 1–10 integer
}

export interface AttitudeBlock {
  items: AttitudeItem[];
}

export interface Mood {
  selfState: number; // 1–100
  favor: number; // 1–100
}

// API request/response types
export interface ChatRequest {
  roomId: string;
  content: string;
}

export interface MessagesResponse {
  messages: MessageWithSender[];
  currentUserId: string;
}

export interface SilentResponse {
  silent: true;
}

export interface FriendRequest {
  email: string;
}
