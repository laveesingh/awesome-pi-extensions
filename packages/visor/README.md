# pi-visor

A heads-up layer for the [Pi coding agent](https://pi.dev) TUI.

Pi's transcript grows fast: every tool call prints its whole output, every thinking run prints its
whole reasoning, and a long session becomes a wall you have to scroll past. `pi-visor` collapses all
of that to two lines per block and puts the detail one click away.

```
● Worked (9s • ↑ 66K • ⚡ 0 • ↓ 335)          ← turn bar: live tokens, duration

● Thought (2s • ↓ 120) (ctrl+o)               ← one line per thinking run

bash echo hello && ls -la | head -5
↳ 6 lines • 11:51:31 • 136ms (ctrl+o)         ← two lines per tool call

ticket_get GOL-264
↳ GOL-264 · "Compact tool output" · done · spec • 11:51:34 • 179ms (ctrl+o)
```

Click a block — or press `ctrl+o` — to expand it. Timing is shown only for live executions.
Restored transcript blocks omit unavailable timestamps and durations in both views.

## What it does

Four surfaces, one extension. They share a footer grammar and an expand/collapse contract, and that
is the whole scope: **`pi-visor` changes how a session reads, never how the agent behaves.**

| Surface | What you get |
|---|---|
| **Turn bar** | `● Working / Worked` with live duration and `↑ in / ⚡ cached / ↓ out` token counts |
| **Thinking** | One `● Thought (dur • ↓ tokens)` line per thinking run, expandable to the full reasoning |
| **Tool blocks** | Call line + `↳ N lines • hh:mm:ss • duration (ctrl+o)`. No output preview |
| **Expansion** | Per-block via click, or all at once with `ctrl+o` |

### Tool coverage

Every tool is owned by default, including new built-ins, extension tools and MCP tools:

- **Generic** — all tools other than the passthrough set get a uniform call line and footer.
  This includes `powershell`, `codemode`, Task tools, and web tools.
- **Passthrough** — `read`, `edit`, `write`, `ls`, `find` keep Pi's native call header and expanded
  body. Native edit diffs and write content remain available on expansion, with no preview in
  the two-line collapsed form.

The source-level `EXCLUDED` set is empty. An explicitly excluded tool keeps Pi's native rendering,
shell, and fallback behavior; exclusion takes precedence over passthrough. There is no user-facing
exclusion setting. Additions to this set require a documented reason.

### Structured results

Tools returning JSON get a summary instead of a line count, so a tracker call reads
`↳ 151 items · GOL-93, GOL-98, … ` rather than three lines of `{`. The object is read from
`details.result` where present rather than re-parsed from text, because some tools truncate their
text output and hand you invalid JSON.

## Install

```bash
pi install npm:pi-visor
```

For click-to-expand you also need mouse events, which means both of these:

```bash
pi install npm:pi-viewport-mouse   # routes clicks to components
pi --tui-mode fullscreen           # Pi only captures mouse in fullscreen
```

Neither is required. Without them `ctrl+o` still expands everything, and nothing else changes —
`pi-visor` degrades to a keyboard-only tool rather than breaking.

> Pi packages run with full system access. Extensions execute arbitrary code. Read the source before
> installing anything, including this.

## Requirements

- **Node 22.19.0 or newer**, as required by Pi 0.99.1.
- **Pi 0.99.1.** This patches Pi internals (see Stability), so a Pi update can break it.
- **For clicks only:** `pi-viewport-mouse` and Pi's fullscreen TUI, which is *not* Pi's default.

## Expansion

Both routes drive the same state, so they stay in sync:

- **Click** a tool block or a thought line to toggle just that one.
- **`ctrl+o`** toggles everything at once (Pi's own `app.tools.expand` binding).

Clicking an assistant message that has no thinking does nothing and does not consume the click —
other extensions still see it.

## Stability

This package patches two Pi internals, each isolated to one file:

| File | Patches | Breaks if |
|---|---|---|
| `src/tool-display.ts` | `ToolExecutionComponent` renderer resolution | Pi renames those methods |
| `src/thinking.ts` | `AssistantMessageComponent.updateContent` | Pi restructures thinking rendering |

Both reach Pi through a **static ESM import** of `@earendil-works/pi-coding-agent`. That matters:
Pi loads extensions through jiti with an alias to the running `dist`, so a static import resolves to
the very module instance the live agent is using. `createRequire` does not — Pi is pure ESM, so its
modules never enter the CJS cache, and requiring the file by path mints a second, unrelated copy
whose prototypes nothing ever calls.

The tool-block patch deliberately sits on the **component**, not the tool registry. Pi rebuilds its
registry maps on every refresh, so anything captured there goes stale; the component asks for its
renderers on every render, so there is nothing to miss and no registration race.

On Pi 0.99, native renderers come from the component's `toolDefinition`. Visor uses the default
outer shell for owned blocks and removes edit's native self-shell padding to avoid a second frame.
Native component identities survive wrapping, so repeated expansion preserves previews and diffs.

## Debugging

Set `PI_DEBUG=1` to append diagnostics to `/tmp/pi-visor.log`.

If tool blocks render Pi-native, the patch did not install and the extension says so out loud rather
than failing silently.

## License

MIT
