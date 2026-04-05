import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "../../.env") });

import Fastify from "fastify";
import { getClient, getModel } from "./llm.js";
import { mockStream } from "./mock.js";

const app = Fastify({ logger: true });
const isMock = process.env.MOCK_LLM === "true";

app.get("/health", async () => ({ status: "ok" }));

interface ChatBody {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
}

app.post<{ Body: ChatBody }>("/chat", async (request, reply) => {
  const { messages } = request.body;

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  if (isMock) {
    for await (const chunk of mockStream()) {
      reply.raw.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }
  } else {
    const client = getClient();
    const model = getModel();
    const stream = await client.chat.completions.create({
      model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        reply.raw.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }
  }

  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
});

const start = async () => {
  const port = Number(process.env.PORT) || 3001;
  await app.listen({ port, host: "0.0.0.0" });
  const model = getModel();
  app.log.info(`LLM: ${isMock ? "MOCK" : `${model} via ${process.env.LLM_BASE_URL || "openai"}`}`);
};

start();
