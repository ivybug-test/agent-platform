import { Queue } from "bullmq";
import IORedis from "ioredis";

let _queue: Queue | null = null;

function getQueue(): Queue {
  if (!_queue) {
    if (!process.env.REDIS_URL) {
      throw new Error("REDIS_URL environment variable is required");
    }
    const redisUrl = process.env.REDIS_URL;
    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    _queue = new Queue("memory", { connection });
  }
  return _queue;
}

/** Push memory jobs after a chat exchange completes */
export async function pushMemoryJobs(roomId: string, userId: string) {
  const queue = getQueue();
  await queue.add("room-summary", { roomId });
  await queue.add("user-memory", { roomId, userId });
}
