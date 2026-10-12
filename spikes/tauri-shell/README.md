# Tauri shell spike

A throwaway test app. It decides whether Tauri is the shell of the desktop app
and of the phone apps. Nothing in the product imports it; delete the folder once
both results are recorded.

The app opens one page with three checks:

1. **Rust call:** the page asks the Rust side for an answer and shows it.
2. **Video playback:** an H.264 (MP4) and a VP9 (WebM) video.
3. **Page transitions:** whether the engine supports the typed View Transitions
   GoonCave uses to slide between pages, and a demo slide.
4. **Gestures (iPhone):** the native back/forward swipe from the screen edges,
   a finger-following swipe between pictures, and a side menu opened by a swipe
   from the middle.
5. **Gallery scrolling:** a field that opens your running GoonCave, so the real
   gallery and library are scrolled inside the Tauri window.

The `Tauri shell spike` workflow builds both apps on every pull request that
changes this folder and attaches them to the run as artifacts.

## Linux: Flatpak

Download `gooncave-shell-test-flatpak` from the workflow run, unzip it, then:

```bash
flatpak install --user GoonCaveShellTest.flatpak
flatpak run app.gooncave.ShellSpike
```

The first install also downloads the GNOME 51 runtime from Flathub.

Tauri passes the desktop test when:

- both videos play;
- scrolling the GoonCave gallery from top to bottom looks as smooth as the same
  gallery in Chrome on the same computer.

If H.264 does not play, first check that the codecs extension is installed:

```bash
flatpak list --runtime | grep codecs-extra
```

If it is missing, install it with `flatpak install --user flathub org.freedesktop.Platform.codecs-extra//26.08-extra`
and test again. A failure with the extension installed is a WebKitGTK failure.

Remove the test app with `flatpak uninstall --user app.gooncave.ShellSpike`.

## iPhone: unsigned IPA

Download `gooncave-shell-test-iphone` from the workflow run, unzip it, sign
`GoonCaveShellTest.ipa` with KravaSign and install it.

Tauri passes the phone test when the app opens and the first check shows
`Rust answered on ios (aarch64)`.

Page transitions work when the support line shows `yes` twice and the coloured
page slides sideways. If the support line shows `no`, GoonCave changes page
without animation in this engine; the `Engine` line names the WebKit version.

Gestures work when:

- after opening step 3, a swipe from the left edge goes back to step 2 and a
  swipe from the right edge returns to step 3;
- the coloured panel follows the finger and snaps to the next picture;
- the side menu follows a swipe from the middle and opens, and a swipe left
  closes it.

Tauri has no setting for the edge swipes; `src-tauri/src/lib.rs` turns them on
directly on the iPhone web view, as the current iPhone app does in Swift.

## Decision

| Result | Next step |
| --- | --- |
| Desktop passes | Tauri is the desktop shell. |
| Desktop fails | Try Electrobun with bundled CEF; if its Flatpak does not work, Electron. |
| iPhone passes | Tauri is the phone shell. |
| iPhone fails | Capacitor with a Swift bridge to the Rust core. |
