#!/bin/bash
# Test production build locally before deploying
# Usage: bash infra/test-prod.sh
set -e

cd "$(dirname "$0")/.."

echo "=== Building ==="
pnpm -r build

echo "=== Copying static assets ==="
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

echo "=== Starting production server (Ctrl+C to stop) ==="
echo "Open http://localhost:3000 to test"
node apps/web/.next/standalone/apps/web/server.js
