# iPhone release roadmap

Decision: 2026-09-26. Milestones are planned releases, not shipped versions.

One iPhone app starts as a complete server client and gains standalone features.
The server/local toggle arrives with local mode and remains in 1.0.0. PC and
Android versions advance independently. See [the iOS overview](README.md) and
[versioning policy](../docs/versioning.md).

## Release sequence

| Milestone | Outcome | Issues |
| --- | --- | --- |
| [iOS 0.1.0 — Complete server client](https://github.com/LiukScot/gooncave/milestone/5) | Deliver one sideloadable iPhone app with the existing server-backed feature set, runtime server setup, authenticated media, full settings, and verified install/update behavior. Build without owning a Mac. Keep framework selection evidence-based. Standalone operation is not required for this release. | 8 |
| [iOS 0.2.0 — Local mode and durable data](https://github.com/LiukScot/gooncave/milestone/6) | Add the server/local toggle inside the same app, isolated local profiles, durable metadata and media storage, and export/restore. Retain complete server mode. Expose local capabilities honestly; never silently fall back to a server. | 4 |
| [iOS 0.3.0 — Standalone providers and feeds](https://github.com/LiukScot/gooncave/milestone/7) | Run the current provider engines and their supported actions directly on iPhone. Recreate Explore, favorites, subscriptions, pools, relations, and read state using local persistence. Validate all nine existing engines; browser-only research is not a dependency. | 4 |
| [iOS 0.4.0 — Standalone library and search](https://github.com/LiukScot/gooncave/milestone/8) | Recreate imported-file libraries, folder equivalents, tag editing and taxonomy, booru search, gallery behavior, and settings on the device. Preserve server mode and keep data ownership explicit. | 4 |
| [iOS 0.5.0 — Standalone media processing](https://github.com/LiukScot/gooncave/milestone/9) | Recreate source matching, duplicate handling, WD14 tagging, and resumable local jobs. Use iOS lifecycle equivalents and measure memory, storage, and device performance. Unsupported parity requires an explicit owner decision. | 4 |
| [iOS 1.0.0 — Standalone feature parity](https://github.com/LiukScot/gooncave/milestone/10) | Validate the complete existing-feature inventory in standalone mode while retaining the server/local toggle and complete server mode. Require physical-device evidence, recoverable upgrades, and a tested public IPA distribution path. Do not silently waive missing features. | 3 |

## Implementation issues

Dependencies identify prerequisite deliverables. Work within a milestone can
proceed independently where those prerequisites permit it. A release gate must
verify completed behavior, not merely closed issue status.

### iOS 0.1.0 — Complete server client

| Issue | Prerequisites |
| --- | --- |
| [#414 — Establish the iPhone app target and server-client contract](https://github.com/LiukScot/gooncave/issues/414) | None |
| [#415 — Implement server setup and persistent iPhone authentication](https://github.com/LiukScot/gooncave/issues/415) | [#414](https://github.com/LiukScot/gooncave/issues/414) |
| [#416 — Expose the complete server-backed browsing workflow on iPhone](https://github.com/LiukScot/gooncave/issues/416) | [#415](https://github.com/LiukScot/gooncave/issues/415) |
| [#417 — Expose server settings and library operations on iPhone](https://github.com/LiukScot/gooncave/issues/417) | [#415](https://github.com/LiukScot/gooncave/issues/415) |
| [#418 — Support authenticated media and file transfers on iPhone](https://github.com/LiukScot/gooncave/issues/418) | [#415](https://github.com/LiukScot/gooncave/issues/415) |
| [#419 — Adapt navigation and lifecycle behavior for the iPhone](https://github.com/LiukScot/gooncave/issues/419) | [#416](https://github.com/LiukScot/gooncave/issues/416), [#417](https://github.com/LiukScot/gooncave/issues/417), [#418](https://github.com/LiukScot/gooncave/issues/418) |
| [#420 — Build and distribute reproducible iPhone IPA artifacts](https://github.com/LiukScot/gooncave/issues/420) | [#414](https://github.com/LiukScot/gooncave/issues/414) |
| [#421 — Validate complete server-client parity before the first iOS release](https://github.com/LiukScot/gooncave/issues/421) | [#419](https://github.com/LiukScot/gooncave/issues/419), [#420](https://github.com/LiukScot/gooncave/issues/420) |

### iOS 0.2.0 — Local mode and durable data

| Issue | Prerequisites |
| --- | --- |
| [#422 — Add the server and local mode toggle to the existing iPhone app](https://github.com/LiukScot/gooncave/issues/422) | [#421](https://github.com/LiukScot/gooncave/issues/421) |
| [#423 — Persist local profiles, metadata, and provider secrets on iPhone](https://github.com/LiukScot/gooncave/issues/423) | [#422](https://github.com/LiukScot/gooncave/issues/422) |
| [#424 — Add durable on-device media storage and download queues](https://github.com/LiukScot/gooncave/issues/424) | [#423](https://github.com/LiukScot/gooncave/issues/423) |
| [#425 — Add versioned local export, restore, and explicit server data transfer](https://github.com/LiukScot/gooncave/issues/425) | [#423](https://github.com/LiukScot/gooncave/issues/423), [#424](https://github.com/LiukScot/gooncave/issues/424) |

### iOS 0.3.0 — Standalone providers and feeds

| Issue | Prerequisites |
| --- | --- |
| [#426 — Run e621 and Danbooru directly in local iPhone mode](https://github.com/LiukScot/gooncave/issues/426) | [#423](https://github.com/LiukScot/gooncave/issues/423), [#424](https://github.com/LiukScot/gooncave/issues/424) |
| [#427 — Port the remaining API-based engines to native iPhone networking](https://github.com/LiukScot/gooncave/issues/427) | [#426](https://github.com/LiukScot/gooncave/issues/426) |
| [#428 — Support Gelbooru and FurAffinity sessions in local iPhone mode](https://github.com/LiukScot/gooncave/issues/428) | [#426](https://github.com/LiukScot/gooncave/issues/426) |
| [#429 — Recreate Explore, favorites, and subscriptions using local providers](https://github.com/LiukScot/gooncave/issues/429) | [#427](https://github.com/LiukScot/gooncave/issues/427), [#428](https://github.com/LiukScot/gooncave/issues/428) |

### iOS 0.4.0 — Standalone library and search

| Issue | Prerequisites |
| --- | --- |
| [#430 — Import and manage iPhone files and selected directories](https://github.com/LiukScot/gooncave/issues/430) | [#425](https://github.com/LiukScot/gooncave/issues/425), [#429](https://github.com/LiukScot/gooncave/issues/429) |
| [#431 — Recreate local tag taxonomy, editing, and booru search](https://github.com/LiukScot/gooncave/issues/431) | [#430](https://github.com/LiukScot/gooncave/issues/430) |
| [#432 — Recreate gallery and file detail behavior against local storage](https://github.com/LiukScot/gooncave/issues/432) | [#431](https://github.com/LiukScot/gooncave/issues/431) |
| [#433 — Implement local settings and profile workflows with server parity](https://github.com/LiukScot/gooncave/issues/433) | [#432](https://github.com/LiukScot/gooncave/issues/432) |

### iOS 0.5.0 — Standalone media processing

| Issue | Prerequisites |
| --- | --- |
| [#434 — Recreate source matching and tag refresh on iPhone](https://github.com/LiukScot/gooncave/issues/434) | [#433](https://github.com/LiukScot/gooncave/issues/433) |
| [#435 — Recreate duplicate detection and resolution on iPhone](https://github.com/LiukScot/gooncave/issues/435) | [#433](https://github.com/LiukScot/gooncave/issues/433) |
| [#436 — Run WD14 tagging locally on iPhone](https://github.com/LiukScot/gooncave/issues/436) | [#433](https://github.com/LiukScot/gooncave/issues/433) |
| [#437 — Make local sync and processing resumable across iOS lifecycle changes](https://github.com/LiukScot/gooncave/issues/437) | [#434](https://github.com/LiukScot/gooncave/issues/434), [#435](https://github.com/LiukScot/gooncave/issues/435), [#436](https://github.com/LiukScot/gooncave/issues/436) |

### iOS 1.0.0 — Standalone feature parity

| Issue | Prerequisites |
| --- | --- |
| [#438 — Verify standalone parity against the complete existing feature inventory](https://github.com/LiukScot/gooncave/issues/438) | [#437](https://github.com/LiukScot/gooncave/issues/437) |
| [#439 — Validate data safety and performance in both iPhone modes](https://github.com/LiukScot/gooncave/issues/439) | [#438](https://github.com/LiukScot/gooncave/issues/438) |
| [#440 — Publish the standalone-capable iPhone release with server mode retained](https://github.com/LiukScot/gooncave/issues/440) | [#439](https://github.com/LiukScot/gooncave/issues/439), [#420](https://github.com/LiukScot/gooncave/issues/420) |

## Feature ownership

| Existing behavior | Standalone delivery |
| --- | --- |
| Server/local mode, profiles, account isolation | [#422](https://github.com/LiukScot/gooncave/issues/422), [#423](https://github.com/LiukScot/gooncave/issues/423) |
| Durable media, downloads, storage pressure, offline playback | [#424](https://github.com/LiukScot/gooncave/issues/424) |
| Backup, restore, explicit server-to-local transfer | [#425](https://github.com/LiukScot/gooncave/issues/425) |
| e621 and Danbooru supported actions | [#426](https://github.com/LiukScot/gooncave/issues/426) |
| Moebooru, Philomena, Sankaku, Shimmie, Szurubooru | [#427](https://github.com/LiukScot/gooncave/issues/427) |
| Gelbooru and FurAffinity cookie sessions and actions | [#428](https://github.com/LiukScot/gooncave/issues/428) |
| Explore, favorites sync, subscriptions, read marks, pools, relations | [#429](https://github.com/LiukScot/gooncave/issues/429) |
| Files/Photos import, selected folders, scans, file organization | [#430](https://github.com/LiukScot/gooncave/issues/430) |
| Tag categories, aliases, implications, editing, taxonomy, search | [#431](https://github.com/LiukScot/gooncave/issues/431) |
| Gallery/detail navigation, selection, sources, duplicate display | [#432](https://github.com/LiukScot/gooncave/issues/432) |
| Blacklist, shortcuts, toggles, grid preferences, provider ordering | [#433](https://github.com/LiukScot/gooncave/issues/433) |
| Source matching, Fluffle/SauceNAO, tag refresh | [#434](https://github.com/LiukScot/gooncave/issues/434) |
| Image/video duplicate matching and resolution policies | [#435](https://github.com/LiukScot/gooncave/issues/435) |
| WD14 automatic tagging and backfill | [#436](https://github.com/LiukScot/gooncave/issues/436) |
| Background equivalents, cancellation, resumption, job recovery | [#437](https://github.com/LiukScot/gooncave/issues/437) |
| Full inventory reconciliation and server-mode regression checks | [#438](https://github.com/LiukScot/gooncave/issues/438), [#439](https://github.com/LiukScot/gooncave/issues/439) |

The settings issue supplies local configuration before processing services land.
The source, duplicate, and WD14 issues own their action wiring and validation.
The final parity gate checks that every settings operation is functional.

All nine current engines are in scope with their existing capabilities. A provider
operation absent from the server baseline is not automatically a port requirement.
The Games placeholder is not an implemented game. Later PC feature additions
require an explicit parity-scope decision.

## PC release organization

The original nine remaining open owner issues are assigned to three minor releases.
Issue #396, the browser-direct provider spike, was deleted at the owner's request.
The separate browser-only website is not part of this roadmap.

| Milestone | Scope | Issues |
| --- | --- | --- |
| [PC 1.0.0 — Packaged server edition](https://github.com/LiukScot/gooncave/milestone/1) | Ship a server-based PC distribution that users can download, install, update, and recover without undocumented setup. Decide package format and supported operating systems in the packaging issue. A separate browser-only website is out of scope. | [#413](https://github.com/LiukScot/gooncave/issues/413) |
| [PC 1.1.0 — Reliability and subscriptions](https://github.com/LiukScot/gooncave/milestone/2) | Stabilize gallery pagination, clarify subscriptions, verify remaining provider adapters, and make folder paths understandable. | [#38](https://github.com/LiukScot/gooncave/issues/38), [#288](https://github.com/LiukScot/gooncave/issues/288), [#390](https://github.com/LiukScot/gooncave/issues/390), [#393](https://github.com/LiukScot/gooncave/issues/393), [#412](https://github.com/LiukScot/gooncave/issues/412) |
| [PC 1.2.0 — Browsing and product improvements](https://github.com/LiukScot/gooncave/milestone/3) | Add viewing history and Explore comments. Review e1547 and track accepted improvements without silently expanding this release. | [#328](https://github.com/LiukScot/gooncave/issues/328), [#331](https://github.com/LiukScot/gooncave/issues/331), [#386](https://github.com/LiukScot/gooncave/issues/386) |
| [PC 1.3.0 — Provider integration research](https://github.com/LiukScot/gooncave/milestone/4) | Evaluate Bluesky integration and record the supported scope or a reasoned rejection. Discussion does not promise provider implementation. The browser-only website is not planned. | [#334](https://github.com/LiukScot/gooncave/issues/334) |

PC packaging format and supported operating systems remain open for discussion in
[#413](https://github.com/LiukScot/gooncave/issues/413). Research issues may conclude
with a rejection or follow-up scope; their milestones do not promise unapproved
integrations. Android has a platform label and independent version namespace, but
no implementation milestones were created.

## Release evidence

Use [the physical-device validation plan](../docs/feasibility/ios-validation.md)
for installation, update, login, protected media, mode isolation, local recovery,
provider actions, accessibility, and lifecycle checks. No iPhone build or test
has passed merely because this roadmap exists.
