#!/bin/bash
# Daily update — pull code, rebuild, restart services
# Usage: ./infra/update.sh
set -e

cd ~/agent-platform

# Self-modifying-script guard: git pull may rewrite this very file, which
# confuses the bash stream reader and can cause random line-offset errors
# later in the run. Do the pull first, then re-exec the fresh script so the
# rest of the work executes against the updated file from byte 0. The
# env var flag prevents an infinite loop.
if [ -z "$AGENT_UPDATE_RESTARTED" ]; then
  echo "=== Pulling latest code ==="
  git pull
  export AGENT_UPDATE_RESTARTED=1
  exec "$0" "$@"
fi

echo "=== Installing dependencies ==="
pnpm install

echo "=== Building ==="
pnpm -r build

echo "=== Copying standalone assets ==="
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
cp -r apps/web/.next/server apps/web/.next/standalone/apps/web/.next/server

ln -sf ~/agent-platform/infra/.env.prod ~/agent-platform/.env

# pgvector extension MUST exist before db:push tries to ALTER TABLE with
# a `vector(1536)` column — otherwise db:push errors with
# `type "vector" does not exist`. Apply 0012 first.
PG_CONTAINER=$(docker ps --format '{{.Names}}' | grep -E 'postgres' | head -1)
if [ -n "$PG_CONTAINER" ]; then
  if [ -f "packages/db/drizzle/0012_pgvector.sql" ]; then
    echo "=== Pre-applying pgvector extension (0012) ==="
    docker exec -i "$PG_CONTAINER" psql -U postgres -d agent_platform < packages/db/drizzle/0012_pgvector.sql >/dev/null
  fi
else
  echo "  WARNING: no postgres container found; pgvector pre-step skipped"
fi

echo "=== Pushing database schema ==="
cd packages/db
pnpm db:push
cd ~/agent-platform

# Apply raw-SQL migrations for things db:push can't express (extensions,
# partial indexes, CHECK/UNIQUE constraints). All files are authored with
# IF NOT EXISTS / DO blocks so re-running is safe.
echo "=== Applying raw-SQL migrations (idempotent) ==="
if [ -n "$PG_CONTAINER" ]; then
  for sql in \
      packages/db/drizzle/0003_messages_trgm_index.sql \
      packages/db/drizzle/0004_memory_authorship.sql \
      packages/db/drizzle/0005_room_memories.sql \
      packages/db/drizzle/0006_user_relationships.sql \
      packages/db/drizzle/0007_memory_temporal.sql \
      packages/db/drizzle/0008_message_metadata.sql \
      packages/db/drizzle/0009_message_reply_to.sql \
      packages/db/drizzle/0010_agent_voice.sql \
      packages/db/drizzle/0011_agent_user_mood.sql \
      packages/db/drizzle/0012_pgvector.sql \
      packages/db/drizzle/0013_provenance.sql \
      packages/db/drizzle/0014_agent_memories.sql \
      packages/db/drizzle/0015_room_observations.sql; do
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
# Use POSIX `.` rather than bash-only `source` so this line works even when
# the script is invoked via `sh ./infra/update.sh` on a host where /bin/sh
# is dash (Ubuntu/Debian default).
set -a
. infra/.env.prod
export AUTH_TRUST_HOST=true
set +a

# Regenerate ecosystem config with current env
bash infra/deploy.sh

echo ""
echo "=== Update complete! ==="
