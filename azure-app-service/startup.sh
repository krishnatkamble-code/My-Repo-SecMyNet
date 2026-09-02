#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV=production
export PORT="${PORT:-8080}"

npm ci --omit=dev
exec node server.js
