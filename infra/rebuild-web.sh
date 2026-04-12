#!/bin/bash
# Quick rebuild & restart the web app after code changes
# Usage: bash infra/rebuild-web.sh
set -e

cd ~/agent-platform

echo "=== Building web app ==="
pnpm --filter web build

echo "=== Copying standalone assets ==="
rm -rf apps/web/.next/standalone/apps/web/.next/static apps/web/.next/standalone/apps/web/public
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
[ -d apps/web/public ] && cp -r apps/web/public apps/web/.next/standalone/apps/web/public || true

echo "=== Restarting web service ==="
pm2 restart web

echo ""
echo "=== Done! ==="
pm2 show web | grep -E 'status|pid|cwd'
