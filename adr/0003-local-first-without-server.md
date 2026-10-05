# ADR 0003: Local Apps Without a Server

## Status

Accepted on 2026-10-05 at the owner's request. It sets a direction; each
platform's implementation still goes through its own pull requests.

Supersedes the "packaged server edition" as the long-term PC direction in
[platform versioning](../docs/versioning.md). Server mode remains supported
during the transition (see Decision).

## Date

2026-10-05

## Context

GoonCave runs as a self-hosted service:

- Fastify owns authentication, provider calls, API routes, and static serving.
- SQLite stores users, provider credentials, favorites, tags, and application
  state on the host.
- A worker reads and writes media, thumbnails, and caches on the host
  filesystem; ffmpeg and ffprobe read video.
- A separate Python service runs the WD14 ONNX tagger
  (`SmilingWolf/wd-v1-4-convnextv2-tagger-v2`, 388.5 MB).
- The PC release is an installer that sets up these services in Docker; the
  iPhone app opens a server's website in a native shell.

Every user therefore needs a machine running Docker, a network path from each
device to it, and an account on it. The library already belongs to the user;
the server is only the place it runs.

## Decision

GoonCave moves to apps that run entirely on the user's device, with no server
and no GoonCave account.

- **Platforms:** a desktop app (Linux AppImage and Windows .exe), the iPhone app
  (IPA), and an Android app (APK). Android still needs the owner's approval of a
  release target ([versioning](../docs/versioning.md)).
- **Gradual:** each platform gains local features step by step. Server mode stays
  fully working until the local apps reach feature parity, and is retired only
  after that.
- **Accounts:** account creation is dropped together with the server. Booru site
  credentials stay, stored on the device. What replaces GoonCave accounts on a
  local install (a single owner, local profiles, or none) is undecided.
- **Tagging is optional:** the base app ships search, the gallery and sync
  without the tagger. The WD14 model and its runtime are a separate in-app
  download that the user can decline.
- **One interface:** every platform keeps the shared React interface and its
  three styles ([docs/styles.md](../docs/styles.md)).

## Constraints found

Measured or verified on 2026-10-05:

| Fact | Consequence |
| --- | --- |
| The tagger model is 388.5 MB; its runtime adds about 46 MB on Linux and 29 MB on Windows (onnxruntime-node 1.30). | The optional tagger download is about 430–440 MB; the base desktop app is estimated at 180–250 MB. |
| onnxruntime-node runs the model under Bun on Linux (about 0.3 s per image) and loads from a folder downloaded at run time. | Desktop tagging can drop Python. |
| onnxruntime-node under Bun crashes on Windows x64 ([oven-sh/bun#28008](https://github.com/oven-sh/bun/issues/28008), open). | Windows tagging needs a fallback until fixed, such as a small separate tagger program built on the Rust `ort` crate. |
| `sharp` cannot be embedded in a `bun build --compile` binary ([oven-sh/bun#15374](https://github.com/oven-sh/bun/issues/15374)). | The desktop app ships sharp's native libraries beside the backend binary. |
| Tauri AppImages bundle the build host's WebKitGTK and fail on some distributions (EGL errors on Arch/CachyOS with AMD and Wayland) and need GStreamer bundled for video. WebKit does not render `backdrop-filter: url()`. | The desktop shell is open; Electron, with the same Chromium on every desktop, is the leading candidate. A build spike decides it. |
| Bun does not run on iOS, and on Android it is blocked by the system ([oven-sh/bun#30766](https://github.com/oven-sh/bun/issues/30766)). | On phones, the backend's work (database, file scanning, thumbnails, provider calls) must be reimplemented in native or Rust code; ONNX runs through its official Android and iOS packages, likely with a smaller quantized model. |

## Consequences

- Users install one app per device; no Docker, network setup, or account.
- Phone libraries and desktop libraries are separate. Moving data between them
  needs an explicit import, export, or sync workflow.
- The backend stops being the single place business rules live. Each rule that
  phones need must exist in a form the phone can run.
- Multi-user servers lose support when server mode is retired.
- Server API compatibility (`apiVersion`) matters only while server mode exists.

## Open decisions

- [ ] Choose what replaces accounts on a local install.
- [ ] Choose the desktop shell after the build spike (bundled backend with sharp,
  argon2 and SQLite on Linux and Windows; video playback; loading the tagger
  from a downloaded folder).
- [ ] Choose the phone backend approach (native code, Rust shared core, or
  another option) and the tagger model size for phones.
- [ ] Approve an Android release target.
- [ ] Set the feature-parity checklist that allows retiring server mode.
