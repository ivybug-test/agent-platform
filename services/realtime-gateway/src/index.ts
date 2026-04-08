import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "../../.env") });

import { createServer } from "http";
import { Server } from "socket.io";
import Redis from "ioredis";

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

// Subscribe to all room channels via pattern
subscriber.psubscribe("room:*", (err) => {
  if (err) {
    console.error("Failed to subscribe to room channels:", err);
    process.exit(1);
  }
  console.log("Subscribed to room:* channels");
});

// Forward Redis pub/sub messages to Socket.IO rooms
subscriber.on("pmessage", (_pattern, channel, message) => {
  // channel format: "room:<roomId>"
  const roomId = channel.slice("room:".length);
  try {
    const data = JSON.parse(message);
    io.to(roomId).emit("room-message", data);
  } catch (err) {
    console.error("Failed to parse Redis message:", err);
  }
});

// Handle Socket.IO connections
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("join-room", (roomId: string) => {
    if (typeof roomId !== "string" || !roomId) {
      return;
    }
    socket.join(roomId);
    console.log(`Socket ${socket.id} joined room ${roomId}`);
  });

  socket.on("leave-room", (roomId: string) => {
    if (typeof roomId !== "string" || !roomId) {
      return;
    }
    socket.leave(roomId);
    console.log(`Socket ${socket.id} left room ${roomId}`);
  });

  socket.on("disconnect", (reason) => {
    console.log(`Client disconnected: ${socket.id} (${reason})`);
  });
});

httpServer.listen(Number(port), () => {
  console.log(`Realtime gateway listening on port ${port}`);
});
