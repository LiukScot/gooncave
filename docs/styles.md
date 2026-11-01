# Interface look

GoonCave has one look: Material 3. Settings → Appearance changes only the mode
(light, dark or system) and the accent colour. Neither changes layout, content
or behaviour.

## How the look is applied

| Piece | Where | What it does |
| --- | --- | --- |
| Choice | `frontend/src/stores/appearanceStore.ts` | `mode` and `accent`, saved per device in `localStorage` (`gooncave:appearance`). A saved `style` from an older version is ignored. |
| Accents | `frontend/src/lib/accents.ts` | Black and white, Blue, and 12 tints from red to purple. |
| Page attributes | `applyAppearance` in `frontend/src/lib/appearanceTheme.ts` | Sets `class="dark"` and `color-scheme` on `<html>`, and writes the accent tokens. |
| Colours | `frontend/src/index.css` (base tokens) and `appearanceTheme.ts` (accent tokens) | See [Colours](#colours). |
| Shapes and motion | `frontend/src/app.css` | See [Components](#components). |

## Colours

The page is almost black in dark mode (`--page-background: 0 0% 0%`) and light
grey in light mode. Surfaces just above it (cards, bars, inputs, panels) are
neutral greys in both modes. The chosen colour never changes a surface.

Only these tokens take the accent, and `appearanceTheme.ts` writes them from a
Material 3 scheme (`SchemeExpressive`; `SchemeMonochrome` for black and white):
`--primary`, `--primary-foreground`, `--ring`, `--accent-link`. They colour
the selected tab, the chosen button of a group, a switch that is on, the primary
button, links, and the focus ring.

Components read semantic tokens only: `--background`, `--page-background`,
`--foreground`, `--card`, `--popover`, `--primary`, `--primary-foreground`,
`--secondary`, `--muted`, `--muted-foreground`, `--accent`, `--border`,
`--input`, `--ring`, `--accent-link`, `--destructive`, `--warning`, `--success`,
`--section` (the panel behind a settings group), `--surface-media` (the band
behind a picture). Each is an `H S% L%` triple: write `hsl(var(--token))` or
`hsl(var(--token) / 0.5)`. `--accent` is the neutral hover fill, not the chosen
colour.

The detail view takes no colour from the open image.

`frontend/src/lib/appearanceTheme.test.ts` checks that for every accent, in dark
and light, the text on an accent fill reaches 4.5:1 and the accent reaches 4.5:1
on every surface.

Literal colours are allowed only on top of media (picture buttons, video bar):
white ink on a dark fill, because the picture is behind them, not the page.

## Components

Use the shared classes (`.btn`, `.btn-group`, `.list-group-segmented`,
`.form-control`, `.form-switch`, `.confirm-menu`, `.file-detail-overlay-btn`,
`.explore-action-btn`) and a new feature inherits the look.

| Component (class) | Look |
| --- | --- |
| Button (`.btn`, `.btn-outline-light`) | Pill; tonal fill (`--muted`), edge the same colour; corners square slightly under a press |
| Chosen button (`.btn-primary`) | Accent fill |
| Coloured outline (`.btn-outline-danger` etc.) | Faint fill of its colour |
| Option group (`.btn-group`) | Separate segments, round ends, chosen one fully round |
| List (`.list-group-segmented`) | Separate rows with tight inner corners |
| Panel (`.appearance-group`, `.rounded.border.border-secondary`) | Filled with `--section`, no outline |
| Input (`.form-control`, `.form-select`) | Pill, tonal fill |
| Switch (`.form-switch`) | 52×32 track, handle 16 / 24 / 28 px |
| Side menu (`.app-menu`, `.app-menu-drawer`) | Column of views; the open one takes the accent fill. Stays showing from 1024 px, slides in below it, follows the finger, and pushes the page aside by its own width. On a phone the pushed page's corners curve like the screen's |
| Lens (`.search-lens`) and panel (`.search-panel`) | The only control over the page, in the accent colour. The order always has a chip under the title, without a remove button at its default. The lens counts the filters that can be removed; opens a sheet from the bottom, or a panel over the lens from 1024 px |
| Page title (`.page-title`) | Large display font with the view icon |
| Pool bar (`.pool-nav`) | `--section` panel, no outline; Prev/Next tonal pills |
| Picture buttons, video bar (`.file-detail-overlay-btn`, `.video-controls-bar`) | Tonal fill |
| Choice menu (`.confirm-menu`) | One joined group above the destructive action |
| Messages (toasts, `.file-detail-vote-undo`) | Accent fill |

Favourited and voted controls fill with the accent and draw a solid icon
(`.is-on`, `.is-active`, `.is-voted`); card videos show only play/pause and a
time track; tapping the open view in the menu clears its search and glides to the top.

Moving between the views of the menu changes the page at once, with no slide.

In Gallery and Explore, opening a file, changing file or entering fullscreen
shows media controls for four seconds. Tapping the media toggles them on release;
scrolling and dragging leave visibility unchanged. Using a control restarts the
timer after release. Mouse movement anywhere in the detail view restarts the
timer, including over pool indicators and other
controls below the media. Leaving the view also starts a fresh timer.
Mouse hover, keyboard focus and paused custom video playback keep controls
visible. Hidden controls do not take
taps. In inline and fullscreen video views, playback and fullscreen share the
bottom row. Votes, favourites and cooldowns join that row when the media frame
has room for them and a usable seek bar. On narrower frames they wrap just above
playback at the right. The width needed depends on how many actions are present.
Elapsed time and duration stay on one line; the seek track shrinks to make room.
Delete stays in file info. Controls respect device safe areas without reserving
space for native player controls. All platforms, including iPhone, use the app's playback bar and the same visibility
state for playback, vote, favourite and fullscreen controls. During playback,
tapping the video toggles all controls together without pausing it. Use the
play/pause button on touch screens; mouse clicks on the video still toggle
playback. Starting playback restarts the four-second timer.

On a phone (width under 768 px) the favourite and vote buttons leave the picture
and sit at the screen's bottom right (`PhoneActions`), always shown outside
fullscreen. Toasts rise above them.

## Motion

What a finger drags follows the finger from start to end and glides the rest of the
way when let go (`lib/fingerOpening.ts`), never waiting for a threshold to play.

Shapes move on the expressive spring `--ease-spring`. Every animation stops under
`prefers-reduced-motion: reduce`.

## Adding a feature

1. Use semantic tokens. No colour literals outside media overlays.
2. Build from the shared classes. Check the result in light and dark, with a
   few accents, at 375 px and at desktop width.
3. A group with one chosen item: use `.btn-group` with `.btn-primary`.
4. Turn on reduced motion and check that nothing moves.

## Known traps

- **Wrappers break child selectors.** A rule written with `>` skips an item
  inside a wrapper (the Explore Hot button sits in `.explore-hot-control`). Use
  descendant selectors for groups, or style the wrapper's child explicitly.
- **`:is()` and `:where()` cannot hold pseudo-elements.** List a `::before` as a
  separate selector.
- **Chosen-state rules can outweigh position rules.** In a joined strip, the
  "chosen" rule must not be more specific than the "first/last" corner rules.
- **Background tabs freeze frames and animations.** Use timers, not
  `requestAnimationFrame`, for anything that must run there; test motion in a
  visible tab.
