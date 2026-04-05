import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "../../.env") });

import { Worker } from "bullmq";
import IORedis from "ioredis";
import { processRoomSummary } from "./jobs/room-summary.js";
import { processUserMemory } from "./jobs/user-memory.js";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const worker = new Worker(
  "memory",
  async (job) => {
    console.log(`Processing job: ${job.name} [${job.id}]`);

    switch (job.name) {
      case "room-summary":
        await processRoomSummary(job.data);
        break;
      case "user-memory":
        await processUserMemory(job.data);
        break;
      default:
        console.warn(`Unknown job type: ${job.name}`);
    }
  },
  { connection }
);

worker.on("completed", (job) => {
  console.log(`Job completed: ${job.name} [${job.id}]`);
});

worker.on("failed", (job, err) => {
  console.error(`Job failed: ${job?.name} [${job?.id}]`, err.message);
});

console.log("memory-worker: listening for jobs...");
