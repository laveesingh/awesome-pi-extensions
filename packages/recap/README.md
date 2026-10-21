# pi-recap

An ephemeral last-run recap for the [Pi coding agent](https://pi.dev) TUI: after each settled run, a configurable chat model summarizes the turn in up to 3 bullets, shown in a widget under the editor — and **never added to context**.

```
● Recap · acme/mini · 2s · $0.0003 (today $0.0012)
  • Ran vitest on auth, fixed the mutex race
  • Edited src/auth.ts, all tests green
  • Shipped with no remaining errors
```

## Install

```bash
pi install npm:pi-recap
```

## Commands

| Command | What it does |
|---|---|
| `/recap` | Recap the last run now (even with auto-recap off) |
| `/recap hide` | Dismiss the widget |
| `/recap model` | Pick the recap model from your Pi chat-model list |
| `/recap model clear` | Back to the automatic cheapest fast model |
| `/recap auto on\|off` | Toggle recapping after every run (default on) |
| `/recap status` | Model, auto flag, and today's recap spend |

## How it stays light — and out of context

- **Own model runtime.** The recap call runs on a separate `ModelRuntime` that reuses Pi's providers and stored credentials but shares nothing with the session: no entries, no context builders, no queued messages. A recap provably cannot leak into the conversation it summarizes.
- **Lossy digest.** The model sees the user prompt, tool *names* with argument snippets, and the final reply — never tool outputs or thinking. Prompts stay ~2–4 KB; replies are capped at ~150 tokens with thinking off.
- **Ephemeral display.** Recap text lives only in a transient widget (≤6 lines), replaced each run. Configuration (model choice, auto flag, spend tally) lives in `recap.json` in the agent dir — not in session state.
- **No storms.** One flight at a time; a new turn aborts the previous call, stale results are dropped by turn id, and identical failures don't retry. Auto-recap skips turns with no tool calls and short replies.

## Honest accounting

Recap calls bypass Pi's session cost tracking (that's the point — they're invisible to the conversation), so every recap shows its own `$` cost and today's running total. Model calls need working credentials for the chosen model; on failure the widget says so and suggests `/recap model`.

## Requirements

Pi 1.3.0 or newer (uses `agent_settled`, widget placement, and the model runtime). No TUI widgets in print/RPC mode — recaps stay silent there.
