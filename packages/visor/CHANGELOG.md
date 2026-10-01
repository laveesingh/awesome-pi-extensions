# Changelog

All notable changes to `pi-visor` are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Own every tool by default, including unknown names. Replace the inclusion list with an empty,
  source-level `EXCLUDED` set; exclusions preserve native rendering and take precedence over
  passthrough. No user-facing configuration is added.
- Add argument summaries for `powershell`, `codemode`, `TaskCreate`, `TaskUpdate`, `TaskList`,
  `google_search`, and `web_enable`.
- Target Pi 0.99.1. Keep native edit diffs and write content on expansion, hide native call
  previews while collapsed, and avoid double-framing edit's self-shell renderer.
- Preserve native renderer component identities through repeated expansion and invalidation.
- Preserve every text result block, including codemode output after its status header.
- Require real-component rendering checks to fail if Pi is unavailable instead of skipping.

## [0.1.0] — 2026-08-28

Initial release. Previously a personal single-file extension named `compact-summary`.

- **Turn bar** — `● Working / Worked` with live duration and `↑ in / ⚡ cached / ↓ out` tokens.
- **Thinking** — one `● Thought (dur • ↓ tokens)` line per thinking run, expandable to the full
  reasoning by click or `ctrl+o`.
- **Tool blocks** — call line plus `↳ N lines • hh:mm:ss • duration (ctrl+o)`, with no output
  preview. Two lines per block.
- **Passthrough tools** — `read`, `edit`, `write`, `ls`, `find` keep Pi's own call line and expanded
  body, so edit and write diffs survive; only the collapsed state and footer are replaced.
- **Structured results** — JSON payloads collapse to a one-line summary read from `details.result`
  rather than re-parsed from text, since some tools truncate their text and emit invalid JSON.
- Tools the extension does not own render exactly as Pi renders them.
- Patches reach Pi through a static ESM import, which resolves to the live module instance; the
  `createRequire` route silently produces a second copy whose prototypes are never called.
- The tool patch sits on `ToolExecutionComponent` rather than the tool registry, so it survives the
  registry rebuild Pi performs on every refresh and has no registration race.
- Click hitboxes are per block: a thought line covers only its own rows, never the assistant's
  reply below it.
- Durations freeze when a result settles, so expanding an old block does not inflate its timing.
