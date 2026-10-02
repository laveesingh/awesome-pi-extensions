# pi-visor

A heads-up layer for the [Pi coding agent](https://pi.dev) transcript.

Each run with tools has one bounded frame. Open the frame to see compact commentary and tool
blocks, then open any child for its full text or native diff. The final answer stays visible below
it, as Pi renders it.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ▸ ● Run 1 · Worked                                                   │
│   8 tools • 3 notes • 27s • 0 errors • 10:04:12 (ctrl+o)             │
└──────────────────────────────────────────────────────────────────────┘

The final response remains outside the frame.
```

## What it does

| Surface | What you get |
|---|---|
| Run frame | Header and counts; one layer opens to compact children, a second opens each child |
| Commentary | Header + line-count footer; expansion shows muted wrapped text and the managed thought line if present |
| Tools | Two-line call/footer; expansion keeps the footer, repeats the call, then shows the full body or native diff |
| Thinking | Managed thought summaries with their own expansion controls |
| Turn bar | Live `Working / Worked` duration and input/cache/output token counts |
| Final answer | Native Pi rendering, never hidden in the run frame |

There is one transcript scroll, never an inner scroll region. Frames number from 1 in the current
chat. A run without tools creates no frame.

### Membership and boundaries

- A user prompt closes the current frame. Steering and follow-up prompts therefore have separate
  frames even when Pi handles them in one agent cycle.
- Only visible assistant text counts as a commentary note. Tool-only assistant messages add no
  empty commentary block. Thinking-only messages show the existing managed thought line without
  a note count.
- Top-level tools count; nested codemode calls do not create extra transcript children. Status,
  custom and other auxiliary rows keep their order without adding tools or notes.
- The provisional streaming answer stays below the frame. It moves inside only when it is known
  to precede tool use. The final text answer remains outside and native.

### Expansion

In **fullscreen mode**, click:

- The header, metadata, declared separators and group-end/border rows to toggle only the parent layer. Child states are kept. Inter-child gaps and child-region side columns do nothing.
- A tool or commentary child to toggle only that child.
- A managed thought line to toggle only its reasoning, including a thinking-only member.

**Ctrl+O** opens both layers; the next press closes both. Later arriving children inherit that
global choice. Commentary expansion is separate from thinking expansion. For a thinking-only
member, Ctrl+O keeps Pi's existing reasoning-expansion meaning.

Pi 0.99 routes these clicks natively: `pi-viewport-mouse` is **not required**. Both packages can
still be loaded together; visor defers grouped clicks from the legacy event route so native
routing performs one toggle. Regular mode has no transcript mouse route; Ctrl+O still works.

### Live runs and settlement

A live frame starts open with compact children. At final `agent_settled`, each untouched successful
frame collapses once. A user-touched, errored or interrupted frame keeps its exact state, including
manual closure. A later abort marks only the frame open at that abort; earlier frames are not
falsely labeled Interrupted. Aborted pending tools count as stopped, not errors.

### Rebuilds and timing

Resume, compaction and tree navigation rebuild collapsed frames and children. Expansion state is
not persisted. Live timing uses execution/streaming clocks. Rebuilt tool/run timing comes from
recorded message timestamps: a rebuilt tool shows its tool-result timestamp, but its execution
duration is always omitted, even for a single call. Real tool start/end is not persisted, and a
parallel batch's completion time must not become every tool's duration. Run timing remains the
first-to-last message span. Unavailable values/separators are omitted; commentary streaming duration
is omitted after rebuild unless it was recorded.

### Tool coverage

Every tool is owned by default, including unknown extension and MCP names:

- **Generic** tools use a uniform call/footer and retain all text result blocks, including
  codemode output after its status header.
- **Passthrough** `read`, `edit`, `write`, `ls`, `find` retain native headers and expanded bodies.
  Edit diffs and write content survive repeated expansion.
- The source-level **`EXCLUDED`** set is empty. An explicit exclusion preserves native rendering,
  shell and fallback behavior, and takes precedence over passthrough. There is no user-facing
  exclusion setting; additions require a documented reason.

Flat tool rendering remains available when grouping cannot install. Flat structured JSON results
keep visor's compact identity/count summaries instead of raw JSON previews. Grouped footers use
line counts and wholly muted metadata, with pending/error forms matching the frame grammar.

## Install

```sh
pi install npm:pi-visor
pi --tui-mode fullscreen   # for native clicks; Ctrl+O also works in regular mode
```

> Pi packages execute arbitrary code with full system access. Read the source before installing.

## Requirements

- Node **22.19.0 or newer**.
- Pi **0.99.1**. This package patches private Pi seams; updates can break compatibility.
- Fullscreen TUI mode for transcript clicks. No extra mouse extension is required.

## Stability

| File | Compatibility seam |
|---|---|
| `src/run-integration.ts` | Live InteractiveMode UI binding, transcript membership/rebuild, direct-child consumers |
| `src/run-group.ts` | Four-column bounded frame and native coordinate routing |
| `src/run-child.ts` | Per-instance commentary state and contextual native tool shell |
| `src/tool-display.ts` | ToolExecutionComponent call/result/shell resolution |
| `src/thinking.ts` | AssistantMessageComponent thinking rendering |

Static imports resolve to Pi's live module instance through its extension loader. Grouping uses the
actual captured chat container, not a guessed container found by tree shape. Compatibility failures
leave the transcript flat and notify once. Reload/shutdown restore instance hooks rather than
stacking wrappers. Settled child output is cached by width, revision and current theme.

## Development and verification

```sh
cd packages/visor
npm run check
```

The test suite includes independent 80/120-column golden strings, real native component rendering,
recorded Pi handler-order replay and isolated native/combined mouse regressions. Critical integration
checks fail rather than silently skip on incompatible Pi internals.

Offline independent capture setup: [`tests/fixtures/verify-turn-groups.md`](tests/fixtures/verify-turn-groups.md).
Native operation recorder: [`tests/fixtures/native-order/README.md`](tests/fixtures/native-order/README.md).
Sandbox web/Task fixtures are renderer evidence, not production integrations or real test claims.

## Debugging

Set `PI_DEBUG=1` for existing visor diagnostics in `/tmp/pi-visor.log`. If grouping cannot install,
its warning identifies the compatibility seam and the transcript remains flat.

## License

MIT
