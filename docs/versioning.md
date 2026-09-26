# Platform releases and issue planning

Decision: 2026-09-26. PC, Android, and iOS have independent versions.

## Version numbers

Use `MAJOR.MINOR.PATCH` for each distribution. A new minor-release milestone
advances `MINOR` and resets `PATCH`. A delivered issue outside milestones advances
`PATCH` once on each distribution that ships the change. A major-version change
requires the owner's explicit decision.

Creating milestones reserves future versions. Creating, triaging, closing an
unimplemented report, or moving an issue does not publish a version. Update a
distribution's manifest/version metadata only when preparing its actual release.
List the changes since that distribution's previous release in the version PR.

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
