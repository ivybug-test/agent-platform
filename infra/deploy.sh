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

# --- Copy static assets ---
echo "=== Copying static assets ==="
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

# --- Create pm2 ecosystem ---
echo "=== Creating pm2 ecosystem ==="
cat > ~/agent-platform/ecosystem.config.cjs << PMEOF
module.exports = {
  apps: [
    {
      name: "web",
      script: "apps/web/.next/standalone/apps/web/server.js",
      cwd: "$HOME/agent-platform",
      env: {
        PORT: 3000,
        HOSTNAME: "0.0.0.0",
        DATABASE_URL: "$DATABASE_URL",
        REDIS_URL: "$REDIS_URL",
        AUTH_SECRET: "$AUTH_SECRET",
        AUTH_TRUST_HOST: "true",
        AGENT_RUNTIME_URL: "$AGENT_RUNTIME_URL",
      },
    },
    {
      name: "agent-runtime",
      script: "services/agent-runtime/dist/index.js",
      cwd: "$HOME/agent-platform",
      env: {
        PORT: 3001,
        LLM_API_KEY: "$LLM_API_KEY",
        LLM_BASE_URL: "$LLM_BASE_URL",
        LLM_MODEL: "$LLM_MODEL",
        MOCK_LLM: "$MOCK_LLM",
      },
    },
    {
      name: "memory-worker",
      script: "services/memory-worker/dist/index.js",
      cwd: "$HOME/agent-platform",
      env: {
        DATABASE_URL: "$DATABASE_URL",
        REDIS_URL: "$REDIS_URL",
        LLM_API_KEY: "$LLM_API_KEY",
        LLM_BASE_URL: "$LLM_BASE_URL",
        LLM_MODEL: "$LLM_MODEL",
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
