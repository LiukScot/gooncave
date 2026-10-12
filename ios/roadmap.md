# iPhone release roadmap

Milestones are planned releases, not shipped versions. The iPhone app is
standalone and runs on the Rust core. See [the iOS overview](README.md) and
[the versioning policy](../docs/versioning.md).

## Dependencies on the core

iOS work depends on the Rust core milestones, shared with the desktop app:

| Milestone | Outcome |
| --- | --- |
| `Core 1 — Foundations` | The core runs, stores data in SQLite and serves the existing HTTP API on the device. |
| `Core 2 — Library and search` | Folders, files, tags, the tag database and search work in the core. |
| `Core 3 — Boorus` | Every booru engine, Explore, favorites and subscriptions work in the core. |
| `Core 4 — Processing and sync` | Source matching, duplicates, WD14 tagging and [sync](../docs/sync.md) work in the core. |

An iOS issue starts when the core milestone it needs is complete.

## Release sequence

| Milestone | Outcome |
| --- | --- |
| `iOS 0.2.0 — Rust core on iPhone` | The Rust core runs inside the Tauri app on iPhone. Data survives app updates. Media is stored on the device. Booru sessions and file import work. |
| `iOS 1.0.0 — Standalone parity` | Every row of the [feature inventory](../docs/feature-inventory.md) works on iPhone. Processing survives the iOS lifecycle. Data safety and performance are validated on a physical device. The standalone IPA is published. |

## Issues

### iOS 0.2.0 — Rust core on iPhone

| Issue | Depends on |
| --- | --- |
| Run the Rust core on iPhone and keep data across updates (#423) | Core 1 |
| Add durable on-device media storage and download queues (#424) | Run the Rust core on iPhone |
| Support Gelbooru and FurAffinity sessions on iPhone (#428) | Core 3; run the Rust core on iPhone |
| Import iPhone files and selected directories (#430) | Core 2; run the Rust core on iPhone |

### iOS 1.0.0 — Standalone parity

| Issue | Depends on |
| --- | --- |
| Run WD14 tagging on iPhone with a smaller model (#436) | Core 4 |
| Make processing resumable across the iOS lifecycle (#437) | Run WD14 tagging on iPhone |
| Verify standalone parity against the feature inventory (#438) | All iOS 0.2.0 issues; make processing resumable |
| Validate data safety and performance on iPhone (#439) | Verify standalone parity |
| Publish the standalone iPhone release (#440) | Validate data safety and performance |

The phone tagger model size is an open decision in ADR 0004.

## Build and release

- CI builds an unsigned IPA on hosted macOS.
- The owner signs it with KravaSign and installs it on a physical iPhone.
- A release gate checks working behavior on the device, not closed issues.
- Use [the physical-device validation plan](../docs/feasibility/ios-validation.md)
  for installation, update, data recovery, booru actions, accessibility and
  lifecycle checks.
