# ADR 0002: Browser-local Web Architecture

## Status

Proposed. No migration or hosting choice has been approved.

## Date

2026-09-24

## Context

Issue [#394](https://github.com/LiukScot/gooncave/issues/394) proposes turning
GoonCave into a website that can be used with or without an account. User data
must not be stored on the GoonCave server.

The current application is a self-hosted service:

- Fastify owns authentication, provider calls, API routes, and static serving.
- SQLite stores users, provider credentials, favorites, tags, and application
  state on the host.
- The API and worker read and write media, thumbnails, and caches on the host
  filesystem.
- A separate Python service runs the WD14 ONNX model.
- Docker volumes expose local media folders to the API and worker.

Publishing this stack through Cloudflare Tunnel would make it reachable from a
public hostname, but the application and data would still live on the origin
server. Moving the existing backend to a hosted platform would instead make the
operator responsible for private user data, provider credentials, media
storage, traffic, and abuse.

The proposal explores a different product: a local-first web application whose
durable state belongs to the browser profile. A small hosted service could
support public, non-sensitive shared data, but it would not become the owner or
transit point for private user data by default.

## Proposed architecture

Evaluate a progressive web application with browser-local durable storage as one
possible future direction. The core product would not require a GoonCave
account.

This ADR describes the constraints that would apply if the proposal is adopted.
It does not authorize implementation or replacement of the current application.
Run the provider spike first, then make a separate accept, reject, or revise
decision using the feasibility evidence.

### Storage ownership

Use each browser storage mechanism for one explicit responsibility:

| Data                                                                       | Primary storage                   | Notes                                         |
| -------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------- |
| Settings, provider definitions, favorites, tags, read state, and job state | IndexedDB                         | Structured durable application data           |
| Optional imported files, optional offline originals, and the WD14 model    | Origin Private File System (OPFS) | Large binary objects owned by the site origin |
| Thumbnails and reproducible HTTP responses                                 | Cache API                         | Disposable data that may be rebuilt           |
| Small boot preferences only                                                | `localStorage`                    | Never the application database                |

Request persistent storage through `navigator.storage.persist()` and expose
current usage, quota estimates, and persistence status in Settings. Handle quota
errors explicitly. Browser storage remains tied to the exact site origin and
browser profile. Changing the production domain therefore requires a migration
plan before the old origin is retired.

Cache entries are never the only copy of user-created state. Clearing site data,
resetting the browser profile, or losing the device can still remove local data,
so export and restore are part of the core contract.

### Accounts and backups

The default mode has no remote account. The user can optionally connect a
storage provider, beginning with Google Drive, for backup and restore.

Backups use the user's provider account and storage. GoonCave does not copy the
backup to its own server. The Google implementation should use Drive's
application-data folder rather than adding visible files to the user's normal
Drive hierarchy.

The first backup implementation is snapshot backup, not multi-device live sync:

- create a versioned snapshot when the app is open and the last successful
  backup is more than 24 hours old
- create a snapshot after an explicit user request
- offer restore as an explicit operation with a preview and confirmation
- keep enough previous snapshots to recover from a corrupt latest snapshot
- record the schema version, application version, creation time, and checksum
  in each snapshot

A closed website cannot guarantee a daily background job. Do not describe the
feature as a fixed-time scheduled backup unless a later platform can demonstrate
that guarantee.

Provider API keys, session cookies, and equivalent credentials are excluded
from backups by default. A future encrypted-credential backup must encrypt and
decrypt entirely on the client with a secret that the GoonCave service never
receives.

Support for other backup providers may be added behind the same snapshot
contract. Do not build a provider abstraction until the Google implementation
has established the concrete shared requirements.

### Provider requests

Authenticated requests go directly from the user's browser to the content
provider whenever the provider permits it. Each user supplies their own API key,
token, or other authentication material that the provider accepts in a
script-settable header or request field.

Browser JavaScript cannot set the `Cookie` request header. A cross-origin
request can include only cookies already managed by the browser for the provider
domain, and only when the cookie's `SameSite` policy, the browser's third-party
cookie policy, and the provider's credentialed CORS policy all permit it.
Manually entered session cookies therefore do not work in the browser-only
architecture. Treat a provider that requires them as incompatible unless it
offers another browser-compatible authentication method.

With direct requests, the provider sees the user's network address and
credentials. Limits based on IP address, account, or API key therefore remain
per user. Requests share the GoonCave web origin, which the provider can allow or
reject through CORS, but they do not share a GoonCave server IP.

The browser owns provider credentials. Keep them out of URLs, logs, analytics,
crash reports, server requests, and backup snapshots. Use a strict Content
Security Policy and avoid third-party scripts on pages that can access those
credentials. Treat an XSS vulnerability as credential compromise.

The application must not expose a general-purpose public proxy. A central proxy
would:

- aggregate traffic and rate limits onto GoonCave infrastructure
- make provider credentials transit GoonCave systems
- create an abuse relay for arbitrary callers
- transfer provider bandwidth and availability risk to the operator

A hosted relay may be considered only for a fixed allowlist of public,
unauthenticated, read-only endpoints. Such a relay requires input validation,
per-client rate limits, bounded responses, caching where permitted, provider
terms review, and operational limits. It must not accept arbitrary destinations
or authentication material.

If a provider cannot support browser-direct authenticated requests, choose one
of these outcomes in order:

1. support a reduced public-only capability
2. mark the provider unsupported in the web edition
3. provide an optional local companion in a separate future decision

Do not silently route the provider through a centralized credentialed proxy.

### Provider feasibility gate

Before the web migration begins, build a disposable browser spike for e621 and
Danbooru. Test the real production origin or a documented development origin.
Do not infer browser compatibility from the current server-side engines.

Record this matrix for every provider:

| Capability           | Required evidence                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Public API reads     | Browser receives and can read the response under the provider's CORS policy                                                          |
| Authenticated reads  | The provider accepts authentication material JavaScript may send; cookie-only flows are tested under current browser cookie policies |
| Authenticated writes | Favorite and unfavorite operations work without exposing credentials to GoonCave                                                     |
| Media display        | Thumbnails and originals load directly from the provider or its CDN                                                                  |
| Pixel access         | Images can be decoded into a canvas or tensor for client-side WD14 without a CORS-tainted response                                   |
| Request identity     | Provider rules do not require `Cookie`, a custom `User-Agent`, or another browser-forbidden header                                   |
| Rate limiting        | The documented or measured limit is scoped acceptably by user IP, account, or API key                                                |
| Error handling       | Authentication expiry, quota responses, deleted posts, and provider outages are distinguishable                                      |

The gate passes only if at least one main provider completes the core flow:
connect credentials, list favorites, view media, add or remove a favorite, save
local state, reload, and restore that state.

Failure of the gate stops the full rewrite and triggers a separate decision
between a reduced provider set and an optional local companion.

### Files and media

Remote provider posts replace host filesystem folders as the primary content
model. The web edition does not automatically download every original into the
browser or Google Drive.

The initial web edition omits:

- host folder scanning
- Docker-mounted libraries
- automatic favorite downloads
- server-side thumbnails and remote-media cache
- filesystem moves and duplicate-file actions

The application may later add explicit device import and per-item offline
copies. Those features store selected objects in OPFS and must show their space
cost. Uploading original media into backup storage is a separate opt-in feature,
not part of the metadata backup.

### WD14

Retain WD14 as an optional client-side experiment rather than a server service.
Use ONNX Runtime Web with WebGPU where supported and WebAssembly as a measured
fallback.

The first implementation must:

- download the model only after explicit user action
- show model size and local storage use before download
- store the model locally for reuse
- keep inference inputs and results on the device
- detect unsupported execution providers and insufficient resources
- allow cancellation and release GPU and memory resources
- benchmark the actual WD14 model on representative desktop and mobile devices

WD14 is not a launch requirement. Pixel access depends on provider media CORS,
and WebGPU support and performance vary by browser and device. Do not add a
hosted inference fallback without a separate privacy, cost, and abuse decision.

### Limited hosted data

A small hosted database is allowed for public, shared, non-user-specific data:

- current and minimum supported application versions
- provider capabilities and temporary availability flags
- public tag taxonomy or import metadata
- backup schema compatibility metadata
- public maintenance notices

It must not store or derive:

- provider credentials or session cookies
- favorites, subscriptions, read history, searches, or blacklist entries
- imported media or thumbnails from a user's library
- backup contents or encryption secrets
- stable cross-site profiles of user activity

Anonymous aggregate telemetry requires a separate decision that defines each
event, its purpose, retention, and opt-in or opt-out behavior.

### Versioning and migrations

Use Git history as the source of build identity, not as a replacement for data
migrations.

- release product versions as semantic Git tags such as `v0.2.0`
- attach GitHub releases to those tags
- embed the semantic version and full commit SHA in the web build
- display both in an About or diagnostics view
- expose the deployed version through a static version manifest
- version the IndexedDB schema and backup format independently
- migrate browser data forward transactionally before starting the new build
- retain an export path before any irreversible local migration

Service worker updates must not leave open tabs running code against an
incompatible local schema. Detect a waiting version, finish or cancel active
writes, and require a controlled reload when compatibility demands it.

### Hosted application responsibilities

The hosted application serves static assets and the limited public data above.
It does not run the current Fastify API, background worker, or tagger as part of
the default user flow.

The deployment must preserve one canonical production origin because local data
belongs to that origin. Preview deployments use isolated storage and must make
that separation visible to testers.

### Cloudflare deployment options

Cloudflare offers several ways to publish a website. They do not have the same
ownership or runtime model:

| Option                                                                                       | What Cloudflare hosts                                                      | Fit for GoonCave                                                                                                       |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [Workers with Static Assets](https://developers.cloudflare.com/workers/static-assets/)       | The compiled frontend and optional Worker routes in one deployment         | **Recommended.** Serves the Vite SPA and leaves room for a small public API without introducing an origin server       |
| [Pages](https://developers.cloudflare.com/pages/)                                            | Static assets, Git-based preview deployments, and optional Pages Functions | Valid for a strictly static site, but less direct than one Workers deployment when public API routes are expected      |
| [Workers full-stack frameworks](https://developers.cloudflare.com/workers/framework-guides/) | Static assets plus server-rendered or dynamic framework code               | Supported, but server-side rendering is not required for the browser-local product                                     |
| [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)            | Public objects behind a custom domain                                      | Use only for large public artifacts such as an optional WD14 model; do not use it as the primary application host      |
| Proxied DNS to an external origin                                                            | CDN and security in front of a publicly reachable server hosted elsewhere  | Fallback only when a required runtime is incompatible with Workers; the external origin remains operationally required |
| Cloudflare Tunnel                                                                            | Connectivity from Cloudflare to an existing private origin                 | Not hosting. It leaves the application and data on the origin server                                                   |
| [Cloudflare Containers](https://developers.cloudflare.com/containers/)                       | Container workloads reached through Workers                                | Not selected. It preserves server and container complexity that the browser-local architecture removes                 |

If the browser-local architecture is adopted, use Workers Static Assets as the
recommended deployment target. The proposed first deployment unit contains:

- the compiled React and Vite assets
- SPA fallback routing to `index.html`
- a static version manifest
- optional Worker routes for the limited public data permitted by this ADR

Static asset requests should bypass Worker execution when no dynamic behavior is
required. Add D1, KV, or R2 only after a concrete data or object-storage need is
demonstrated. Do not deploy the existing Fastify API, worker, or tagger into this
target.

The proposed deployment uses a custom production domain as the canonical origin.
If R2 is introduced for production assets, expose it through a custom domain;
the managed `r2.dev` endpoint is for development and is rate-limited.

The recommended delivery path is GitHub Actions with Wrangler. It would run
repository checks before `wrangler deploy` and deploy production only from the
designated production branch. A push must not publish a build that failed its
checks. Preview deployments must use a different origin and must never be
presented as containing the user's production browser data.

## Rationale

This design keeps private data and provider credentials under the user's browser
profile while allowing GoonCave to be opened as a normal website. Direct
provider requests distribute bandwidth and rate limits across user connections
instead of making the GoonCave service a shared bottleneck.

The design also keeps operating cost bounded. The hosted service serves the app
and small public datasets rather than user media, authenticated provider
traffic, or machine-learning inference.

The feasibility gate protects the project from completing a browser rewrite
before proving the browser can satisfy provider CORS, authentication, media, and
request-policy constraints.

## Consequences

### Benefits

- Core use requires no installation and no GoonCave account.
- Private application state is not stored on the GoonCave server.
- Provider traffic and credentials do not pass through GoonCave by default.
- Users can opt into backups using storage they control.
- Static hosting has lower operational cost and a smaller attack surface than a
  multi-user media backend.
- Client-side WD14 can preserve privacy and avoid hosted inference cost where
  the device supports it.

### Costs and limitations

- Browser storage is bound to a device, browser profile, and exact origin.
- Clearing site data removes the working copy.
- Fixed-time daily backup cannot run reliably while the site is closed.
- Initial backups are snapshots, not conflict-free multi-device sync.
- Provider support will differ according to CORS, authentication, media CDN,
  and request-header policies.
- JavaScript cannot set restricted headers such as `User-Agent`.
- Direct provider access reveals the user's IP address to that provider, as a
  normal visit does.
- The host-folder library, automatic downloads, worker jobs, and file duplicate
  actions do not transfer directly to the web product.
- WD14 performance and compatibility will vary across devices.
- The current Fastify, SQLite, worker, and filesystem architecture cannot be
  reused unchanged.

## Alternatives considered

### Publish the current stack through Cloudflare Tunnel

Rejected for this product direction. A tunnel changes ingress, not storage
ownership. Data, credentials, media, worker load, and WD14 remain on the origin
server.

### Host the current backend and all user data

Rejected. It would require operating a multi-tenant service that stores private
metadata, provider credentials, and potentially large media libraries. It adds
privacy, security, abuse, backup, moderation, and cost responsibilities that are
outside the intended product.

### Send all provider traffic through a GoonCave proxy

Rejected. It centralizes rate limits and bandwidth, exposes user credentials to
GoonCave infrastructure, and creates an abuse target.

### Store originals in Google Drive by default

Rejected. It makes backups large and slow, duplicates provider media, consumes
user quota, and changes a metadata backup into a media-hosting system. Explicit
offline copies may be evaluated later.

### Require a local companion from the first release

Deferred. A companion can recover providers that cannot work under browser
constraints, but it removes the no-install benefit. Consider it only after the
provider feasibility gate demonstrates a concrete need.

## Evaluation and possible delivery sequence

1. Execute the e621 and Danbooru browser feasibility spike.
2. Publish the provider capability matrix and decide the supported launch set.
3. Accept, reject, or revise this proposal in a follow-up decision.

Only if the proposal is accepted:

4. Build the browser storage layer with schema migrations, quota handling, and
   manual export and restore.
5. Implement one complete provider flow without a GoonCave proxy.
6. Add the installable PWA shell and controlled service worker updates.
7. Add Google Drive snapshot backup and recovery testing.
8. Deploy the SPA with Workers Static Assets through a gated GitHub Actions
   workflow.
9. Add the limited public service only for demonstrated shared-data needs.
10. Prototype WD14 with the actual model and representative devices.
11. Evaluate explicit imports, offline originals, and additional providers after
    the core product is stable.

Each step must preserve an inspectable export of the user's local data. Failure
of a provider, backup, migration, or model operation must not corrupt the last
known-good local state.
