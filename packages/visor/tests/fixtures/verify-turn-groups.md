# Offline run-group verification setup

This setup is for the independent explorer/designer gates. It does not assert design fidelity.
Requires Pi **0.99.1**, Python/tmux only if automating input, and a terminal that supports fullscreen
mouse. All state lives in a new temporary directory. No credentials or live web/tracker work.

## Launch

Run from the repository root:

```sh
REPO="$PWD"
ROOT="$(mktemp -d /tmp/visor-verify.XXXXXX)"
mkdir -p "$ROOT/agent"
printf '%s\n' '{"quietStartup":true}' > "$ROOT/agent/settings.json"
cd "$ROOT"
PI_CODING_AGENT_DIR="$ROOT/agent" VISOR_VERIFY_ROOT="$ROOT" PI_TELEMETRY=0 \
  pi --offline --tui-mode fullscreen --no-extensions --no-skills \
  --no-prompt-templates --no-themes --no-context-files --no-approve \
  --session-dir "$ROOT/sessions" --provider visor-verify --model offline --thinking off \
  -e "$REPO/packages/visor/index.ts" \
  -e "$REPO/packages/visor/tests/fixtures/verify-turn-groups.js" \
  -e builtin:codemode --tools bash,read,edit,codemode,google_search
```

For the combined-package route, add `-e "$REPO/packages/viewport-mouse/index.ts"` to the same
launch. For regular mode use `--tui-mode regular`. For resume retain ROOT and add `--continue`.
The fixture preserves files modified by native edit rather than overwriting them on resume.

## Inputs and required captures

| Input | Fixture / capture actions |
|---|---|
| `multi` + Enter | Real bash/read/edit/codemode, sandbox web; 8 tools + 3 visible notes. Untouched settlement gives A. Click header for B; click edit child for native diff C. Final response stays outside. |
| `long` + Enter | Same run, final bash emits 140 lines. Open parent and last tool to capture D. Wheel must use the single transcript; no inner scroll. |
| `live` + Enter | First bash waits 12s. Capture Working/open frame while pending. During that interval inspect/close a child or frame; settlement must preserve its exact state. |
| `error` + Enter | One real sandbox bash exits 1, followed by a successful final check. Capture visible error count/child error and preserved open state; manually close it to verify no reopen. |
| `none` + Enter | Direct native final response, no new frame. |
| `thought` + Enter | Thinking-only tool-use member: 0 notes, managed thought row. Click it to open reasoning. Ctrl+O uses thinking meaning for this row, not empty Commentary. |
| `live`, then Esc while first tool waits | Abort the actual bash operation. Capture Interrupted/stopped count; not an invented error. Earlier frames remain accurately labeled. |
| `/vqueue` + Enter | Begins `live`, then queues actual steering (`steered multi`) and follow-up (`follow-up multi`) during the first tool batch. Capture separate user-boundary frames and final native response. |
| Ctrl+O, Ctrl+O | Open both layers then close both; late tools/notes inherit the global state. Header-only clicks retain child state. |
| Quit; exact same launch + `--continue` | Capture collapsed rebuild with numbering/timestamps derived from recorded message data. Unknown commentary streaming duration is omitted. |

Repeat A/B/C at **80 columns**. Capture regular A and B through Ctrl+O (no mouse route there).
Test visor alone and combined package, including thought-only and width-sensitive child rows.

`$ROOT/verification-events.jsonl` records lifecycle/tool completion markers for repeatable
instrumentation. `google_search` is explicitly a sandbox renderer fixture, NOT production web
integration. The other named tools execute actual Pi implementations. All output/diffs are fixture
material, never repository test claims. Use `/quit` and stop any terminal/tmux process you spawned.
