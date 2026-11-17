#!/usr/bin/env bash
# Signs a CI Flatpak bundle and points it at the Flatpak repository, so an
# install made from the release's file updates from that repository.
# Usage: flatpak-bundle.sh <bundle> <signed bundle> <site URL>
# Needs the signing key in the default GnuPG home.
set -euo pipefail

bundle=$1
signed=$2
url=${3%/}
key=$(bash "$(dirname "$0")/flatpak-key.sh")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

ostree init --mode=archive --repo="$work/repo"
flatpak build-import-bundle --gpg-sign="$key" "$work/repo" "$bundle"
flatpak build-bundle --gpg-sign="$key" --repo-url="$url/repo/" \
  --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo \
  --gpg-keys="$(dirname "$0")/../../desktop/flatpak/gooncave-repo.gpg" \
  "$work/repo" "$signed" app.gooncave.desktop
