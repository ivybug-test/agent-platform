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

echo "=== 4. Start services with pm2 ==="
pm2 delete all 2>/dev/null || true

pm2 start apps/web/node_modules/.bin/next --name web -- start --port 3000
pm2 start services/agent-runtime/dist/index.js --name agent-runtime
pm2 start services/memory-worker/dist/index.js --name memory-worker

pm2 save

echo ""
echo "=== Done! ==="
pm2 list
echo ""
echo "Visit https://testagent.fun or http://119.29.129.198:3000"
