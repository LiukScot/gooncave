#!/usr/bin/env sh
set -e

bun dist/migrate.js
exec bun --smol dist/index.js
