# pi-recap

An ephemeral last-run recap for the [Pi coding agent](https://pi.dev) TUI: after each settled run, a configurable chat model summarizes the turn, shown as a Claude Code-style status line in the transcript — and **never added to context**.

```
⎿ Recap · Ran vitest on auth, fixed the mutex race • Edited src/auth.ts, all green • Shipped · gpt-6-luna · 2s · $0.0003
```

The line renders through Pi's own status path — the same dim transcript-tail row as
"Reloaded keybindings…" — so there is no widget to manage or dismiss. Like Pi's
own status texts it persists in scrollback but never becomes a session entry.

## Install

```bash
pi install npm:pi-recap
```

## Commands

| Command | What it does |
|---|---|
| `/recap` | Recap the last run now (even with auto-recap off) |
| `/recap model` | Pick the recap model from your Pi chat-model list (provider first) |
| `/recap model clear` | Back to automatic: your session model, else the cheapest fast model |
| `/recap auto on\|off` | Toggle recapping after every run (default on) |
| `/recap disable` / `/recap enable` | Master switch: nothing runs while disabled, not even manual `/recap`. File-backed, so restarts and reloads honor it |
| `/recap doctor` | Check every provider (penny-sized probes, skipped without credentials), save what each needs, and show the report |
| `/recap status` | Model, auto flag, and today's recap spend |

## How it stays light — and out of context

- **Same credentials as the session.** The recap call goes through the session's own model registry first — live tokens, session auth state, scoped routing — with a private `ModelRuntime` (same providers, same stored credentials) covering whatever it cannot. Gateway-required session headers (`x-opencode-session` for the opencode family) ride along on both paths, mirroring Pi's own attribution. Either way nothing touches the session: no entries, no context builders, no queued messages. A recap provably cannot leak into the conversation it summarizes.
- **Model resolution.** Explicit choice first (failures surface, never substitute), then your session's current model, then credentialed cheap models, then catalog cheap — one model's entitlement quirks can't sink the recap, and the line always names the model that answered. Reasoning models retry once at explicit `low` when `off` is rejected outright or silently eats the token budget thinking.
- **Provider profiles.** Per-provider setup lives in one table: your `providers` in `recap.json` first, curated live-proven defaults (`codex-proxy/*` and `rakuten-ai/*` need `low`) second, behavioral discovery as safety net. `/recap doctor` audits every provider and seeds the table — credential-less providers cost nothing to check.
- **Lossy digest.** The model sees the user prompt, tool *names* with argument snippets, and the final reply — never tool outputs or thinking. Prompts stay ~2–4 KB; replies are capped at ~150 tokens with thinking off.
- **Ephemeral display.** Recap text is a plain transcript row published with `notify(info)`, exactly like Pi's own status texts: visible in scrollback, never a session entry, wiped on rebuild. Configuration (model choice, auto flag, spend tally) lives in `recap.json` in the agent dir — not in session state.
- **No storms, no coupling.** One flight at a time. Auto-recaps wait a few seconds after settle and quit silently if you started typing or a new turn began — most back-to-back turns never spend a call. Any user activity (`turn_start`) aborts an in-flight call immediately, stale results are dropped by turn id, calls time out at 25 s, and auto-recap skips turns with no tool calls and short replies. Three straight failures stand auto-recap down with a clear message (manual `/recap` keeps working; `/recap auto on` re-arms) — a struggling provider degrades recap instead of nagging forever.

## Honest accounting

Recap calls bypass Pi's session cost tracking (that's the point — they're invisible to the conversation), so every recap shows its own `$` cost and today's running total. Model calls need working credentials for the chosen model; on failure the widget says so and suggests `/recap model`.

## Requirements

Pi 1.3.0 or newer (uses `agent_settled`, widget placement, and the model runtime). No TUI widgets in print/RPC mode — recaps stay silent there.
