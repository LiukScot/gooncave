# Platform releases and issue planning

GoonCave ships a desktop app and an iPhone app, with independent versions.
Both run on one Rust core with no server
([ADR 0004](../adr/0004-flatpak-desktop-and-device-sync.md)).

## Platforms

| Platform | Files | Tags | Status |
| --- | --- | --- | --- |
| Desktop | Linux `.flatpak`; Windows `.exe` installer when Windows is supported | `desktop/v<version>`, starting at `1.0.0` | Not released yet |
| iOS | Unsigned IPA | `ios/v<version>` | Not released yet |
| Android | None | `android/v<version>` reserved | No release target is approved |

Linux and Windows share one desktop version.

On every platform, `1.0.0` is the Rust version with full parity with the
[feature inventory](feature-inventory.md). Versions before it are `0.x`.

The first desktop release is `1.0.0`. The iPhone app joins the release once
the repository builds it.

## Version numbers

Use `MAJOR.MINOR.PATCH` for each platform. The tags `desktop/v1.2.0`,
`ios/v0.1.0`, `android/v<version>` mark the commit of each version; the
release workflow creates them. No file in the repository holds a release
number. A major-version change requires the owner's explicit decision.

| Platform | `MINOR` advances when | `PATCH` advances when |
| --- | --- | --- |
| Desktop | The release contains at least one pull request labeled `enhancement` | The release contains only fixes |
| iOS | A roadmap milestone is complete; given to the workflow by hand | The release contains changes to the iPhone app |

Local database migrations, the sync format and backup formats have their own
versions, separate from application versions.

## Pull request labels

The label of a pull request decides the desktop release number.

- `enhancement`: a user gains something new.
- `bug`: something that was wrong is fixed.
- `dependencies`: a dependency bump. It never causes a release by itself.
- `documentation` or no label: work users do not notice.

Which platform a pull request belongs to is read from the files it changes.
`.github/scripts/release-prs.sh` holds the path list for each platform.

## Publishing a release

There is one GitHub Release for the whole project, titled
`GoonCave — Desktop <version>, iPhone <version>`. It always carries the
current file of every platform, so it is a complete download page. Until the
repository builds the iPhone app, it carries only the desktop
`GoonCave-<version>-linux-x86_64.flatpak` and is titled
`GoonCave — Desktop <version>`.

The owner's scheduled agent starts the `Weekly release` workflow once a week.
To start it at another time:

```sh
gh workflow run weekly-release.yml --ref main
```

For each platform, the workflow lists the pull requests merged since the
platform's last tag that change what it ships, and picks the next version from
the table above. A platform with none keeps its version. With nothing new on
any platform, there is no release.

To choose the desktop version instead:

```sh
gh workflow run weekly-release.yml --ref main -f desktop_version=1.0.0
```

With no `desktop/v*` tag yet, the workflow picks `1.0.0`.

The workflow then:

1. builds the platforms that have a new version from the head of `main`;
2. takes the file of a platform with nothing new from the latest published
   release;
3. opens a draft release tagged `release/<date>` with the files and the
   download instructions. No checksum or metadata files are attached;
4. pushes the `desktop/v<version>` and `ios/v<version>` tags of the versions
   it released.

The agent that started the run then writes, at the top of the notes, for each
platform, what is new and what was fixed for users, from the titles and
descriptions of the pull requests. Fixes are worded as the problem the user
had.

Test the files attached to the draft, edit the notes if needed, then publish
it. Publishing is the owner's approval. To reject a draft, delete it and the
platform tags the run pushed.

## Milestones

Every milestone is named after its platform and scope:

- `Core N — <scope>` for the Rust core, shared by every platform.
- `Desktop <version> — <scope>` for the desktop app.
- `iOS <version> — <scope>` for the iPhone app.

| Milestone | Target |
| --- | --- |
| `Core 1 — Foundations` | The core runs, stores data in SQLite and serves the existing HTTP API on the device |
| `Core 2 — Library and search` | Folders, files, tags, tag database and search |
| `Core 3 — Boorus` | Every booru engine, Explore, favorites and subscriptions |
| `Core 4 — Processing and sync` | Source matching, duplicates, WD14 tagging and [sync](sync.md) |
| `iOS 0.1.0 — Rust core on iPhone` | The core runs on iPhone with durable storage |
| `iOS 1.0.0 — Standalone parity` | Every row of the [feature inventory](feature-inventory.md) works on iPhone |

The [iOS section](../ios/README.md) owns the iPhone roadmap.

Issues created by `LiukScot`, including those created by an agent acting for
the owner, need a milestone. Documentation, small hotfixes, and isolated
maintenance may remain outside milestones. Other users can submit reports
without a milestone; the owner assigns them when needed.

GitHub allows one milestone per issue. Use `platform:desktop`, `platform:ios`,
and `platform:android` labels for affected distributions. For distinct
delivery work, create linked platform issues. Keep the scope and acceptance
criteria in the issue description. Move unfinished milestone work into a
linked milestone issue before closing the original.

## Parity

A platform reaches parity when every row of the
[feature inventory](feature-inventory.md) works on it. Platform restrictions
need a documented equivalent or an owner-approved exception; they cannot be
silently used to declare unfinished parity complete.
