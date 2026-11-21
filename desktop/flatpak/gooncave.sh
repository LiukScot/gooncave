#!/bin/sh
# Chromium keeps its shared memory in TMPDIR, which must be private to the app.
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
export GOONCAVE_CORE=/app/lib/gooncave/gooncave-desktop
# Wayland when the session has it. Under XWayland with a fractional scale the GPU draws the
# page being left as a white picture during page animations.
exec zypak-wrapper /app/lib/electron/electron --ozone-platform-hint=auto /app/lib/gooncave/electron "$@"
