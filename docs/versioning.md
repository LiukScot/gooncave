# Platform releases and issue planning

PC, Android, and iOS have independent versions. Both released platforms ship
weekly from what has merged. An iOS minor version also needs its roadmap
milestone to be complete.

## Version numbers

Use `MAJOR.MINOR.PATCH` for each distribution. The tags `pc/v1.2.0`,
`ios/v0.2.0`, `android/v<version>` mark the commit of each version; the
release workflow creates them. No file in the repository holds a release
number. A major-version change requires the owner's explicit decision.

| Distribution | `MINOR` advances when | `PATCH` advances when |
| --- | --- | --- |
| PC | The release contains at least one pull request labeled `enhancement` | The release contains only fixes |
| iOS | A roadmap milestone is complete; given to the workflow by hand | The release contains changes to the iPhone app |

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

There is one GitHub Release for the whole project, titled
`GoonCave — PC <version>, iPhone <version>`. It always carries the current
file of every platform, so it is a complete download page.

The owner's scheduled agent starts the `Weekly release` workflow once a week.
To start it at another time:

```sh
gh workflow run weekly-release.yml --ref main
```

For each platform, the workflow lists the pull requests merged since the
platform's last tag that change what it ships, and picks the next version from
the table above. A platform with none keeps its version. With nothing new on
any platform, there is no release.

To choose a version instead, for example when an iOS milestone is complete:

```sh
gh workflow run weekly-release.yml --ref main -f ios_version=0.2.0
```

The workflow then:

1. builds the platforms that have a new version from the head of `main`;
2. takes the file of a platform with nothing new from the latest published
   release;
3. opens a draft release tagged `release/<date>` with both files, a summary of
   what changed for users written from the titles and descriptions of the
   pull requests, and the list of pull requests since the previous release,
   grouped by label (see `.github/release.yml`). No checksum or metadata files
   are attached;
4. pushes the `pc/v<version>` and `ios/v<version>` tags of the versions it
   released.

Test the files attached to the draft, edit the notes if needed, then publish
it. Publishing is the owner's approval. To reject a draft, delete it and the
platform tags the run pushed.

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
