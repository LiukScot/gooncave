#!/usr/bin/env sh
set -e

export NODE_OPTIONS="--max-old-space-size=256"

node dist/migrate.js
exec node dist/index.js
