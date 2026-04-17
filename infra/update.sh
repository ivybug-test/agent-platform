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

echo "=== Copying standalone assets ==="
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
cp -r apps/web/.next/server apps/web/.next/standalone/apps/web/.next/server

echo "=== Pushing database schema ==="
ln -sf ~/agent-platform/infra/.env.prod ~/agent-platform/.env
cd packages/db
pnpm db:push
cd ~/agent-platform

# Apply raw-SQL migrations that db:push can't express (extensions, trigram indexes).
# All statements are idempotent (IF NOT EXISTS), safe to re-run.
echo "=== Applying raw-SQL migrations (idempotent) ==="
PG_CONTAINER=$(docker ps --format '{{.Names}}' | grep -E 'postgres' | head -1)
if [ -n "$PG_CONTAINER" ]; then
  for sql in packages/db/drizzle/0003_messages_trgm_index.sql; do
    echo "  $sql"
    docker exec -i "$PG_CONTAINER" psql -U postgres -d agent_platform < "$sql" >/dev/null
  done
else
  echo "  WARNING: no postgres container found; raw-SQL migrations skipped"
fi

echo "=== Restarting services ==="
# Reload env into ecosystem config
set -a
source infra/.env.prod
export AUTH_TRUST_HOST=true
set +a

# Regenerate ecosystem config with current env
bash infra/deploy.sh

echo ""
echo "=== Update complete! ==="
