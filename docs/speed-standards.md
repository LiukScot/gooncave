# Speed standards

The `Playwright speed` CI job opens each screen on a library of 250 pictures and
a video, at the desktop and iPhone viewports, and fails when a number goes over
its standard. Run it locally with `npm run test:speed`. It needs FFmpeg and Rust.

Each screen is opened 5 times in an empty browser, and the job compares the
median. The standards are in [tests/speed/standards.json](../tests/speed/standards.json):
`screens` holds the numbers and `tolerances` how far each may rise.

## Reading a failure

A failure names the screen, the metric and the numbers:

```text
desktop/gallery firstContentMs: measured 1293, standard 309, limit 609
```

| Metric | What it counts | Where to look |
| --- | --- | --- |
| `firstContentMs` | From the start of the page load until the screen shows its content | Work added before the first render |
| `lastThumbnailMs` | Until the last picture on screen has arrived | The thumbnail requests in `speed-requests.json` |
| `requests` | Requests the screen made | A request added or repeated |
| `siteRequests` | Requests that can make the core ask a booru | A new call on opening a post. Boorus answer one at a time, so each extra one delays the others |
| `failedRequests` | Requests that ended without an answer or with status 400 or above | The status in `speed-requests.json` |
| `slowestRequestMs` | The longest single request | The duration in `speed-requests.json` |

`thumbnails without a picture` names the files whose thumbnail did not load. It
has no tolerance.

The job uploads `speed-requests.json` with every request of the last opening:
path, status and duration.

## Moving a standard on purpose

Do this when a change makes a screen faster, or when it must cost more and the
pull request says why.

1. Let the `Playwright speed` job run on the pull request.
2. Download the `speed-measurements` artifact of that run.
3. Replace `tests/speed/standards.json` with its `speed-standards.json`.
4. Commit the file in the same pull request.

Use numbers from the CI job only: a developer's computer runs at another speed.
A new screen fails with `no standard yet` until its numbers are added this way.

## What it does not measure

- Booru answers are faked, because a site's speed is not this code's. The number
  of requests per detail view is measured instead; `core/src/files.rs` has a test
  for how many of them reach e621.
- The iPhone viewport runs in Chromium on the runner, not in WebKit on a phone.
- The core is a debug build and the library is far smaller than a real one, so
  the numbers show changes, not the times a person sees.
