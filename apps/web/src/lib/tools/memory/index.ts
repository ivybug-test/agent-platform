import type { ToolHandler } from "../index";
import {
  userMemoryToolHandlers,
  userMemoryToolDefs,
} from "./user-memory-tools";
import {
  roomMemoryToolHandlers,
  roomMemoryToolDefs,
} from "./room-memory-tools";
import {
  relationshipToolHandlers,
  relationshipToolDefs,
} from "./relationship-tools";
import {
  agentSelfToolHandlers,
  agentSelfToolDefs,
} from "./agent-self-tools";

export const memoryToolHandlers: Record<string, ToolHandler> = {
  ...userMemoryToolHandlers,
  ...roomMemoryToolHandlers,
  ...relationshipToolHandlers,
  ...agentSelfToolHandlers,
};

export const memoryToolDefs = [
  ...userMemoryToolDefs,
  ...roomMemoryToolDefs,
  ...relationshipToolDefs,
  ...agentSelfToolDefs,
];
