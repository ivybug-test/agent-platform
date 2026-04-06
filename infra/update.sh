#!/bin/bash
# Daily update — pull code, rebuild, restart services
# Usage: ./infra/update.sh
set -e

cd ~/agent-platform

echo "=== Pulling latest code ==="
git pull

echo "=== Installing dependencies ==="
pnpm install

echo "=== Building ==="
pnpm -r build

echo "=== Copying static assets ==="
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

echo "=== Pushing database schema ==="
ln -sf ~/agent-platform/infra/.env.prod ~/agent-platform/.env
cd packages/db
pnpm db:push
cd ~/agent-platform

echo "=== Restarting services ==="
# Reload env into ecosystem config
set -a
source infra/.env.prod
export AUTH_TRUST_HOST=true
set +a

# Regenerate ecosystem config with current env
./infra/deploy.sh

echo ""
echo "=== Update complete! ==="
