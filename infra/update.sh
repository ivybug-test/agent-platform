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

# Apply raw-SQL migrations for things db:push can't express (extensions,
# partial indexes, CHECK/UNIQUE constraints). All files are authored with
# IF NOT EXISTS / DO blocks so re-running is safe.
echo "=== Applying raw-SQL migrations (idempotent) ==="
PG_CONTAINER=$(docker ps --format '{{.Names}}' | grep -E 'postgres' | head -1)
if [ -n "$PG_CONTAINER" ]; then
  for sql in \
      packages/db/drizzle/0003_messages_trgm_index.sql \
      packages/db/drizzle/0004_memory_authorship.sql \
      packages/db/drizzle/0005_room_memories.sql \
      packages/db/drizzle/0006_user_relationships.sql \
      packages/db/drizzle/0007_memory_temporal.sql; do
    if [ -f "$sql" ]; then
      echo "  $sql"
      docker exec -i "$PG_CONTAINER" psql -U postgres -d agent_platform < "$sql" >/dev/null
    fi
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
