# Security policy

## Supported versions

Only the latest published version of each package receives fixes.

| Package | Supported |
|---|---|
| `pi-visor` | latest (0.2.x) |
| `pi-viewport-mouse` | latest (0.1.x) |

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/laveesingh/awesome-pi-extensions/security/advisories/new)
for this repository. Include the package, version, Pi version, and steps to reproduce.

You can expect an acknowledgement within 7 days. A fix or mitigation is released as a new patch
version, and the advisory is published after the release.

## Scope

These extensions run inside the Pi coding agent with the same permissions as Pi itself. They patch
Pi's TUI components to change how the transcript renders. They do not read credentials or make
network requests. The only shell command at runtime is `which pi` in `pi-visor`, used to locate
Pi's installed modules. Files under `packages/*/tests/fixtures/` are
offline test fixtures; their placeholder provider keys are not secrets.
