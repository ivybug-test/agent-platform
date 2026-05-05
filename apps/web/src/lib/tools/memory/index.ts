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

export const memoryToolHandlers: Record<string, ToolHandler> = {
  ...userMemoryToolHandlers,
  ...roomMemoryToolHandlers,
  ...relationshipToolHandlers,
};

export const memoryToolDefs = [
  ...userMemoryToolDefs,
  ...roomMemoryToolDefs,
  ...relationshipToolDefs,
];
