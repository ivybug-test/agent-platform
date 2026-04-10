module.exports = {
  apps: [
    {
      name: "web",
      script: "apps/web/.next/standalone/apps/web/server.js",
      cwd: "/root/agent-platform",
      env: {
        PORT: 3000,
        HOSTNAME: "0.0.0.0",
        DATABASE_URL: "postgresql://postgres:change-this-strong-password@localhost:5432/agent_platform",
        REDIS_URL: "redis://localhost:6379",
        AUTH_SECRET: "43af68dd3e117b5c54ec8a3360ddf9bde02cf5ead5521f2d797439f5c99793e2",
        AUTH_TRUST_HOST: "true",
        AUTH_URL: "",
        AGENT_RUNTIME_URL: "http://localhost:3001",
      },
    },
    {
      name: "agent-runtime",
      script: "services/agent-runtime/dist/index.js",
      cwd: "/root/agent-platform",
      env: {
        PORT: 3001,
        LLM_API_KEY: "sk-00e37e60bc434044b7beb3f7fa9c0d1a",
        LLM_BASE_URL: "https://api.deepseek.com",
        LLM_MODEL: "deepseek-chat",
        MOCK_LLM: "false",
      },
    },
    {
      name: "memory-worker",
      script: "services/memory-worker/dist/index.js",
      cwd: "/root/agent-platform",
      env: {
        DATABASE_URL: "postgresql://postgres:change-this-strong-password@localhost:5432/agent_platform",
        REDIS_URL: "redis://localhost:6379",
        LLM_API_KEY: "sk-00e37e60bc434044b7beb3f7fa9c0d1a",
        LLM_BASE_URL: "https://api.deepseek.com",
        LLM_MODEL: "deepseek-chat",
      },
    },
    {
      name: "realtime-gateway",
      script: "services/realtime-gateway/dist/index.js",
      cwd: "/root/agent-platform",
      env: {
        GATEWAY_PORT: "3002",
        REDIS_URL: "redis://localhost:6379",
      },
    },
  ],
};
