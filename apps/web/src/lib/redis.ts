import IORedis from "ioredis";

let _pub: IORedis | null = null;

function getPublisher(): IORedis {
  if (!_pub) {
    if (!process.env.REDIS_URL) {
      throw new Error("REDIS_URL environment variable is required");
    }
    _pub = new IORedis(process.env.REDIS_URL);
  }
  return _pub;
}

interface RoomEvent {
  type: "user-message" | "agent-message" | "agent-chunk";
  roomId: string;
  triggeredBy?: string; // userId who triggered this agent response
  message: {
    id: string;
    senderType: string;
    senderId: string | null;
    senderName: string | null;
    content: string;
    contentType?: string;
    status: string;
  };
}

export function publishRoomEvent(event: RoomEvent) {
  const redis = getPublisher();
  redis.publish(`room:${event.roomId}`, JSON.stringify(event)).catch(() => {});
}

interface UserEvent {
  type: "room-added" | "room-updated" | "room-removed";
  room?: { id: string; name: string };
  roomId?: string;
}

export function publishUserEvent(userId: string, event: UserEvent) {
  const redis = getPublisher();
  redis.publish(`user:${userId}`, JSON.stringify(event)).catch(() => {});
}
