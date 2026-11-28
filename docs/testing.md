# What the tests cover

Each suite runs in one environment, and a bug only shows where that
environment can draw it. This page says what each suite sees, what none of
them sees, and what to check by hand before a release.

## Suites

| Suite | Command | Runs in | Sees |
| --- | --- | --- | --- |
| Core | `cargo test --locked -p gooncave-core` | Rust, temporary SQLite and loopback ports | API answers, migrations, scans, thumbnails, search, sync |
| Frontend units | `npm --prefix frontend test` | Vitest in Node | Logic of single modules: URL parsing, layout maths, stores |
| Browser | `npm run test:e2e` | Headless Chromium against the debug core, at desktop and phone viewports | What a person does on a screen: taps, swipes, scroll, panels, the pixels Chromium draws for the page |
| Speed | `npm run test:speed` | Headless Chromium, 250 pictures | Time to open each screen and its requests ([speed standards](speed-standards.md)) |
| Desktop window | `npm run test:desktop` | Electron with the desktop core | The native window: closing, title bar, drag regions, window colour |
| iPhone shell | `cargo test --locked -p gooncave-ios` (CI, macOS) | Rust | The shell's bridge to the core; no screen |

## Checks every browser test makes

Specs import `test` and `expect` from `tests/helpers.ts`, not from
`@playwright/test`; `npm run lint` and CI refuse the latter. That `test` fails
when, once the test ends, the browser console holds an error, an uncaught
exception, or a server error (500 and above) from the core. Other failed
requests are left out: fixtures use sites that do not exist, and the speed job
counts failed requests. A test that causes an error on purpose names it first:
`allowConsoleError(/\/device: .*status of 500/)`.

`tests/frameFlash.ts` records every frame Chromium draws during an action
(`expectNoFlash`). It fails when white or black covers a quarter of the window
more than on the screens before and after, and attaches those three frames.
`tests/navigation-flash.spec.ts` uses it on going into Settings and back and
on opening a file and going back, in dark and light mode, at a 1.25 display
scale.

## Fake booru sites

`tests/fakeBooru.ts` serves a site on this computer that answers like e621,
and adds it to the core as a booru. The core then does its own work on the
answers: paging, read marks, comparing pictures for copies. A normal run
refuses sites on local addresses; `playwright.config.ts` starts the core with
`GOONCAVE_TEST_LOCAL_SITES=1`, which lets it reach them, and the app log says
so at start. Older specs fake the core's answers with `page.route` instead,
which skips that work: a new Explore test uses a fake booru.

## What no suite sees

| Gap | Why | Example that got through |
| --- | --- | --- |
| Frames the GPU or the window draws after Chromium | The frame recording reads Chromium's output for the page; the browser suites render in software | Under XWayland at a fractional display scale, the GPU drew the page being left as a white picture during page animations |
| The Flatpak package | No suite starts the app from the Flatpak; CI only builds it | The launcher started Electron under XWayland, where the flash above happens, instead of Wayland |
| WebKit on an iPhone | The phone viewport runs in Chromium | Swipe and safe-area behaviour of WebKit; `loading="lazy"` pictures that WebKit fetches only near the screen, so a fast scroll showed them filling in |
| Real booru sites | Answers are faked, so a site's changes and speed are not this code's | A site changing its HTML or its rate limit |
| A real library | Fixtures hold a few files; speed uses 250 | Slowness that starts at tens of thousands of files |

## Checks by hand before a release

Run these on the release build, on the desktop app installed from the
`.flatpak` and on the iPhone `.ipa`.

| Action | Expected |
| --- | --- |
| In dark mode, open Settings → Appearance and go back; repeat in light mode | The pages slide; no white or black frame between them |
| Open a file from the Gallery, then go back with the back button and with a swipe | The Gallery returns at the same tile; no white or black frame |
| Scroll the Gallery fast to the bottom and back to the top | Tiles fill in; the background never turns white |
| Open and close the app window | The window opens in the page colour, not white |

When a by-hand check finds a flash, record the screen before fixing it
(GNOME: Ctrl+Shift+Alt+R; iPhone: the screen recorder in Control Centre) and look at it frame by
frame: the frame shows which layer draws the colour.

## Where a new test goes

1. Logic of one module: a unit test next to the module.
2. Anything a person sees or touches: a browser spec in `tests/`, at the
   viewport and input (mouse, touch) where the bug appears.
3. Something only the native window does: `desktop/electron/window.spec.ts`.
4. A bug that comes back with a different cause: test the symptom as the person
   sees it on every path that produces it, not only the cause just fixed.

Run the new test on the code without the fix. If it passes there, the
environment cannot draw the bug: add a row to the table of gaps above and a
check by hand instead.
