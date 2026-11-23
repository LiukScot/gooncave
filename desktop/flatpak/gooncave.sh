#!/bin/sh
# Chromium keeps its shared memory in TMPDIR, which must be private to the app.
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
export GOONCAVE_CORE=/app/lib/gooncave/gooncave-desktop
exec zypak-wrapper /app/lib/electron/electron /app/lib/gooncave/electron "$@"
