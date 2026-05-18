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
  // Dedup: same user only triggers extraction once per 5 minutes
  await queue.add("user-memory", { roomId, userId }, {
    jobId: `user-memory-${userId}-${Math.floor(Date.now() / 300000)}`,
  });
  // M4.1: enqueue observation check. Worker bails internally if the
  // char-volume threshold isn't crossed yet, so we can push every turn
  // safely. 1-minute dedup bucket keeps Redis ops bounded.
  await queue.add(
    "room-observation",
    { roomId },
    {
      jobId: `room-observation-${roomId}-${Math.floor(Date.now() / 60000)}`,
    }
  );
}

/** Push a caption-image job. Called right after an image message is
 *  persisted so the caption is back-filled before later memory extraction
 *  runs read it. */
export async function pushCaptionJob(messageId: string) {
  const queue = getQueue();
  await queue.add(
    "caption-image",
    { messageId },
    {
      // BullMQ dedup: same image will only spawn one job
      jobId: `caption-image-${messageId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );
}
