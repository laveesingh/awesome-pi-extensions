# pi-viewport-mouse

Mouse click routing for the [Pi coding agent](https://pi.dev) TUI.

Pi captures mouse events for scrolling, text selection and OSC 8 links, but never routes them to the
components in your transcript. This extension resolves a click to the components underneath it and
publishes it as an event. It performs **no UI action of its own** — other extensions subscribe and
decide what a click means.

```
      click at (x, y)
            │
            ▼
  ┌───────────────────┐     event { target, chain, row, … }     ┌──────────────────┐
  │  pi-viewport-mouse │ ──────────────────────────────────────▶ │  your extension  │
  └───────────────────┘                                          └──────────────────┘
     resolves the click                                        decides what it means
```

## Why it is needed

Pi's layout engine only creates layout boxes for `ScrollView` and `VStack`/`HStack`. Every other
component — `Container`, `Box`, `Text`, `ToolExecutionComponent` — renders into *lines* inside a
parent box, so the whole transcript collapses into a single box holding an array of strings. There is
no rectangle per block to hit-test against, and the `Component` interface has `render` and
`handleInput` (keyboard) but no mouse hook.

So a click gives you a row number and nothing maps that row back to a component. This package rebuilds
that mapping.

## Install

```bash
pi install npm:pi-viewport-mouse
```

On its own it does nothing visible — install it alongside an extension that subscribes, or write one.

## Usage

```ts
import { onViewportClick } from "pi-viewport-mouse/client";

export default function myExtension() {
  onViewportClick("my-extension", (event) => {
    // Walk outward from the clicked component to the first collapsible block.
    const block = event.closest((c) => typeof c.setExpanded === "function");
    if (!block) return false;            // not ours — later handlers still see it

    block.setExpanded(!block.expanded);
    event.requestRender();
    event.flash(`${block.toolName} toggled`);
    return true;                          // claimed — stop dispatch
  });
}
```

`pi-viewport-mouse/client` imports nothing from Pi, so depending on it is cheap. It also creates the
shared registry if it does not exist yet, which means **extension load order does not matter** — a
consumer that loads first still registers successfully.

### The event

| Field | What it is |
|---|---|
| `target` | Innermost component under the click |
| `chain` | Every component whose rows contain the click, outermost first (`Hit[]`) |
| `row` | Content row clicked, in document coordinates |
| `x`, `y` | Screen coordinates, zero-based |
| `button` | SGR button code |
| `closest(fn)` | Nearest component in the chain matching `fn`, searched innermost first |
| `rowWithin(c)` | Row offset of the click inside `c`, or `-1` if `c` is not in the chain |
| `requestRender()` | Redraw after mutating a component |
| `flash(msg, ms?)` | Transient message in the alternate-screen flash stack |
| `scrollView`, `tui` | The underlying Pi objects, for anything the helpers do not cover |

**Prefer `closest()` over `target`.** A component may render transparently, so the innermost hit is
often an implementation detail — clicking a tool block yields a chain like
`Container > Container > ToolExecutionComponent > Box`, and `target` is the `Box`.

Each `Hit` in `chain` carries `{ component, name, start, height, depth }`.

### Claiming

Return `true` to claim the click and stop dispatch. Return `false` or nothing to pass it on.
Handlers run in registration order, so if you register several, the most specific one should claim.

Registering the same key twice **replaces** the previous handler rather than stacking a duplicate,
which is what makes re-registering on session reload safe.

```ts
const off = onViewportClick("my-extension", handler);
off();                                  // or offViewportClick("my-extension")
```

## What counts as a click

Only a **left-button release** with no drag. Deliberately ignored, and passed through untouched:

- button presses (the release is what fires)
- wheel events and mouse motion
- text-selection drags, and releases whose press landed on a different row
- clicks that activate an OSC 8 link
- clicks outside the transcript viewport (editor, status bar, footer)

This mirrors Pi's own rule for distinguishing a click from a drag. The original handler is always
called afterwards, so scrolling, selection and links keep working exactly as before.

## Cost

The row-to-component map is rebuilt on each click and nothing is retained between clicks. Measured on
a transcript of real tool blocks:

| Transcript | Lines | Blocks | Per click |
|---|---|---|---|
| Typical | 312 | 20 | ~1.3 ms |
| Long | 1,551 | 100 | ~5.6 ms |
| Very long | 4,650 | 300 | ~17 ms |

Idle cost is zero — nothing runs on scroll, keystrokes or renders — and one walk serves every
subscriber. Pi's own render cache means re-measuring an unchanged component is a cache hit.

## How the mapping works

The document is walked in render order, recording each component's content-row range. Two rules make
it correct, both learned by getting them wrong first:

1. **A component's height is its own `render(width).length`, never the sum of its children's.**
   `Box` adds `paddingY` rows *and* renders children at `width - 2 * paddingX`, so walking through one
   undercounts twice over. That error accumulates and shifts every component below it — which makes
   clicks land on the *following* block. The walk therefore descends only into components that are a
   faithful concatenation, tested directly: children's heights must sum to the parent's own height.

2. **Placement is checked by height, not by bytes.** A parent may decorate its children's lines
   without changing their count — `UserMessageComponent` adds OSC 133 shell-integration markers to its
   first and last line — so a child's own render can differ from the painted bytes while occupying
   exactly the right rows.

Before dispatching, the walked document height is compared against the layout's own
`scrollContentLines`. If they disagree, some component measured wrongly and every offset after it is
suspect, so the click is **not** dispatched — doing nothing beats resolving to the wrong component.

## Stability

This package patches `TuiAltScreen.handleViewportInput`, which is not a public Pi API. That patch is
confined to a single file (`src/patch.ts`) on purpose: a Pi release that renames or restructures that
method breaks this package alone, not every consumer built on it.

Only one extension may patch that method. A marker prevents a second copy of this package from
stacking another wrapper, which would make every click fire twice.

## Debugging

Set `PI_VIEWPORT_MOUSE_DEBUG=1` (or `PI_DEBUG=1`) to append diagnostics to
`/tmp/pi-viewport-mouse.log`. It stays empty in normal operation; a `height mismatch` line means a
component type is being measured wrongly and is worth reporting.

## Requirements

Node 20 or newer, and a Pi version that provides `@earendil-works/pi-tui`. Mouse capture only exists
in Pi's fullscreen alternate-screen TUI, so clicks do nothing in the inline TUI.

## License

MIT
