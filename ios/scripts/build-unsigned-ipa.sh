#!/bin/bash
# Builds an unsigned arm64 IPA of the iPhone app, ready to re-sign with KravaSign.
# Runs on macOS from ios/, after `npm ci` and `tauri ios init`.
# Usage: scripts/build-unsigned-ipa.sh <output.ipa> [version] [build]
# The version, like 0.1.0, is what iOS shows; without it the app reports 1.0.0.
# The build, like 0.1.42, tells two IPAs of one version apart; without it the build is the version.
set -euo pipefail

OUTPUT="${1:?usage: build-unsigned-ipa.sh <output.ipa> [version]}"
VERSION="${2:-}"
BUILD="${3:-}"
if [[ -n "$BUILD" && ! "$BUILD" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: '$BUILD' is not a build number like 0.1.42." >&2
  exit 1
fi
# macOS bash 3.2 treats an empty array as unset under `set -u`, hence the `+` expansion below.
CONFIG=()
if [[ -n "$VERSION" ]]; then
  if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: '$VERSION' is not a version like 0.1.0." >&2
    exit 1
  fi
  CONFIG=(--config "{\"version\":\"$VERSION\"}")
fi
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
STAGE=""
trap 'rm -rf "$BUILD_START" ${STAGE:+"$STAGE"}' EXIT
npm run tauri -- ios build --target aarch64 --no-sign --archive-only ${CONFIG[@]+"${CONFIG[@]}"}

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

if [[ -n "$BUILD" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" "$APP/Info.plist"
fi

BINARY="$APP/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")"
if [[ "$(lipo -info "$BINARY")" != *arm64* ]]; then
  echo "Error: $BINARY is not arm64." >&2
  exit 1
fi
# The share extension is built here, not through Tauri's generated project, whose layout
# belongs to Tauri. It is unsigned like the app and signed with it when the IPA is re-signed.
APPEX="$APP/PlugIns/ShareExtension.appex"
mkdir -p "$APPEX"
xcrun --sdk iphoneos swiftc -O -target arm64-apple-ios16.0 -module-name ShareExtension \
  -parse-as-library -application-extension \
  -Xlinker -e -Xlinker _NSExtensionMain \
  -o "$APPEX/ShareExtension" ShareExtension/ShareViewController.swift
cp ShareExtension/Info.plist "$APPEX/Info.plist"
app_plist_value() { /usr/libexec/PlistBuddy -c "Print :$1" "$APP/Info.plist"; }
# An extension must carry its app's versions and an identifier inside the app's.
/usr/libexec/PlistBuddy \
  -c "Set :CFBundleIdentifier $(app_plist_value CFBundleIdentifier).share" \
  -c "Set :CFBundleShortVersionString $(app_plist_value CFBundleShortVersionString)" \
  -c "Set :CFBundleVersion $(app_plist_value CFBundleVersion)" \
  "$APPEX/Info.plist"

# The photo library code is Swift that the app loads at startup; see src-tauri/src/photos.rs.
mkdir -p "$APP/Frameworks"
xcrun --sdk iphoneos swiftc -O -target arm64-apple-ios16.0 -module-name GoonCavePhotos \
  -parse-as-library -emit-library \
  -Xlinker -install_name -Xlinker @rpath/libGoonCavePhotos.dylib \
  -o "$APP/Frameworks/libGoonCavePhotos.dylib" PhotoLibrary/PhotoLibrary.swift

if codesign -dv "$APP" >/dev/null 2>&1; then
  echo "Error: the app is signed; the IPA must be unsigned." >&2
  exit 1
fi

STAGE="$(mktemp -d)"
mkdir "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/"
(cd "$STAGE" && zip -qry ipa.zip Payload)
mv "$STAGE/ipa.zip" "$OUTPUT"
shasum -a 256 "$OUTPUT"
