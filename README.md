# awesome-pi-extensions

Extensions for the [Pi coding agent](https://pi.dev). Each package under `packages/` is developed here
and **published to npm on its own** — this repository is the workspace, not the unit of installation.

## Packages

| Package | What it does |
|---|---|
| [`pi-visor`](packages/visor) | A heads-up layer for the transcript: live turn bar, one-line thinking summaries, and two-line tool blocks that expand on click or `ctrl+o`. Uses Pi's native fullscreen clicks; no mouse extension is required. |
| [`pi-recap`](packages/recap) | Ephemeral last-run recaps: a configurable chat model summarizes each settled run as a Claude Code-style status line, never added to context. Requires Pi 1.3.0. |

`pi-viewport-mouse` was deprecated and removed from this repository (last version 0.1.1 on npm).
Regular mode remains keyboard-only.

## Install

Install a single package from npm:

```bash
pi install npm:pi-visor
```

You can also install every extension in this repository at once from git, which is useful for trying
changes before they are published:

```bash
pi install git:github.com/laveesingh/awesome-pi-extensions
```

Pick one route or the other for a given extension. Installing a package from npm *and* the whole
repository from git would load it twice.

> Pi packages run with full system access. Extensions execute arbitrary code. Read the source before
> installing anything, including this.

## Development

Requires Node 22.19.0 or newer, matching Pi 1.3.0.

```bash
npm install          # installs all workspaces
npm test             # runs every package's tests
npm run typecheck    # type-checks every package
npm run check        # both
```

To work on one package:

```bash
cd packages/visor
npm test
```

To try a working copy in Pi without installing it:

```bash
pi -e ./packages/visor
```

Extensions ship as TypeScript source — Pi loads `.ts` directly, so there is no build step. Follow the
TypeScript `NodeNext` convention in imports: write `./thing.js` even though the file is `./thing.ts`.

## Adding a package

1. Create `packages/<name>/` with `index.ts` exporting a default extension factory.
2. Give it a `package.json` with a `pi.extensions` entry pointing at `./index.ts`, the `pi-package`
   keyword, `peerDependencies` of `"*"` on `@earendil-works/pi-coding-agent` and
   `@earendil-works/pi-tui`, and `files` listing what to publish.
3. Add a `README.md`, `CHANGELOG.md` and `LICENSE`.
4. Add tests under `tests/`. Keep tests that do not need Pi separate from integration checks.
   Each package may require critical Pi integration checks to fail when Pi internals are unavailable
   or incompatible, rather than skip and hide a compatibility break.
5. Add a row to the table above.

## Publishing

Each package is published independently:

```bash
cd packages/<name>
npm run check
npm publish          # publishConfig.access is already set to public
```

Then tag the repository:

```bash
git tag <name>-v<version> && git push --tags
```

## License

MIT — see [LICENSE](LICENSE).
