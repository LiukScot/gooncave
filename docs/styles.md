# Interface styles

GoonCave has one React interface and three styles the user picks in
Settings → Appearance: **Material Edition**, **Apple Edition**, and **Custom**
(the original GoonCave look). Each combines with light, dark, or system mode and
an accent colour. A style changes colours, shapes, and motion; it never changes
layout, content, or behaviour.

This document lists how the styles differ, so a new feature can be built once
and look right in all three.

## How a style is applied

| Piece | Where | What it does |
| --- | --- | --- |
| Choice | `frontend/src/stores/appearanceStore.ts` | `mode`, `style`, `accent`, saved per device in `localStorage` (`gooncave:appearance`). |
| Accents | `frontend/src/lib/accents.ts` | Black and white, Blue, and 12 tints from red to purple. |
| Page attributes | `applyAppearance` in `frontend/src/lib/materialTheme.ts` | Sets `class="dark"`, `data-style`, and `data-accent` on `<html>`, plus `color-scheme`. CSS selects on these. |
| Colours | `frontend/src/index.css` (fixed tokens) and `materialTheme.ts` (generated tokens) | See [Colours](#colours). |
| Shapes and motion | `frontend/src/app.css`, in sections headed `=== Tonal controls ===`, `=== Custom ===`, `=== Apple Edition ===`, `=== Apple Edition: Liquid Glass motion ===` | See [Components](#components). |
| Moving parts | `frontend/src/lib/glassMotion.ts` | Places the selection pill in tab bars and segmented controls; records press points; the Apple lens animation. |

Changing style drops the tab bar out of view, applies the new style, places the
selection pill, and raises the bar (`data-restyling`). Nothing in the bar may
animate while it is hidden.

## Colours

Components read semantic tokens only: `--background`, `--page-background`,
`--foreground`, `--card`, `--popover`, `--primary`, `--primary-foreground`,
`--secondary`, `--muted`, `--muted-foreground`, `--accent`, `--border`,
`--input`, `--ring`, `--accent-link`, `--destructive`, `--warning`, `--success`,
`--section` (the panel behind a settings group), `--surface-media` (the band
behind a picture). Each is an `H S% L%` triple: write `hsl(var(--token))` or
`hsl(var(--token) / 0.5)`.

| | Material | Apple | Custom |
| --- | --- | --- | --- |
| Source | Generated from the accent by Material 3 (`SchemeExpressive`; `SchemeMonochrome` for black and white), written as inline styles on `<html>` | Fixed iOS system colours in `index.css` | Fixed original palette in `index.css` |
| Accent | Seeds the whole palette | Sets `--primary`, `--ring`, `--accent-link` only | Same as Apple; Blue keeps the original blue |
| Open picture | Repaints the whole palette from the picture (`SchemeVibrant`) | Replaces the accent with the picture's hue | Same as Apple |
| Light page | Tinted (`surfaceContainer`) | iOS grey `#f2f2f7` | Pale blue-grey |
| `--section` | One tone up from the page | iOS grouped-list card | The page itself (outlined groups) |

Literal colours are allowed only on top of media (picture buttons, video bar):
white ink on a dark glass, because the picture is behind them, not the page.

## Components

Shared classes carry every style. Use them and a new feature inherits all three
looks without style-specific code.

| Component (class) | Material | Apple | Custom |
| --- | --- | --- | --- |
| Button (`.btn`, `.btn-outline-light`) | Pill; tonal fill (`--muted`), edge the same colour; corners square slightly under a press | Pill; grey glass fill; swells under a press (`--press-scale`) | Small corners (`--radius-md`); outlined |
| Chosen button (`.btn-primary`) | Accent fill | Accent fill | Accent fill |
| Coloured outline (`.btn-outline-danger` etc.) | Faint fill of its colour | Faint fill of its colour | Outlined in its colour |
| Option group (`.btn-group`) | Separate segments, round ends, chosen one fully round | Capsule track; a raised thumb slides to the choice | One joined strip; only its ends rounded |
| List (`.list-group-segmented`) | Separate rows with tight inner corners | One rounded card, hairlines inset from the icon | One outlined box, rows split by rules |
| Panel (`.appearance-group`, `.rounded.border.border-secondary`) | Filled with `--section`, no outline | Filled with `--section` | Outlined on the page |
| Input (`.form-control`, `.form-select`) | Pill, tonal fill | Pill, grey fill | Small corners, outlined |
| Switch (`.form-switch`) | Material 3: 52×32 track, handle 16 / 24 / 28 px | iOS 26: 63×28 capsule, 38×24 knob | Original: 36×20 track, 16 px knob |
| Tab bar (`.app-tab-bar`) | Two capsules; the open view widens to show its name | Full width; views left, Settings right; glass; icon over name | One connected capsule, a rule before Settings; icon over name; accent pill |
| Page title (`.page-title`) | Large display font with the view icon | iOS large title with the view icon | Small uppercase title with the view icon |
| Pool bar (`.pool-nav`) | `--section` panel, no outline; Prev/Next tonal pills | Glass bar with the sheen; Prev/Next clear capsules | Outlined card; outlined pills |
| Picture buttons, video bar (`.file-detail-overlay-btn`, `.video-controls-bar`) | Tonal fill | Dark glass | Dark translucent with white edge |
| Choice menu (`.confirm-menu`) | One joined group above the destructive action | Separate capsules | Separate buttons, small corners |
| Messages (toasts, `.file-detail-vote-undo`) | Accent fill | Glass | Card colour, outlined |
| Sheets, menus, popovers | Default | Glass; materialize from blur | Default |

Behaviour shared by all styles: favourited and voted controls fill with the
accent and draw a solid icon (`.is-on`, `.is-active`, `.is-voted`); card videos
show only play/pause and a time track; tapping the open tab clears its search and
glides to the top.

## Motion

| | Material | Apple | Custom |
| --- | --- | --- | --- |
| Curve | Expressive spring `--ease-spring` | SwiftUI springs `--spring-smooth`, `--spring-snappy`, `--spring-bouncy` | `cubic-bezier(0.22, 1, 0.36, 1)` |
| Selection | Each chosen item fills on its own | Lens lifts, stretches, settles (`morph` in `glassMotion.ts`) | Pill slides |
| Navigation | Tab slides | Tab slides; Settings pages push and pop | Tab slides |

Every animation stops under `prefers-reduced-motion: reduce`.

## Adding a feature

1. Use semantic tokens. No colour literals outside media overlays.
2. Build from shared classes (`.btn`, `.btn-group`, `.list-group-segmented`,
   `.form-control`, `.form-switch`, `.confirm-menu`,
   `.file-detail-overlay-btn`, `.explore-action-btn`). Check the result in all
   three styles before writing any style-specific rule.
3. Need a new component? Write its base rule first (Material is the base). Then
   add, only where its look must differ:
   - a fill-instead-of-outline rule in `=== Tonal controls, in Material and Apple ===`,
     with `:root:not([data-style='custom'])`;
   - an Apple rule in `=== Apple Edition ===`, with `:root[data-style='apple']`;
   - a Custom rule in `=== Custom ===`, with `:root[data-style='custom']`.
4. A group with one chosen item: use `.btn-group` with `.btn-primary`, or the tab
   bar classes. The pill and morph come from `glassMotion.ts`.
5. Check light, dark, and every style in Settings → Appearance; open a picture to
   see the accent swap; turn on reduced motion and reduced transparency.

## Known traps

- **Wrappers break child selectors.** A rule written with `>` skips an item
  inside a wrapper (the Explore Hot button sits in `.explore-hot-control`). Use
  descendant selectors for groups, or style the wrapper's child explicitly.
- **`:is()` and `:where()` cannot hold pseudo-elements.** The selection pill is a
  `::before`; list it as a separate selector.
- **Chosen-state rules can outweigh position rules.** In a joined strip, the
  "chosen" rule must not be more specific than the "first/last" corner rules.
- **The glass rule must not set `position`.** Floating capsules are
  `position: fixed`; toasts are placed by sonner.
- **Measure after transitions.** Sizes change after a class does; the pill
  follows each item's size (`ResizeObserver`) instead of measuring once.
- **Background tabs freeze frames and animations.** Use timers, not
  `requestAnimationFrame`, for anything that must run there; test motion in a
  visible tab.
- **WebKit engines** (Safari, iOS, Linux WebKitGTK) ignore
  `backdrop-filter: url()`; the Apple lens bend is Chromium-only. Its absence
  must never hide content.
