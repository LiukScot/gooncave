#!/usr/bin/env bash
# Builds the Flatpak repository site from one release bundle.
# Usage: flatpak-repo.sh <bundle.flatpak> <site dir> <site URL>
# Needs the signing key in the default GnuPG home. The site holds only this
# release, so its size does not grow with every release.
set -euo pipefail

bundle=$1
site=$2
url=${3%/}
key=$(bash "$(dirname "$0")/flatpak-key.sh")

rm -rf "$site"
mkdir -p "$site"
ostree init --mode=archive --repo="$site/repo"
flatpak build-import-bundle --gpg-sign="$key" "$site/repo" "$bundle"
flatpak build-update-repo --gpg-sign="$key" --title=GoonCave \
  --default-branch=master "$site/repo"

public_key=$(gpg --batch --export "$key" | base64 -w0)
runtime_repo=https://dl.flathub.org/repo/flathub.flatpakrepo
cat > "$site/gooncave.flatpakrepo" <<EOF
[Flatpak Repo]
Title=GoonCave
Url=$url/repo/
Homepage=https://github.com/LiukScot/gooncave
DefaultBranch=master
GPGKey=$public_key
EOF
cat > "$site/gooncave.flatpakref" <<EOF
[Flatpak Ref]
Name=app.gooncave.desktop
Branch=master
Title=GoonCave
Url=$url/repo/
SuggestRemoteName=gooncave
RuntimeRepo=$runtime_repo
IsRuntime=false
GPGKey=$public_key
EOF
