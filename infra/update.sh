#!/bin/bash
set -e

cd ~/agent-platform

echo "=== Pull latest code ==="
git pull

echo "=== Install deps ==="
pnpm install

echo "=== Build ==="
pnpm -r build

echo "=== Restart services ==="
pm2 restart all

echo "=== Done! ==="
pm2 list
