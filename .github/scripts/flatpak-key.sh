#!/usr/bin/env bash
# Prints the fingerprint of the Flatpak signing key in the default GnuPG home.
# Installs made from a release's .flatpak file verify updates with the public
# key in desktop/flatpak/gooncave-repo.gpg, so the two must match.
set -euo pipefail

key=$(gpg --batch --list-secret-keys --with-colons | awk -F: '/^fpr/ { print $10; exit }')
if [[ -z "$key" ]]; then
  echo '::error::No signing key: set the FLATPAK_GPG_PRIVATE_KEY secret.' >&2
  exit 1
fi
public=$(dirname "$0")/../../desktop/flatpak/gooncave-repo.gpg
committed=$(gpg --batch --show-keys --with-colons "$public" | awk -F: '/^fpr/ { print $10; exit }')
if [[ "$key" != "$committed" ]]; then
  echo "::error::The signing key $key is not the one in desktop/flatpak/gooncave-repo.gpg ($committed): see docs/versioning.md." >&2
  exit 1
fi
echo "$key"
