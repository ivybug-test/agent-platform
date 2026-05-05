import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "../../.env") });

import Fastify from "fastify";
import { getModel } from "./llm.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerSummarizeRoute } from "./routes/summarize.js";
import { registerChatRoute } from "./routes/chat/index.js";

const app = Fastify({ logger: true });
const isMock = process.env.MOCK_LLM === "true";

registerHealthRoute(app);
registerSummarizeRoute(app, isMock);
registerChatRoute(app, isMock);

const start = async () => {
  const port = Number(process.env.PORT) || 3001;
  await app.listen({ port, host: "0.0.0.0" });
  const model = getModel();
  app.log.info(
    `LLM: ${isMock ? "MOCK" : `${model} via ${process.env.LLM_BASE_URL || "openai"}`}`
  );
};

start();
