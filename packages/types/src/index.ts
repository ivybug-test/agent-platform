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
