import { Queue } from "bullmq";
import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

export const memoryQueue = new Queue("memory", { connection });

/** Push memory jobs after a chat exchange completes */
export async function pushMemoryJobs(roomId: string, userId: string) {
  await memoryQueue.add("room-summary", { roomId });
  await memoryQueue.add("user-memory", { roomId, userId });
}
