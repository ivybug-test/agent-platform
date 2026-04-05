#!/bin/bash
set -e

cd ~/agent-platform

echo "=== 1. Load env ==="
set -a
source infra/.env.prod
export AUTH_TRUST_HOST=true
set +a

echo "=== 2. Push database schema ==="
# Create .env symlink so drizzle.config.ts can find it
ln -sf ~/agent-platform/infra/.env.prod ~/agent-platform/.env
cd packages/db
pnpm db:push
cd ~/agent-platform

echo "=== 3. Setup Caddy ==="
cp infra/Caddyfile /etc/caddy/Caddyfile 2>/dev/null || true
caddy stop 2>/dev/null || true
caddy start --config /etc/caddy/Caddyfile 2>/dev/null || echo "Caddy not installed or failed, skipping HTTPS"

echo "=== 4. Copy static assets for standalone ==="
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

echo "=== 5. Create pm2 ecosystem ==="
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

echo "=== 6. Start services with pm2 ==="
pm2 delete all 2>/dev/null || true
pm2 start ~/agent-platform/ecosystem.config.cjs

pm2 save

echo ""
echo "=== Done! ==="
pm2 list
echo ""
echo "Visit https://testagent.fun or http://119.29.129.198:3000"
