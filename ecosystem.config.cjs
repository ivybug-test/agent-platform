// Loads secrets from infra/.env.prod (gitignored) so this file can be committed.
// Any KEY=VALUE line is exposed via process.env.KEY below.
const fs = require("fs");
const path = require("path");

function loadEnvFile(relPath) {
  const full = path.resolve(__dirname, relPath);
  if (!fs.existsSync(full)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(full, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = loadEnvFile("infra/.env.prod");
const pick = (...keys) =>
  Object.fromEntries(keys.map((k) => [k, env[k] ?? ""]));

module.exports = {
  apps: [
    {
      name: "web",
      script: "server.js",
      cwd: "/root/agent-platform/apps/web/.next/standalone/apps/web",
      env: {
        PORT: 3000,
        HOSTNAME: "0.0.0.0",
        AUTH_TRUST_HOST: "true",
        AUTH_URL: "",
        AGENT_RUNTIME_URL: "http://localhost:3001",
        NO_PROXY: ".tencentcloudapi.com,.myqcloud.com",
        no_proxy: ".tencentcloudapi.com,.myqcloud.com",
        ...pick(
          "DATABASE_URL",
          "REDIS_URL",
          "AUTH_SECRET",
          "TENCENT_SECRET_ID",
          "TENCENT_SECRET_KEY",
          "TENCENT_COS_BUCKET",
          "TENCENT_COS_REGION"
        ),
      },
    },
    {
      name: "agent-runtime",
      script: "services/agent-runtime/dist/index.js",
      cwd: "/root/agent-platform",
      env: {
        PORT: 3001,
        MOCK_LLM: "false",
        ...pick("LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"),
      },
    },
    {
      name: "memory-worker",
      script: "services/memory-worker/dist/index.js",
      cwd: "/root/agent-platform",
      env: {
        ...pick(
          "DATABASE_URL",
          "REDIS_URL",
          "LLM_API_KEY",
          "LLM_BASE_URL",
          "LLM_MODEL"
        ),
      },
    },
    {
      name: "realtime-gateway",
      script: "services/realtime-gateway/dist/index.js",
      cwd: "/root/agent-platform",
      env: {
        GATEWAY_PORT: "3002",
        ...pick("REDIS_URL"),
      },
    },
  ],
};
