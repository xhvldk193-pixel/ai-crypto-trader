#!/bin/bash
# Local Railway build test script
# Simulates the Nixpacks build process defined in nixpacks.toml

set -e

echo "=== Railway Build Test ==="
echo ""

echo "[install] Installing dependencies..."
pnpm install --frozen-lockfile

echo ""
echo "[build] Building packages in order..."

echo "  -> @workspace/db"
pnpm --filter @workspace/db run build 2>/dev/null || true

echo "  -> @workspace/api-zod"
pnpm --filter @workspace/api-zod run build 2>/dev/null || true

echo "  -> @workspace/integrations-anthropic-ai"
pnpm --filter @workspace/integrations-anthropic-ai run build 2>/dev/null || true

echo "  -> @workspace/integrations-openai-ai-server"
pnpm --filter @workspace/integrations-openai-ai-server run build 2>/dev/null || true

echo "  -> @workspace/api-client-react"
pnpm --filter @workspace/api-client-react run build 2>/dev/null || true

echo "  -> @workspace/crypto-trader (frontend)"
PORT=3000 BASE_PATH=/ pnpm --filter @workspace/crypto-trader run build

echo "  -> Copying frontend assets to api-server/public/"
mkdir -p artifacts/api-server/public
cp -r artifacts/crypto-trader/dist/public/* artifacts/api-server/public/

echo "  -> @workspace/api-server"
pnpm --filter @workspace/api-server run build

echo ""
echo "=== Build complete! ==="
echo ""
echo "To start the server in production mode:"
echo "  NODE_ENV=production PORT=8080 pnpm --filter @workspace/api-server run start"
echo ""
echo "DB migration (run once before starting):"
echo "  pnpm --filter @workspace/db run push"
