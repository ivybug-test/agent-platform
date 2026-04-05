#!/bin/bash
set -e

echo "=== 1. Install Node.js 22 ==="
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v)"

echo "=== 2. Install pnpm ==="
if ! command -v pnpm &> /dev/null; then
  npm install -g pnpm@9.15.4
fi
echo "pnpm: $(pnpm -v)"

echo "=== 3. Install pm2 ==="
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2
fi
echo "pm2: $(pm2 -v)"

echo "=== 4. Install Caddy ==="
if ! command -v caddy &> /dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
echo "Caddy: $(caddy version)"

echo "=== 5. Start PostgreSQL + Redis (Docker) ==="
cd /root/agent-platform/infra
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
sleep 3

echo "=== 6. Install dependencies ==="
cd /root/agent-platform
pnpm install

echo "=== 7. Build ==="
pnpm -r build

echo "=== 8. Push database schema ==="
cd packages/db
DATABASE_URL=$(grep DATABASE_URL /root/agent-platform/infra/.env.prod | cut -d= -f2-) pnpm db:push

echo "=== 9. Setup Caddy ==="
cp /root/agent-platform/infra/Caddyfile /etc/caddy/Caddyfile
systemctl restart caddy

echo "=== 10. Start services with pm2 ==="
cd /root/agent-platform

# Load env vars
set -a
source infra/.env.prod
set +a

pm2 delete all 2>/dev/null || true

pm2 start apps/web/node_modules/.bin/next --name web -- start --port 3000
pm2 start services/agent-runtime/dist/index.js --name agent-runtime
pm2 start services/memory-worker/dist/index.js --name memory-worker

pm2 save
pm2 startup

echo ""
echo "=== Done! ==="
echo "Visit https://testagent.fun"
