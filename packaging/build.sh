#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Usage: packaging/build.sh <published 40-character commit SHA>' >&2
  exit 2
fi

sha="$1"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/dist/pc-installer"
mkdir -p "$out"
rm -f "$out/gooncave-install-windows-amd64.exe" "$out/SHA256SUMS"
flags="-X main.appImage=ghcr.io/liukscot/gooncave:$sha -X main.taggerImage=ghcr.io/liukscot/gooncave-tagger:$sha"

(
  cd "$root/packaging/installer"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$flags" -o "$out/gooncave-install-linux-amd64" .
)

(
  cd "$out"
  sha256sum gooncave-install-linux-amd64 > SHA256SUMS
)
echo "Built installer in $out"
