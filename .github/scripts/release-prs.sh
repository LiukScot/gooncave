#!/usr/bin/env bash
# Prints, as a JSON array, the pull requests merged in <from>..<to> that change
# what <platform> ships: number, title, body and label names. Dependency bumps
# and changes to Markdown only are left out, so a week with nothing else is a
# week without a release.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo 'Usage: release-prs.sh <desktop|ios> <from tag, or empty> <to commit>' >&2
  exit 2
fi
platform="$1"
from="$2"
to="$3"

case "$platform" in
  desktop) paths='^(core|desktop|frontend)/|^Cargo\.(toml|lock)$|^rust-toolchain\.toml$' ;;
  ios) paths='^ios/' ;;
  *)
    echo "Unknown platform: $platform" >&2
    exit 2
    ;;
esac

# Squash merges end their subject with the pull request number.
numbers=$(git log --format=%s "${from:+$from..}$to" | sed -nE 's/.*\(#([0-9]+)\)$/\1/p')
result='[]'
errors=$(mktemp)
trap 'rm -f "$errors"' EXIT
for number in $numbers; do
  # shortcut: gh lists the first 100 files of a pull request; a larger one
  # that touches the platform only past that point is missed.
  # A subject can also end with an issue number, which is not a pull request;
  # any other failure stops the run instead of dropping a pull request unseen.
  if ! pr=$(gh pr view "$number" --repo "$GITHUB_REPOSITORY" --json number,title,body,labels,files 2> "$errors"); then
    grep -q 'Could not resolve to a PullRequest' "$errors" && continue
    cat "$errors" >&2
    exit 1
  fi
  result=$(jq --argjson pr "$pr" --arg paths "$paths" '
    ($pr.labels | map(.name)) as $labels
    | if ($labels | index("dependencies")) == null
         and ($pr.files | any(.path | test($paths) and (test("\\.md$") | not)))
      then . + [{number: $pr.number, title: $pr.title, body: $pr.body, labels: $labels}]
      else .
      end' <<< "$result")
done
echo "$result"
