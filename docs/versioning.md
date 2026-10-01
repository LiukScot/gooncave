# Platform releases and issue planning

Decision: 2026-09-26. PC, Android, and iOS have independent versions.

## Version numbers

Use `MAJOR.MINOR.PATCH` for each distribution. A new minor-release milestone
advances `MINOR` and resets `PATCH`. A release that ships issues delivered
outside milestones advances `PATCH` once on each distribution that includes the
changes, however many issues it carries. A major-version change requires the
owner's explicit decision.

Creating milestones reserves future versions. Creating, triaging, closing an
unimplemented report, or moving an issue does not publish a version.

## Publishing a release

The release tag is the version. No file in the repository has to change.

1. Push a tag on a commit of `main`: `git tag pc/v1.0.1 && git push origin pc/v1.0.1`.
2. The `Platform release` workflow builds that platform from the tagged commit
   and opens a draft GitHub Release with the files, their checksums and the
   pull requests merged since the platform's previous tag.
3. Test the files attached to the draft, edit the notes if needed, then publish
   it. Publishing is the owner's approval.

A rejected draft is deleted together with its tag.

Use these identities:

| Distribution | Milestone example | Release tag example | Agreed target |
| --- | --- | --- | --- |
| PC | `PC 1.0.0 — Packaged server edition` | `pc/v1.0.0` | Downloadable Linux distribution using Docker; Windows deferred to PC 1.3.0 |
| iOS | `iOS 0.1.0 — Complete server client` | `ios/v0.1.0` | Fully functional iPhone client for the existing server |
| iOS | `iOS 1.0.0 — Standalone feature parity` | `ios/v1.0.0` | Existing feature set works locally; server mode remains available in the same app |
| Android | `<Android version> — <scope>` | `android/v<version>` | Independent future track; no Android implementation or release target approved here |

PC refers to a distribution that can run on a regular computer or a dedicated
server. PC 1.0.0 has a Linux installer with Docker as a prerequisite. Windows
installation is deferred to a later PC milestone. The existing self-hosted web
interface remains part of the product. A separate browser-only website is not
planned.

Server API compatibility, local database migrations, and backup formats have
their own versions. Matching application version numbers do not establish API
compatibility. An iOS release must state its supported server versions.
The server reports its native client contract as `apiVersion` in `/health`;
increment it on any change that breaks installed app shells.

## Owner issues and community issues

Normal issues created by `LiukScot`, including those created by an agent acting
for the owner, need a release milestone. Documentation, small hotfixes, and
isolated maintenance may remain outside milestones.

Other users can submit reports without a milestone. Do not reject their reports,
block issue creation, or automatically assign a release. The owner assigns them
manually when needed. No issue form or automation should require a milestone
from community contributors.

GitHub allows one milestone per issue. Use `platform:pc`, `platform:ios`, and
`platform:android` labels for affected distributions. For distinct delivery work,
create linked platform issues rather than pretending one milestone schedules
three releases. Reuse shared code and link its implementation issue; do not
duplicate the same implementation in each platform.

Keep the scope and acceptance criteria in the issue description. Move unfinished
owner-planned work into a linked milestone issue before closing the original.
Empty milestones are allowed. Preserve closed release history.

## Initial planning boundaries

The existing backlog is grouped into no more than three future PC minor releases:
1.1.0 for reliability and subscriptions, 1.2.0 for browsing features and product
research, and 1.3.0 for integration research. This is the initial organization,
not a permanent limit of three milestones.

The [iOS section](../ios/README.md) owns the iPhone roadmap from 0.1.0 to 1.0.0.
The app gains standalone capabilities incrementally through one server/local
toggle. Switching mode does not silently copy, merge, delete, or upload data.

An iOS parity release must compare against an explicit existing-feature inventory.
Additions shipped on PC during the port require an explicit parity-scope update.
Platform restrictions need a documented equivalent or an owner-approved exception;
they cannot be silently used to declare unfinished parity complete.
