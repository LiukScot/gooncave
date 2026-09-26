# GoonCave on iOS: feasibility and architecture audit

Audit date: 2026-09-26. Status: feasibility research, with product direction selected
after the audit. iOS 0.1.0 is the complete server client; iOS 1.0.0 targets standalone
feature parity in the same app, with a server/local toggle. Implementation choices
still require validation. See [the active iOS roadmap](../../ios/README.md).

The separate browser-only website is no longer planned. Alternative routes below
remain comparison material, not active release commitments.

## Read this first

**Producing an IPA without owning a Mac is feasible.** Build the iOS application
on a hosted Mac, download the result, and let users sign and install it through
AltStore Classic, SideStore, or another compatible installer. GitHub Actions
provides macOS runners. This does not require publishing to the App Store.
See [Capacitor's build requirements](https://capacitorjs.com/docs/getting-started/environment-setup)
and [GitHub's runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

**An IPA does not make the current server run on an iPhone.** GoonCave is a web
frontend plus a Bun API, a background worker, a disk library, and a Python tagger.
A wrapper packages the frontend. It still needs those services somewhere else.
A standalone edition would port or replace them.

**No Mac and no computer are different constraints.** SideStore documents initial
setup from Linux, Windows, or macOS. Its later refreshes happen on the phone,
with the required local VPN and Wi-Fi. If the owner literally has only an iPhone
and no access to a computer, that initial setup is still a blocker. A cloud build
runner cannot pair itself with a phone connected to somebody else's USB port.
See [SideStore prerequisites](https://docs.sidestore.io/docs/installation/prerequisites).

Recommended decision sequence:

1. Prove that a minimal cloud-built IPA installs and updates on the owner's phone.
2. If a server is acceptable, build a server-connected client using the existing UI.
3. If users must need only an iPhone, validate a standalone native-bridge prototype
   before committing to a full port.

The second and third options serve different users. This report does not assume
that a server-connected client satisfies a requirement for a standalone app.

Companion documents:

- [Build, signing, installation, and GitHub distribution](ios-distribution.md)
- [Implementation gates and iPhone validation](ios-validation.md)

## Scope and confidence

**Verified — repository:** inspected local checkout based on commit
`ca61ec623c0f32c0aad944de665ad48ff5770991`. Existing uncommitted edits were present,
including API, gallery, Explore, settings, and duplicate handling. This report
describes that inspected snapshot, not a clean release or the latest remote branch.
Those edits were not changed by this audit.

**Verified — documentation:** primary platform and installer documentation linked
below was consulted on the audit date. SDK requirements and installation rules
can change. Published requirements are not proof that GoonCave has passed them.

**Inference:** implementation choices, reuse estimates, and recommendations below
are derived from the inspected dependencies and platform constraints.

**Unknown:** the owner's iPhone model, iOS version, signing account, installed
sideloading tool, network arrangement, library size, and server requirement.
No iOS project, IPA build, phone installation, provider login on iOS, performance
benchmark, or device UI test was executed in this audit.

This is a feasibility and delivery audit, not a penetration test or a claim of
complete runtime compatibility. “All routes” below means the materially distinct
architecture/build/distribution families, not every commercial signing service.

## 1. What exists and where it runs

| Area | Repository evidence | iOS implication |
| --- | --- | --- |
| React web UI | [Frontend dependencies](../../frontend/package.json), [Vite config](../../frontend/vite.config.ts) | Strong candidate for reuse inside WKWebView, Apple's embedded browser view. |
| Home Screen support | [HTML metadata](../../frontend/index.html), [manifest](../../frontend/public/manifest.webmanifest) | Standalone display, icon, and viewport metadata already exist. |
| Offline web runtime | No service-worker registration or implementation found in frontend source/public files | Home Screen installation is not an offline-library implementation. |
| API routing | [api.ts](../../frontend/src/api.ts): build-time override, then `/api` in development or page origin in production | A packaged frontend needs explicit server selection or replacement local services. |
| Login | [auth service](../../backend/src/services/auth.ts): HttpOnly, SameSite=Strict cookies; [server](../../backend/src/index.ts): configured credentialed CORS | A new app origin changes login and authenticated media behavior. |
| Database | [DB client](../../backend/src/db/client.ts): `bun:sqlite`, Drizzle, on-disk database and WAL | SQLite data concepts are portable; the Bun driver is not an iOS database plugin. |
| Host folders | [Library roots](../../backend/src/services/libraryRoot.ts), [scanner](../../backend/src/lib/scanner.ts), [Compose](../../docker-compose.yml) | Folder paths currently refer to the server's disk. |
| Scheduled work | [worker.ts](../../backend/src/worker.ts): timers for sync, tags, folders, providers, subscriptions | Requires a server or a lifecycle-aware iOS job implementation. |
| Media processing | [scanner](../../backend/src/lib/scanner.ts), [duplicates](../../backend/src/lib/duplicates.ts), [tagging](../../backend/src/services/tagging.ts) use Sharp and/or ffmpeg | Needs native replacements or a retained server. |
| WD14 tagging | [Python requirements](../../tagger/requirements.txt), [Compose](../../docker-compose.yml) | Existing FastAPI/ONNX service is not bundled mobile inference. |
| Provider integrations | [Engine registry](../../backend/src/lib/booruEngines/index.ts), [engine contract](../../backend/src/lib/booruEngines/types.ts) | Nine engines exist; their capabilities differ. |
| Remote media | [Remote media service](../../backend/src/services/remoteMedia.ts), [route](../../backend/src/routes/remoteMedia.ts) | Some media depends on server proxy/cache behavior, headers, and authorization. |
| Release automation | [Release workflow](../../.github/workflows/release.yml) | Publishes Docker images on Linux; no IPA pipeline exists. |
| Native project | No Capacitor/Tauri project, Xcode project, or Swift source found | Native packaging starts from a new target. |

The [browser-local ADR](../../adr/0002-browser-local-web-architecture.md) was
withdrawn after this audit. Its browser-direct spike was deleted at the owner's
request. Native provider validation belongs to the iOS roadmap and must not depend
on completing the withdrawn website proposal.

## 2. Architecture choices

| Route | IPA | Server needed | Existing UI reuse | Main benefit | Main cost / limit | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| A. Safari / Home Screen web app | No | Yes, with current implementation | Very high | Immediate access and no signing expiry | Does not meet the requested IPA deliverable; online dependency | Baseline and fallback |
| B. Small WKWebView app loading the user's server | Yes | Yes | Very high | Retains same-origin application behavior | Little offline value; native shell and navigation security still need work | Smallest useful server-connected IPA |
| C. Bundled React UI with Capacitor, remote API | Yes | Yes | High | Versioned UI plus Files/Share/native integration | Authentication, media, uploads, and API compatibility need changes | Preferred richer server-connected client |
| D. Bundled React UI with native local services | Yes | No for core features | High for UI; partial for business logic | On-device library and direct provider access | Major backend port and iOS lifecycle work | Preferred standalone candidate to prototype |
| E. Tauri mobile with Rust local services | Yes | Optional | High for UI | Native Rust core could also serve desktop targets | New language/core, mobile plugin verification, same iOS limits | Consider if a shared Rust core is independently desired |
| F. React Native / Expo | Yes | Optional | Partial logic; low DOM/CSS reuse | Native UI components and mobile tooling | Existing Radix/Tailwind/DOM interface requires substantial rewrite | Not justified solely to produce an IPA |
| G. Swift/UIKit or SwiftUI | Yes | Optional | Low | Direct platform APIs and native UX control | Largest separation from current frontend | Consider for an intentionally separate iOS product |
| H. Flutter | Yes | Optional | Low | Shared native app across mobile platforms | Dart/UI rewrite; current backend still needs replacing or hosting | Weak fit for current investment |
| I. Browser-local PWA, optionally wrapped | Optional | Potentially no | High UI; backend rewrite | Web and mobile can share local data logic | Browser CORS, cookies, quotas, and lifecycle still apply without native plugins | Conditional on ADR/provider experiments |
| J. Embed current Docker/Bun stack unchanged | Not a supported practical route | N/A | Nominally high | Would avoid a port if it existed | Desktop runtime, processes, native dependencies, and scheduling do not transfer | Reject as delivery plan |

These relative costs are engineering assessments, not measured delivery dates.
Framework references: [Capacitor](https://capacitorjs.com/docs),
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/),
[Expo cloud builds](https://docs.expo.dev/build/introduction/),
[Flutter iOS builds](https://docs.flutter.dev/deployment/ios).
Changing frameworks does not remove the macOS/Xcode build dependency.

### A. Current website on iPhone

An iPhone can reach a running server through its reachable address. `localhost`
on the iPhone means the iPhone, not the Linux host. On the same network, use the
host's address; outside that network, arrange authenticated HTTPS access or a
private VPN. The phone and the API must be able to reach each other.

The current manifest can launch the site without normal Safari toolbars. This
does not move downloaded favorites or the SQLite database onto the phone.
Server jobs may continue while the phone sleeps because they run on the server.

### B. Remote website inside a native shell

A small WKWebView shell can ask for the user's server URL and load its existing
website. UI, API calls, and media can retain their server origin. Persistent
website storage must be configured and tested for login survival.

Use a local setup/error screen so an unreachable server never produces an
unexplained blank page. Keep a way to change the server when loading fails.
Send external provider links to an external browser. Do not expose a privileged
native bridge to arbitrary sites or redirects.

This is an architecture proposal, not a production use of Capacitor live reload.
Capacitor explicitly labels `server.url` as intended for live-reload use and not
production. A deliberate remote WKWebView shell needs its own trust and navigation
design. See [Capacitor configuration](https://capacitorjs.com/docs/config).

### C. Bundled frontend with a remote server

Package `frontend/dist` in the app. Let users configure their own server at
runtime. A public IPA should not be compiled with the maintainer's private URL.
The UI can start offline, but remote features still need the server.

The important changes are more than adding Capacitor:

- Replace the module-level, build-time API base assumption with a supported
  connection configuration and a server compatibility check.
- Choose and test an authentication transport for API calls, uploads, images,
  video seeking, and downloads together.
- Clear account-specific query caches and local files on account/server changes.
- Handle server upgrades independently from IPA upgrades.
- Add native sharing/export only where it solves a concrete iPhone need.

### D. Standalone frontend with native services

Keep the React screens. Move network, credentials, database, and file operations
behind explicit mobile implementations. Use native HTTP for provider requests,
Keychain for secrets, an iOS-compatible SQLite layer for metadata, and app-owned
files for selected downloads. These are proposed components, not dependencies
selected or installed by this audit.

Reuse provider parsing, tag-query semantics, capabilities, and domain types where
they do not depend on Node/Bun. Replace runtime-specific dependencies explicitly.
For example, current authentication helpers use `Buffer`, and the FurAffinity
transport imports `undici`; copying these files into Vite is not a port.

Start with remote browsing, favorites, subscriptions, read marks, blacklist, and
explicit downloads. Add imported-file processing and large-library features only
after storage and memory tests. A standalone version can eventually support much
of the product, but should not claim immediate desktop-server parity.

### E–I. Alternative frameworks and browser-local work

Tauri can reuse the web UI while placing local logic in Rust. It does not make
the existing Fastify server a mobile sidecar automatically. Its iOS target still
requires macOS and Xcode. React Native and Flutter require rewriting the web
view layer; cloud builds solve build-machine access, not that rewrite.

A native Swift implementation can expose a service bridge to React without
rewriting the entire UI. This is worth considering before choosing an all-native
interface. SwiftUI is an optional UI choice, not a requirement for native HTTP,
SQLite, document access, or background transfers.

A browser-local implementation would use IndexedDB/OPFS rather than server files.
It needs backup/export and quota handling. WebKit may evict website storage under
pressure, and a WKWebView is not automatically given the same storage treatment
as a Home Screen web app. See [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/).

## 3. Feature feasibility

“Retained” means the server implementation can remain; phone behavior still needs
validation. “Port” means new implementation, not a feature already available.

| Feature | Server-connected IPA | Standalone IPA |
| --- | --- | --- |
| Gallery, tag filters, autocomplete | Retained over API | Port SQL/query execution and taxonomy storage |
| Explore and provider search | Retained | Port provider transport, pagination, and response validation |
| Provider accounts | Credentials remain server-side as today | Store locally; design login and renewal per provider |
| Favorite/unfavorite and voting | Retained where engine supports them | Port actions; preserve provider-specific capability limits |
| Download favorites | Server downloads to server library | Native download queue to app storage; explicit space policy |
| Artist subscriptions and read marks | Retained | Port feed index, deduplication, persistence, and refresh logic |
| Pools and parent/child navigation | Retained where available | Reuse semantics; port fetch/cache layer |
| Blacklist and settings | Retained | Local settings with migration/export |
| Folder scanning | Server folders only | User-selected Files directories or imported copies; not arbitrary device paths |
| Docker mounts / host permissions | Retained on host | No equivalent mount model in a normal sideloaded app |
| Phone Photos / Files import | Upload to server; test picker formats | Native picker/import workflow with consent and file coordination |
| Source matching | Server Fluffle/SauceNAO calls | Port hashing/thumbnail creation and authenticated calls; observe provider limits |
| Duplicate detection | Server Sharp/ffmpeg pipeline | New native image/video processing; benchmark before claiming parity |
| WD14 | Existing server service | Optional native ONNX/Core ML experiment or measured web inference |
| Background periodic sync | Server continues independently | Opportunistic and resumable; no exact midnight/continuous worker guarantee |
| Offline library | Requires new client cache | Feasible for metadata and downloaded originals; remote posts still need network |
| Large video downloads | Server unaffected by app suspension | Use native file transfers; persist progress and recovery state |
| Export / share / Save to Photos | Native integration or web fallback | Native integration and appropriate permissions |
| Notifications | New feature; requires explicit transport design | Local notifications possible; remote push has signing/service requirements |
| Multi-user accounts | Existing server behavior | Define local profiles and isolation; do not silently flatten users |
| Cross-device backup/sync | Server remains authoritative | New export/sync protocol; do not copy an active SQLite DB as a sync solution |
| Server admin controls | Retained for authorized users | Omit or redefine; there is no local multi-user server to administer |

### WD14 is feasible in principle, unproven for this model

ONNX Runtime has an Apple Core ML execution provider. That establishes a native
inference route, not guaranteed compatibility/performance for the current WD14
graph. Check supported operations, conversion accuracy, model/license size,
memory peak, thermal behavior, cancellation, and battery consumption on the
actual phone. Keep inference optional until it passes. See
[ONNX Runtime Core ML](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html).

The Python service and Hugging Face download/cache logic would not be reused
unchanged. Web inference is another experiment; detect execution-provider
availability rather than assuming every iPhone supports a chosen GPU path.

## 4. Networking and authentication: the highest-risk integration

### GoonCave login is separate from provider login

GoonCave's session authorizes access to its server library. Provider credentials
authorize actions on e621, Danbooru, FurAffinity, and other sites. A successful
GoonCave login does not prove that a provider session works, and vice versa.

### Why changing the API URL is insufficient

The current API client includes cookies. The server sets `SameSite=Strict`.
A bundled Capacitor app normally loads from an app-local origin such as
`capacitor://localhost`, while a server might be `https://library.example`.
For browser networking those are different sites. Allowing CORS does not override
cookie restrictions. A login response can look successful while later requests
remain unauthorized.

Possible designs to validate:

| Design | Advantage | Work and risk |
| --- | --- | --- |
| Load UI from server in WKWebView | Preserves same-origin design | Online shell; persistent cookies, redirects, and navigation need tests |
| Native session transport with controlled cookie storage | Can avoid browser cross-site restrictions for API calls | Must integrate media, multipart uploads, logout, and cookie synchronization |
| Dedicated mobile access/refresh tokens | Explicit mobile authentication contract | Server changes, expiry/revocation, Keychain, and authenticated-media design |
| Cross-site browser cookies | Fewer conceptual API changes | WebKit cookie policy; Secure/SameSite changes; explicit CSRF protection required |

Do not globally relax cookie settings just to make a prototype login work.
CORS controls browser access to responses; it is not authentication and is not
a complete substitute for preventing cross-site state-changing requests.

### API success does not prove media success

`<img>` and `<video>` requests do not automatically use an application's custom
Authorization header. Patching `fetch` does not automatically patch all resource
loads. The current file-content and remote-media paths must be tested separately.

Prefer a consistent native/session strategy or narrowly scoped media URLs with
short validity. Avoid persistent bearer tokens in URLs. Large video files should
not be converted to base64 strings across a JavaScript bridge. Seek support needs
correct byte-range responses. Native downloads and WebView playback can have
different cookie stores and authorization behavior.

Capacitor supports native HTTP and optional fetch/XHR patching, but its docs also
describe bridge memory limitations. Treat it as an API to integrate, not a
universal compatibility switch. See [Capacitor HTTP](https://capacitorjs.com/docs/apis/http).

### Provider-by-provider port exposure

The following assessment comes from the current engine implementations. It is
not a live iPhone provider compatibility result.

| Engine | Relevant existing behavior | Standalone validation needed |
| --- | --- | --- |
| e621 | API calls with configured identity and optional Basic auth | Native headers, authenticated writes, pacing, media, pools, relations |
| Danbooru | API calls and optional Basic auth | Same, plus account-tier/search restrictions and provider-specific results |
| Gelbooru | API and cookie-backed HTML/action paths | Cookie acquisition/expiry, redirects, HTML parsing, confirmed favorite removal |
| FurAffinity | Cookie-authenticated HTML and custom request layer | Entire login/cookie lifecycle, theme/parser behavior, challenges, CDN access |
| Moebooru | Separate API adapter | Actual target site's authentication and capability subset |
| Philomena | Separate API adapter | Target-specific tokens, searches, writes, and media |
| Sankaku | Separate API adapter | Current token/access requirements and endpoint restrictions |
| Shimmie | Separate API adapter | Per-installation behavior, supported actions, authentication |
| Szurubooru | Separate API adapter | Self-hosted endpoint, credentials, LAN/TLS, capabilities |

Native HTTP is not subject to the browser's CORS enforcement. It still encounters
authentication, provider rate limits, redirects, site terms, CDN restrictions,
and bot challenges. Ordinary JavaScript inside WKWebView still has web security
rules unless requests are explicitly routed through a native implementation.

Safari cookies are not automatically available to the app. A mobile cookie-login
flow may need an app-owned login view or provider-supported authorization flow.
Do not promise that users can copy HttpOnly cookies from iPhone Safari settings.
Do not treat a historical server probe as current iOS evidence.

### Transport and LAN access

Native networking is affected by App Transport Security (ATS). Prefer HTTPS with
a valid certificate. If local HTTP must be supported, define a narrow, documented
policy rather than globally disabling transport checks. Local network access may
also need a usage description and user permission; Bonjour discovery adds its
own configuration. TLS failure, permission denial, DNS failure, and a stopped
server need distinct recovery messages. See
[ATS](https://developer.apple.com/documentation/Security/preventing-insecure-network-connections)
and [local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

## 5. Storage, files, lifecycle, and signing limits

### Files and persisted data

A normal sideloaded app is sandboxed: it has its own files, not unrestricted
access to other applications or the server's mounts. iOS document pickers can
grant access to user-selected directories, including through file providers.
That is real folder support, but requires security-scoped access, bookmarks,
coordination, and handling files that are not downloaded locally. It is not a
24/7 filesystem watcher. See [Apple directory access](https://developer.apple.com/documentation/uikit/providing-access-to-directories).

Use durable app storage for downloaded originals and databases, and disposable
cache storage for regenerable thumbnails. Store app-relative paths instead of
absolute container paths, which can change. Show space usage and allow bounded
cache cleanup without deleting user-selected originals.

For standalone migration, reuse the schema's meaning only after reviewing each
table. Server user IDs, folder paths, processing jobs, secrets, and migration
execution are not automatically valid on a phone. Export metadata separately from
media and separately from secrets. Back up SQLite through a consistent snapshot
mechanism; a live WAL database cannot safely be treated as one ordinary file.

Re-signing, bundle-ID changes, a different signing account, uninstall/reinstall,
and installer deactivation can affect storage and Keychain access differently.
Test updates with the intended tool and keep an export path. Do not tell users
to uninstall a standalone app as the first troubleshooting step.

### Background execution

iOS supports background work, but not the current always-running timer worker.

- Use background URLSession for eligible uploads/downloads, with durable queues.
- Use background processing/refresh tasks as system-scheduled opportunities.
- On iOS 26+, continued-processing tasks can extend user-started work into the
  background. They report progress, can be cancelled, and may be terminated.
- Keep foreground recovery available when a task cannot run or is interrupted.
- Do not promise exact nightly refresh or unattended completion after force quit.

These mechanisms require native integration; a JavaScript interval is not their
equivalent. The server edition retains its independent worker. Sources:
[background strategies](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app),
[background transfers](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background),
[continued processing](https://developer.apple.com/documentation/BackgroundTasks/performing-long-running-tasks-on-ios-and-ipados).

### Entitlements and extensions

An entitlement is a signed permission for an Apple platform capability. An IPA
cannot gain arbitrary permissions just by declaring them. A sideloading account
may not support capabilities such as remote push or app groups in the form a
developer originally built. Keep the first app free of unnecessary extensions,
iCloud dependencies, associated-domain requirements, and push dependencies.

A share extension, widget, or background GPU capability is a separate compatibility
item. Verify it after re-signing, not only in the original Xcode project.
Use export/import before depending on team-bound cloud services.

### Media and touch UI

The frontend already has safe-area CSS and inline video attributes. These are
useful foundations, not proof of iPhone usability. Test every advertised format
on the minimum supported OS and representative hardware. Container extension
alone does not establish codec support; a successful thumbnail says nothing about
video decode, audio, seeking, or export to Photos.

Treat autoplay, fullscreen, orientation, pinch/drag, the software keyboard, and
memory-heavy scrolling as device tests. Native wrappers retain WebKit behavior
unless a particular feature is replaced with a native implementation.

## 6. Existing screen routes and their mobile meaning

Routes are verified in [router.tsx](../../frontend/src/router.tsx). This inventory
identifies adaptation scope, not a claim that each screen was visually tested.

| Route | Server-connected app | Standalone adaptation |
| --- | --- | --- |
| `/`, `/login`, `/app` | Preserve redirects/auth; add server setup before login | Define local onboarding; server login only if companion mode exists |
| `/app/gallery` | Browse server library | Browse on-device index/downloads/imports |
| `/app/explore` | Retain API-driven discovery | Direct native provider queries and local feed persistence |
| `/app/pool` | Preserve selected pool and navigation | Port ordered pool retrieval and saved reading state |
| `/app/games` | Verify current behavior separately | No mobile parity claim from this audit |
| `/app/settings` | Keep grouped navigation | Keep only implemented capabilities |
| `/app/settings/folders` | Explain that paths belong to the server | Replace with Files import/directory access and app storage |
| `/app/settings/file-sources` | Retain server source processing | Local/provider processing configuration |
| `/app/settings/duplicates` | Server scan controls | Expose only after local processing is validated |
| `/app/settings/accounts` | Server-held provider accounts | Local provider accounts and secure credential lifecycle |
| `/app/settings/subscriptions` | Server sync and feed | Foreground/opportunistic sync, visible freshness |
| `/app/settings/shortcuts` | Optional hardware-keyboard controls | All necessary actions also need touch controls |
| `/app/settings/blacklist` | Preserve filtering semantics | Local persistence and export |
| `/app/settings/extra` | Audit each server-specific setting | Hide or explain unsupported operations |

Deep links, back navigation, reload, and restore must preserve query parameters,
selected items, and scroll position. A wrapped app must not reset to the gallery
merely because iOS suspended and resumed it.

## 7. What is possible and what is not

| Statement | Verdict |
| --- | --- |
| Develop from Linux and build on hosted macOS | Feasible; native debugging is less convenient |
| Publish a re-signable IPA as a GitHub Release asset | Feasible after building an iOS target and validating installation |
| Avoid App Store submission for Classic/SideStore distribution | Yes; signing/provisioning still apply |
| Require no paid developer membership for an unsigned build artifact | Feasible for a target without restricted signing requirements; validate the actual project |
| Give all users one freely installable, permanently signed IPA | Not with ordinary stock-iOS personal/ad hoc signing |
| Install a raw GitHub IPA by tapping it in Safari | Not an ordinary stock-iOS installation route |
| Use AltStore PAL as a raw IPA installer | No; PAL uses notarized alternative distribution |
| Make CORS disappear by changing `.zip` to `.ipa` | No; only an actual native transport changes that boundary |
| Reuse all current Bun/Sharp/ffmpeg/Python code unchanged on iPhone | No supported drop-in route; port or retain services |
| Build a standalone iPhone library and provider client | Feasible in principle; substantial new implementation |
| Scan any folder or Photos library without user access grants | No for the normal sandboxed target |
| Guarantee server-style continuous processing | No; design resumable jobs or retain a server |
| Support only jailbroken/TrollStore devices | Technically a separate niche target; unsuitable as the baseline |
| Have ordinary React/WebView rendering without special JIT setup | Yes; no need to make the app depend on sideloading JIT tooling |

Bun's documented installation targets are macOS, Linux, and Windows; they do not
provide a supported iOS runtime target. See [Bun installation](https://bun.sh/docs/installation).

## 8. Selected direction and implementation decisions

The owner selected a complete server-connected iOS 0.1.0, followed by incremental
standalone capability through iOS 1.0.0. Keep both modes in one app with a toggle.
PC and Android have separate version tracks. See [the versioning policy](../versioning.md).

Capacitor with native networking/storage remains a candidate because it preserves
the React UI. Validate the shell, login, authenticated media, installation, and
update path before choosing the implementation. The product decision does not
prove a framework or plugin compatible.

Before implementation, decide:

- What is the minimum iOS version and the owner's actual phone model/version?
- Is Linux/Windows access available for initial sideloading setup?
- Which shell and authentication strategy passes the server-client gate?
- Which iOS equivalents satisfy folder, processing, and background-work parity?

Do not estimate a full port from packaging time. The first deliverable should
measure install/update success, authenticated media, one provider's read/write
flow, storage recovery, and suspension behavior. The exact pass/fail gates are
in [the validation plan](ios-validation.md).
