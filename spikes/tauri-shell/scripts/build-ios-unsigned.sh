#!/bin/bash
# Builds an unsigned arm64 IPA of the shell spike, ready to re-sign with KravaSign.
# Runs on macOS from spikes/tauri-shell, after `tauri ios init`.
# Usage: scripts/build-ios-unsigned.sh <output.ipa>
set -euo pipefail

OUTPUT="${1:?usage: build-ios-unsigned.sh <output.ipa>}"
TAURI=(npx --yes @tauri-apps/cli@2.12.2)
PROJECT_YML="src-tauri/gen/apple/project.yml"

if [[ ! -f "$PROJECT_YML" ]]; then
  echo "Error: $PROJECT_YML not found. Run 'tauri ios init' first." >&2
  exit 1
fi

# `--no-sign` alone does not reach `xcodebuild archive`, which still asks for a
# development team. Turning signing off in project.yml, which xcodegen renders
# into the Xcode project, is what makes the archive succeed.
python3 - "$PROJECT_YML" <<'PYEOF'
import sys
path = sys.argv[1]
lines = open(path).read().splitlines(keepends=True)
targets = next(i for i, l in enumerate(lines) if l.rstrip('\n') == 'targets:')
ios = next(i for i in range(targets + 1, len(lines))
           if lines[i].startswith('  ') and lines[i].rstrip('\n').endswith('_iOS:'))
settings = next(i for i in range(ios + 1, len(lines)) if lines[i].rstrip('\n') == '    settings:')
if lines[settings + 1].rstrip('\n') != '      base:':
    sys.exit('project.yml: unexpected settings layout under the iOS target')
lines[settings + 2:settings + 2] = [
    '        CODE_SIGNING_ALLOWED: NO\n',
    '        CODE_SIGNING_REQUIRED: NO\n',
    '        CODE_SIGN_IDENTITY: ""\n',
    '        CODE_SIGN_STYLE: Manual\n',
]
open(path, 'w').writelines(lines)
PYEOF
(cd src-tauri/gen/apple && xcodegen generate)

BUILD_START="$(mktemp)"
trap 'rm -f "$BUILD_START"' EXIT
"${TAURI[@]}" ios build --target aarch64 --no-sign --archive-only

# The archive lands either in gen/apple/build or in DerivedData; only one written
# during this run counts, so a stale archive is never packaged.
ARCHIVE="$(
  find src-tauri/gen/apple/build "$HOME/Library/Developer/Xcode/DerivedData" \
    -name '*_iOS.xcarchive' -type d 2>/dev/null | while IFS= read -r dir; do
    if [[ -f "$dir/Info.plist" && "$dir/Info.plist" -nt "$BUILD_START" ]]; then echo "$dir"; fi
  done | sort | tail -n1
)"
if [[ -z "$ARCHIVE" ]]; then
  echo "Error: no .xcarchive from this build was found." >&2
  exit 1
fi
APP="$(find "$ARCHIVE/Products/Applications" -maxdepth 1 -name '*.app' -type d | head -n1)"
if [[ -z "$APP" ]]; then
  echo "Error: no .app inside $ARCHIVE." >&2
  exit 1
fi

STAGE="$(mktemp -d)"
mkdir "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/"
(cd "$STAGE" && zip -qry ipa.zip Payload)
mv "$STAGE/ipa.zip" "$OUTPUT"
rm -rf "$STAGE"

BINARY="$APP/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")"
if [[ "$(lipo -info "$BINARY")" != *arm64* ]]; then
  echo "Error: $BINARY is not arm64." >&2
  exit 1
fi
if codesign -dv "$APP" >/dev/null 2>&1; then
  echo "Error: the app is signed; the IPA must be unsigned." >&2
  exit 1
fi
shasum -a 256 "$OUTPUT"
