#!/bin/bash
# Deploy after build — push schema, start caddy, start pm2 services
# Called by setup-server.sh or manually after update.sh
set -e

cd ~/agent-platform

# --- Load env ---
echo "=== Loading env ==="
set -a
source infra/.env.prod
export AUTH_TRUST_HOST=true
set +a

# --- Push database schema ---
echo "=== Pushing database schema ==="
ln -sf ~/agent-platform/infra/.env.prod ~/agent-platform/.env
cd packages/db
pnpm db:push
cd ~/agent-platform

# --- Setup Caddy ---
echo "=== Setting up Caddy ==="
mkdir -p /etc/caddy
cp infra/Caddyfile /etc/caddy/Caddyfile
caddy stop 2>/dev/null || true
caddy start --config /etc/caddy/Caddyfile 2>/dev/null || echo "  Caddy failed, skipping HTTPS. Access via http://119.29.129.198:3000"

# --- Copy standalone assets ---
echo "=== Copying standalone assets ==="
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
cp -r apps/web/.next/server apps/web/.next/standalone/apps/web/.next/server

# --- Create pm2 ecosystem ---
echo "=== Creating pm2 ecosystem ==="
# Each service's env is listed explicitly. pm2 child processes do
# inherit some shell env from the daemon, but daemon env is a stale
# snapshot from whenever it was first started — fine for a fresh box,
# unreliable after the first deploy. Listing vars here makes each
# pm2 reload pick up the latest env.prod. Add new vars here when a
# service starts depending on them.
cat > ~/agent-platform/ecosystem.config.cjs << PMEOF
module.exports = {
  apps: [
    {
      name: "web",
      script: "server.js",
      cwd: "$HOME/agent-platform/apps/web/.next/standalone/apps/web",
      env: {
        PORT: 3000,
        HOSTNAME: "0.0.0.0",
        DATABASE_URL: "$DATABASE_URL",
        REDIS_URL: "$REDIS_URL",
        AUTH_SECRET: "$AUTH_SECRET",
        AUTH_TRUST_HOST: "true",
        AUTH_URL: "$AUTH_URL",
        AGENT_RUNTIME_URL: "$AGENT_RUNTIME_URL",
        WEB_BASE_URL: "$WEB_BASE_URL",
        INTERNAL_JWT_SECRET: "$INTERNAL_JWT_SECRET",
        LOG_DIR: "$LOG_DIR",
        // Image upload (Tencent COS STS).
        TENCENT_SECRET_ID: "$TENCENT_SECRET_ID",
        TENCENT_SECRET_KEY: "$TENCENT_SECRET_KEY",
        TENCENT_COS_BUCKET: "$TENCENT_COS_BUCKET",
        TENCENT_COS_REGION: "$TENCENT_COS_REGION",
        // Web search tools (web_search / search_lyrics / fetch_url).
        WEB_SEARCH_PRIMARY: "$WEB_SEARCH_PRIMARY",
        WEB_SEARCH_FALLBACK: "$WEB_SEARCH_FALLBACK",
        BOCHA_API_KEY: "$BOCHA_API_KEY",
        TAVILY_API_KEY: "$TAVILY_API_KEY",
        // TTS — without these /api/tts silently falls back to the
        // mock provider and you get a 1.2s silent mp3.
        MINIMAX_API_KEY: "$MINIMAX_API_KEY",
        MINIMAX_BASE_URL: "$MINIMAX_BASE_URL",
        MINIMAX_TTS_MODEL: "$MINIMAX_TTS_MODEL",
        MINIMAX_GROUP_ID: "$MINIMAX_GROUP_ID",
        TTS_PROVIDER: "$TTS_PROVIDER",
      },
    },
    {
      name: "agent-runtime",
      script: "services/agent-runtime/dist/index.js",
      cwd: "$HOME/agent-platform",
      env: {
        PORT: 3001,
        LOG_DIR: "$LOG_DIR",
        LLM_API_KEY: "$LLM_API_KEY",
        LLM_BASE_URL: "$LLM_BASE_URL",
        LLM_MODEL: "$LLM_MODEL",
        LLM_MODEL_PRO: "$LLM_MODEL_PRO",
        MOCK_LLM: "$MOCK_LLM",
        // Vision routing (kept in case a future feature re-enables
        // multimodal chat through the runtime; current caption flow
        // runs in memory-worker).
        KIMI_API_KEY: "$KIMI_API_KEY",
        KIMI_BASE_URL: "$KIMI_BASE_URL",
        KIMI_VISION_MODEL: "$KIMI_VISION_MODEL",
      },
    },
    {
      name: "memory-worker",
      script: "services/memory-worker/dist/index.js",
      cwd: "$HOME/agent-platform",
      env: {
        DATABASE_URL: "$DATABASE_URL",
        REDIS_URL: "$REDIS_URL",
        LOG_DIR: "$LOG_DIR",
        LLM_API_KEY: "$LLM_API_KEY",
        LLM_BASE_URL: "$LLM_BASE_URL",
        LLM_MODEL: "$LLM_MODEL",
        // caption-image job calls Kimi vision. Without these the
        // caption never lands and the chat agent keeps seeing
        // "[图片：描述生成中]" forever.
        KIMI_API_KEY: "$KIMI_API_KEY",
        KIMI_BASE_URL: "$KIMI_BASE_URL",
        KIMI_VISION_MODEL: "$KIMI_VISION_MODEL",
      },
    },
    {
      name: "realtime-gateway",
      script: "services/realtime-gateway/dist/index.js",
      cwd: "$HOME/agent-platform",
      env: {
        GATEWAY_PORT: "$GATEWAY_PORT",
        REDIS_URL: "$REDIS_URL",
        LOG_DIR: "$LOG_DIR",
      },
    },
  ],
};
PMEOF

# --- Start services ---
echo "=== Starting services ==="
pm2 delete all 2>/dev/null || true
pm2 start ~/agent-platform/ecosystem.config.cjs
pm2 save

echo ""
echo "=== Deploy complete! ==="
pm2 list
