#!/bin/bash
# First-time server setup — run once on a fresh Ubuntu server
# Usage: curl the repo, edit infra/.env.prod, then run this script
set -e

echo "========================================="
echo "  Agent Platform — Server Setup"
echo "========================================="
echo ""

cd ~/agent-platform

# --- 1. Install Node.js ---
echo "=== Installing Node.js 22 ==="
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "  Node: $(node -v)"

# --- 2. Install pnpm ---
echo "=== Installing pnpm ==="
if ! command -v pnpm &> /dev/null; then
  npm install -g pnpm@9.15.4
fi
echo "  pnpm: $(pnpm -v)"

# --- 3. Install pm2 ---
echo "=== Installing pm2 ==="
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2
fi
echo "  pm2: $(pm2 -v)"

# --- 4. Install Caddy ---
echo "=== Installing Caddy ==="
if ! command -v caddy &> /dev/null; then
  echo "  Caddy not found. Trying to install..."
  curl -o /usr/bin/caddy -L "https://caddyserver.com/api/download?os=linux&arch=amd64" && chmod +x /usr/bin/caddy || echo "  WARNING: Caddy install failed. Install manually or use a proxy."
fi
if command -v caddy &> /dev/null; then
  echo "  Caddy: $(caddy version)"
fi

# --- 5. Check .env.prod ---
if [ ! -f infra/.env.prod ]; then
  echo ""
  echo "ERROR: infra/.env.prod not found!"
  echo "Run: cp infra/.env.prod.example infra/.env.prod"
  echo "Then edit it with your passwords and API keys."
  exit 1
fi

# --- 6. Start PostgreSQL + Redis ---
echo "=== Starting PostgreSQL + Redis (Docker) ==="
cd infra
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
sleep 3
cd ~/agent-platform

# --- 7. Install dependencies ---
echo "=== Installing dependencies ==="
pnpm install

# --- 8. Build ---
echo "=== Building ==="
pnpm -r build

# --- 9. Symlink .env for drizzle ---
ln -sf ~/agent-platform/infra/.env.prod ~/agent-platform/.env

# --- 10. Run deploy ---
echo "=== Running deploy ==="
chmod +x infra/deploy.sh
./infra/deploy.sh

# --- 11. Setup pm2 startup ---
pm2 startup 2>/dev/null || true
pm2 save

echo ""
echo "========================================="
echo "  Setup complete!"
echo "  Visit https://testagent.fun"
echo "========================================="
