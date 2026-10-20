# Releases and issue planning

GoonCave uses one release version for every supported platform. Desktop and
iPhone run the shared Rust core without a server
([ADR 0004](../adr/0004-flatpak-desktop-and-device-sync.md)).

## Platforms

| Platform | Release file | Status |
| --- | --- | --- |
| Desktop | `GoonCave-linux-x86_64.flatpak` | Linux supported; Windows installer planned |
| iPhone | `GoonCave-iphone.ipa` | Unsigned IPA; the owner signs it with KravaSign |
| Android | None | No release target is approved |

Every release rebuilds all supported platforms from the same commit, even if
only one platform changed. Package filenames are stable and omit the version. The release and tag identify
the shared version; the iPhone bundle also receives it during the build. A platform's
feature coverage is tracked separately in its roadmap and the
[feature inventory](feature-inventory.md); the shared number does not certify
that every feature works on every platform.

## Version numbers and tags

Use `MAJOR.MINOR.PATCH` and one Git tag `v<version>`, such as `v1.3.0`.
The workflow creates that tag with the draft release. Do not edit release
numbers in source files or push release tags by hand.

- `MAJOR`: an explicit decision by the owner; never advanced automatically.
- `MINOR`: at least one shipped pull request has the `enhancement` label.
- `PATCH`: other shipped changes.

The `dependencies` label excludes a dependency-only pull request from automatic
release detection. Markdown-only changes also do not trigger a release.
The collector reads app paths in `core/`, `frontend/`, `desktop/` and `ios/`,
the Cargo manifests and lockfile, and the Rust toolchain configuration.
`.github/scripts/release-prs.sh <previous tag> <commit>` lists the matching
squash-merged pull requests once each, including their titles, bodies and labels.

Database migrations, sync and backup formats keep their own versions.

### Migration from platform versions

Historical `desktop/v*`, `ios/v*`, `android/v*` and `release/<date>` tags and
releases remain available. Do not rename or delete them.

When there is no unified tag, the workflow uses the highest legacy platform
version reachable from `main` as its baseline. It advances `MINOR` if the
subsequent shipped changes include an enhancement, otherwise `PATCH`. It
creates this first unified release even when there are no subsequent shipped
changes, so both platforms acquire the shared version. For example, a legacy
maximum of `1.2.1` becomes `1.2.2` without an enhancement, or `1.3.0` with one.
With no version tags at all, the first version is `1.0.0`.

Later runs compare against the highest `v<version>` tag reachable from `main`,
including drafts. With no shipped changes and no version override, there is
no release. An explicit version must be valid `MAJOR.MINOR.PATCH`, contain no
leading zeroes, exceed the baseline and have no existing `v<version>` tag.
Existing legacy drafts remain unchanged; review them separately before publishing.

## Building and publishing

The owner's scheduled agent starts `Weekly release` once a week. The owner
can also request a run:

```sh
gh workflow run weekly-release.yml --ref main
```

To choose one version for all platforms:

```sh
gh workflow run weekly-release.yml --ref main -f version=1.3.0
```

The workflow:

1. Chooses one version from merged changes or the explicit override.
2. Builds Flatpak and IPA from the workflow's `main` commit with that version.
3. Waits for both builds and tests to succeed.
4. Creates a draft titled `GoonCave <version>`, tagged `v<version>`, with both
   files and empty notes, then pushes the tag at that same commit. It never
   carries old binaries into a new release.

A build failure prevents the draft. No checksum or metadata files are attached.
The iPhone bundle receives the shared version during its build; source package
versions remain development placeholders. CI builds use the same package
filenames inside run-specific artifacts and are not releases.

The agent that started the run writes `**New**` and `**Fixed**` lists; omit
empty lists. Mention the platform when a change applies only there. Compare
with the previous release's code; PR descriptions and labels are only hints.
Describe each fix as the problem the user had. A bug introduced and fixed
between the two tags is not a release fix. Use short sentences for app users,
without PR numbers or internal details.

Test the files attached to the draft before publishing. Only the owner
publishes. To reject a draft, the owner deletes the draft and its `v<version>`
tag together, so the next run does not skip those changes.

## Milestones

Capability milestones do not assign separate platform versions:

- `Core N — <scope>` for shared core capabilities.
- `Desktop — <scope>` for desktop capabilities.
- `iOS — <scope>` for iPhone capabilities.

| Milestone | Target |
| --- | --- |
| `Core 1 — Foundations` | The core runs, stores data in SQLite and serves the existing HTTP API on the device |
| `Core 2 — Library and search` | Folders, files, tags, tag database and search |
| `Core 3 — Boorus` | Every booru engine, Explore, favorites and subscriptions |
| `Core 4 — Processing and sync` | Source matching, duplicates, WD14 tagging and [sync](sync.md) |
| `iOS — Rust core on iPhone` | The core runs on iPhone with durable storage |
| `iOS — Standalone parity` | Every row of the [feature inventory](feature-inventory.md) works on iPhone |

The [iOS roadmap](../ios/README.md) owns iPhone capability planning. Historical
milestone names may contain old platform numbers; those are not release versions.
Create issues without a milestone unless the owner asks for one. Use
`platform:desktop`, `platform:ios` and `platform:android` labels for affected
distributions. Keep scope and acceptance criteria in the issue description.

## Parity

A platform reaches parity when every row of the
[feature inventory](feature-inventory.md) works on it. Platform restrictions
need a documented equivalent or an owner-approved exception.
