import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "../../.env") });

import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { processRoomSummary } from "./jobs/room-summary.js";
import { processRoomObservation } from "./jobs/room-observation.js";
import { processObservationIdleScan } from "./jobs/observation-idle-scan.js";
import {
  processAgentSelfExtract,
  processAgentSelfScan,
} from "./jobs/agent-self.js";
import { processUserMemory } from "./jobs/user-memory.js";
import {
  processMemoryDedup,
  processMemoryDedupScan,
} from "./jobs/memory-dedup.js";
import { processCaptionImage } from "./jobs/caption-image.js";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL environment variable is required");
}
const redisUrl = process.env.REDIS_URL;
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

// A queue reference lets the scan job fan-out per-user dedup jobs onto the
// same queue the worker is consuming.
const queue = new Queue("memory", { connection });

const worker = new Worker(
  "memory",
  async (job) => {
    console.log(`Processing job: ${job.name} [${job.id}]`);

    switch (job.name) {
      case "room-summary":
        await processRoomSummary(job.data);
        break;
      case "room-observation":
        await processRoomObservation(job.data);
        break;
      case "observation-idle-scan":
        await processObservationIdleScan(queue);
        break;
      case "agent-self-scan":
        await processAgentSelfScan(queue);
        break;
      case "agent-self-extract":
        await processAgentSelfExtract(job.data);
        break;
      case "user-memory":
        await processUserMemory(job.data);
        break;
      case "memory-dedup-scan":
        await processMemoryDedupScan(queue);
        break;
      case "memory-dedup":
        await processMemoryDedup(job.data);
        break;
      case "caption-image":
        await processCaptionImage(job.data);
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

// Repeatable scan schedule — default every 24h. Override in dev with
// MEMORY_DEDUP_INTERVAL_MS (e.g. 120000 for 2 minutes).
const dedupIntervalMs = Number(process.env.MEMORY_DEDUP_INTERVAL_MS) ||
  24 * 60 * 60 * 1000;

// Observation idle-scan: default every 10 minutes. Looks for rooms that
// have been idle ≥30 min (configurable) AND have ≥3000 chars of
// unconsumed messages, then enqueues room-observation jobs for them.
// Pairs with the volume-based trigger from chat route to catch
// conversations that fizzle out below the volume threshold.
const observationScanIntervalMs =
  Number(process.env.OBSERVATION_SCAN_INTERVAL_MS) || 10 * 60 * 1000;

// Agent self-extract: default once a day. Fan-out scan finds active
// agents (any assistant msg in last 7 days) and queues a per-agent
// extraction job. Idempotent per day via jobId.
const agentSelfScanIntervalMs =
  Number(process.env.AGENT_SELF_SCAN_INTERVAL_MS) || 24 * 60 * 60 * 1000;

// upsertJobScheduler replaces any prior schedule with the same key, so
// changing the interval just takes effect on next worker restart.
Promise.all([
  queue.upsertJobScheduler(
    "memory-dedup-scan-scheduler",
    { every: dedupIntervalMs },
    { name: "memory-dedup-scan" }
  ),
  queue.upsertJobScheduler(
    "observation-idle-scan-scheduler",
    { every: observationScanIntervalMs },
    { name: "observation-idle-scan" }
  ),
  queue.upsertJobScheduler(
    "agent-self-scan-scheduler",
    { every: agentSelfScanIntervalMs },
    { name: "agent-self-scan" }
  ),
  // Run one scan right after boot so a fresh deploy cleans up any
  // existing duplicates instead of waiting up to `dedupIntervalMs`.
  queue.add(
    "memory-dedup-scan",
    {},
    { removeOnComplete: 20, removeOnFail: 20 }
  ),
])
  .then(() => {
    console.log(
      `memory-worker: listening for jobs... (dedup scan every ${Math.round(
        dedupIntervalMs / 1000
      )}s; observation idle scan every ${Math.round(
        observationScanIntervalMs / 1000
      )}s; one-off startup dedup-scan queued)`
    );
  })
  .catch((err) => {
    console.error("failed to register scan schedulers:", err);
  });
