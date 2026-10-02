# Real Pi native operation recording

These JSONL fixtures are recordings, not authored replay sequences. Pi 0.99.1 ran in its real
fullscreen CLI with an isolated offline provider, agent directory, session storage and temporary
working directory. Visor was **not** loaded while recording native order. No terminal, ANSI or
screenshot acceptance capture was collected.

## Reproduce

From the repository root, with Pi 0.99.1, Python 3 and tmux available:

```sh
python3 packages/visor/tests/fixtures/capture-native-order.py "$PWD"
```

The producer creates new temporary roots and prints their paths. It writes the exact safe CLI
launch to each root's `launch.txt`, and the combined receipt to `/tmp/awe9-record-result.json`.
It uses `record-pi-order.js`, an offline deterministic provider and `fixture_hold` sandbox tool.
The real agent queues steering/follow-up messages through Pi's API. Ctrl+O, Esc and `/compact`
are submitted to the real terminal. The compaction summary is overridden by the fixture extension;
Pi still prepares, persists and rebuilds the real compaction. No tracker, web or credential fixture
uses live state. The producer stops its own tmux server.

## Committed evidence

- `natural.jsonl`: 476 recorded metadata/events/native component/container calls. Covers steering,
  follow-up, live Ctrl+O and duplicate status handling, custom-entry splice, no-tools final,
  natural Esc mid-text, provider error midstream, Esc during tool-call streaming, and compaction.
- `seeded-cleanup.jsonl`: 56 records from a separate Pi process. **None of the three natural
  paths reached `agent_end`'s `removeChild` guard.** Only after all three probes finished and the
  natural process exited did the producer finalize its checksum manifest and enable the approved
  fallback branch setup.
- The marked empty streaming component is logged as `op: fixture_setup`, `source: FIXTURE SETUP`.
  The real `agent_end` event was already in progress; Pi's original handler then executed
  `removeChild`, logged separately as `source: native`. No event/operation sequence was authored.
- `natural-paths.json`: the three zero cleanup counts and original trace checksum.
- `natural-provenance.json` / `seeded-provenance.json`: actual bundled CLI identity and checksum,
  native handler/reference-source fingerprints, Node/Pi versions, recorder source/hash and
  grouping-disabled status. `inputs.json` records the natural run's input controls.

`run-integration.test.ts` replays these captured calls into an ordinary fake Container containing
real Pi components. It asserts the exact native logical leaf order at every event checkpoint,
then verifies grouping, boundaries, final placement, timestamps, resets and fail-safe behavior.
Nested `Array.splice` inside native `Container.removeChild` is consumed without deleting twice.
The separate group-aware removal regression exercises cleanup of a streaming member inside a frame.

Failed diagnostic roots were not copied into these fixtures. The first startup assumed argv[1]
was directly under `dist`; actual Pi used `dist/bundle/cli.js`. A later seed startup correctly
rejected a checksum finalized before late native invalidation. The successful producer finalizes
its natural trace only after the native process has exited.
