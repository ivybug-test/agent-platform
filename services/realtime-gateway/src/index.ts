import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "../../.env") });

import { createServer } from "http";
import { Server } from "socket.io";
import Redis from "ioredis";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("gateway");

const port = process.env.GATEWAY_PORT;
if (!port) {
  console.error("GATEWAY_PORT environment variable is required");
  process.exit(1);
}

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

// Separate Redis connection for pub/sub (required by Redis)
const subscriber = new Redis(redisUrl);
const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN ?? "*",
    methods: ["GET", "POST"],
  },
});

// Subscribe to room and user channels
subscriber.psubscribe("room:*", "user:*", (err) => {
  if (err) {
    log.error({ err }, "ws.subscribe-failed");
    process.exit(1);
  }
  log.info("ws.subscribed to room:* and user:*");
});

// Forward Redis pub/sub messages to Socket.IO rooms/users
subscriber.on("pmessage", (_pattern, channel, message) => {
  try {
    const data = JSON.parse(message);

    if (channel.startsWith("room:")) {
      const roomId = channel.slice("room:".length);
      const clientCount = io.sockets.adapter.rooms.get(roomId)?.size || 0;
      log.info({
        roomId,
        eventType: data.type,
        messageId: data.message?.id,
        clientCount,
      }, "ws.forward");
      io.to(roomId).emit("room-message", data);
    } else if (channel.startsWith("user:")) {
      const userId = channel.slice("user:".length);
      const clientCount = io.sockets.adapter.rooms.get(`u:${userId}`)?.size || 0;
      log.info({ userId, eventType: data.type, clientCount }, "ws.user-event");
      io.to(`u:${userId}`).emit("user-event", data);
    }
  } catch (err) {
    log.error({ err, channel }, "ws.parse-error");
  }
});

// Handle Socket.IO connections
io.on("connection", (socket) => {
  log.info({ socketId: socket.id }, "ws.connect");

  // Debug: log ALL events from this socket
  socket.onAny((eventName, ...args) => {
    if (!["join-room", "leave-room", "register-user", "typing"].includes(eventName)) {
      log.info({ socketId: socket.id, event: eventName }, "ws.unknown-event");
    }
  });

  // Register user-level channel for notifications (room-added, etc.)
  socket.on("register-user", (userId: string) => {
    if (typeof userId !== "string" || !userId) return;
    socket.join(`u:${userId}`);
    log.info({ socketId: socket.id, userId }, "ws.register-user");
  });

  socket.on("join-room", (roomId: string) => {
    if (typeof roomId !== "string" || !roomId) return;
    socket.join(roomId);
    const clientCount = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    log.info({ socketId: socket.id, roomId, clientCount }, "ws.join");
  });

  // Typing indicator — broadcast to others in the same room
  socket.on("typing", (data: { roomId: string; userName: string }) => {
    log.info({ socketId: socket.id, roomId: data?.roomId, userName: data?.userName }, "ws.typing");
    if (!data?.roomId || !data?.userName) return;
    socket.to(data.roomId).emit("typing", { userName: data.userName, roomId: data.roomId });
  });

  socket.on("leave-room", (roomId: string) => {
    if (typeof roomId !== "string" || !roomId) return;
    socket.leave(roomId);
    log.info({ socketId: socket.id, roomId }, "ws.leave");
  });

  socket.on("disconnect", (reason) => {
    log.info({ socketId: socket.id, reason }, "ws.disconnect");
  });
});

httpServer.listen(Number(port), () => {
  console.log(`Realtime gateway listening on port ${port}`);
});
