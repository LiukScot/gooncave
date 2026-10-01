# Platform releases and issue planning

PC, Android, and iOS have independent versions. Both released platforms ship
weekly from what has merged. An iOS minor version also needs its roadmap
milestone to be complete.

## Version numbers

Use `MAJOR.MINOR.PATCH` for each distribution. The release tag is the version:
`pc/v1.2.0`, `ios/v0.2.0`, `android/v<version>`. No file in the repository
holds a release number. A major-version change requires the owner's explicit
decision.

| Distribution | `MINOR` advances when | `PATCH` advances when |
| --- | --- | --- |
| PC | The release contains at least one pull request labeled `enhancement` | The release contains only fixes |
| iOS | A roadmap milestone is complete; tagged by hand | The weekly release contains changes to the iPhone app |

Server API compatibility, local database migrations, and backup formats have
their own versions. Matching application version numbers do not establish API
compatibility. An iOS release must state its supported server versions.
The server reports its native client contract as `apiVersion` in `/health`;
increment it on any change that breaks installed app shells.

## Pull request labels

The label of a pull request decides the PC release number and the section of
the release notes it appears in.

- `enhancement`: a user gains something new.
- `bug`: something that was wrong is fixed.
- `dependencies`: a dependency bump. It never causes a release by itself.
- `documentation` or no label: work users do not notice.

Which platform a pull request belongs to is read from the files it changes:
`backend/`, `frontend/`, `tagger/`, `packaging/` and the Compose files are
PC; `ios/GoonCave/` is iOS.

## Publishing a release

### Every week

The owner's scheduled agent starts the `Weekly release` workflow once a week;
it can also be started by hand from the Actions tab. For each platform, the
workflow lists the pull requests merged since its last tag that change what it
ships. With none, it skips the platform. Otherwise it picks the next number,
tags `main` and starts `Platform release`.

### An iOS minor version, or a release on another day

Push the tag on a commit of `main`:

```sh
git tag ios/v0.2.0 && git push origin ios/v0.2.0
```

### What the tag starts

The `Platform release` workflow builds that platform from the tagged commit
and opens a draft GitHub Release with:

- the file built for that platform, plus the latest published file of every
  other platform under its own version, so each release is a complete
  download page. No checksum or metadata files are attached;
- a summary of what changed for users, written from the titles and
  descriptions of the pull requests in the release;
- the list of those pull requests, grouped by label
  (see `.github/release.yml`).

Test the files attached to the draft, edit the notes if needed, then publish
it. Publishing is the owner's approval. A rejected draft is deleted together
with its tag.

## Milestones

PC has no milestones: an issue ships in the weekly release that follows its
merge. The [iOS section](../ios/README.md) owns the iPhone roadmap from 0.1.0
to 1.0.0, one milestone per capability stage, named
`iOS <version> — <scope>`.

| Milestone | Release tag | Target |
| --- | --- | --- |
| `iOS 0.1.0 — Complete server client` | `ios/v0.1.0` | Fully functional iPhone client for the existing server |
| `iOS 1.0.0 — Standalone feature parity` | `ios/v1.0.0` | Existing feature set works locally; server mode remains available in the same app |

iOS issues created by `LiukScot`, including those created by an agent acting
for the owner, need a roadmap milestone. Documentation, small hotfixes, and
isolated maintenance may remain outside milestones. Other users can submit
reports without a milestone; the owner assigns them when needed.

GitHub allows one milestone per issue. Use `platform:pc`, `platform:ios`, and
`platform:android` labels for affected distributions. For distinct delivery
work, create linked platform issues. Keep the scope and acceptance criteria in
the issue description. Move unfinished iOS milestone work into a linked
milestone issue before closing the original.

## Platforms

PC refers to a distribution that can run on a regular computer or a dedicated
server. It has a Linux installer with Docker as a prerequisite; Windows
installation is not available. The existing self-hosted web interface remains
part of the product. A separate browser-only website is not planned.

The iPhone app gains standalone capabilities incrementally through one
server/local toggle. Switching mode does not silently copy, merge, delete, or
upload data.

An iOS parity release must compare against an explicit existing-feature
inventory. Additions shipped on PC during the port require an explicit
parity-scope update. Platform restrictions need a documented equivalent or an
owner-approved exception; they cannot be silently used to declare unfinished
parity complete.

Android has a reserved platform identity. No Android implementation or release
target is approved.
