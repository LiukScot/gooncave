#!/usr/bin/env bash
# Writes the shared release version and source commit to GITHUB_OUTPUT.
set -euo pipefail

if [[ "$GITHUB_REF" != refs/heads/main ]]; then
  echo '::error::Start the release from main: gh workflow run weekly-release.yml --ref main'
  exit 1
fi
head=$(git rev-parse HEAD)
version_pattern='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
tags=$(git tag --merged "$head")
previous=$(grep -E "^v${version_pattern}$" <<< "$tags" | sort -V | tail -n1 || true)
baseline="$previous"
if [[ -z "$baseline" ]]; then
  # Preserve existing downloads and continue above the highest legacy version.
  baseline=$(grep -E "^(desktop|ios|android)/v${version_pattern}$" <<< "$tags" \
    | sed 's|.*/v||' | sort -V | tail -n1 || true)
  if [[ -n "$baseline" ]]; then
    baseline=$(grep -E "^(desktop|ios|android)/v${baseline//./\\.}$" <<< "$tags" | head -n1)
  fi
fi
next=''
if [[ -n "${FORCED:-}" ]]; then
  if [[ ! "$FORCED" =~ ^${version_pattern}$ ]]; then
    echo "::error::'$FORCED' is not a version like 1.2.3 (without leading zeroes)."
    exit 1
  fi
  if [[ -n "$baseline" && ( "$FORCED" == "${baseline##*v}" || $(printf '%s\n' "${baseline##*v}" "$FORCED" | sort -V | tail -n1) != "$FORCED" ) ]]; then
    echo "::error::$FORCED must be above ${baseline##*v}."
    exit 1
  fi
  next="$FORCED"
elif [[ -z "$baseline" ]]; then
  next=1.0.0
else
  prs=$(bash "$(dirname "$0")/release-prs.sh" "$baseline" "$head")
  if [[ $(jq length <<< "$prs") -gt 0 || -z "$previous" ]]; then
    IFS=. read -r major minor patch <<< "${baseline##*v}"
    if jq -e 'any(.[]; .labels | index("enhancement") != null)' <<< "$prs" > /dev/null; then
      minor=$((minor + 1))
      patch=0
    else
      patch=$((patch + 1))
    fi
    next="$major.$minor.$patch"
  fi
fi
if [[ -z "$next" ]]; then
  echo 'Nothing new; no release.'
  exit 0
fi
if git rev-parse -q --verify "refs/tags/v$next" > /dev/null; then
  echo "::error::v$next already exists. Choose a higher version."
  exit 1
fi
{
  echo "sha=$head"
  echo "version=$next"
  echo "previous=$baseline"
  echo "release_tag=v$next"
} >> "$GITHUB_OUTPUT"
echo "GoonCave $next (previous tag ${baseline:-none})"
