# Changelog

All notable changes to `pi-viewport-mouse` are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-08-27

Initial release.

- Resolves alt-screen mouse clicks to the transcript components under them and publishes them as
  events through a `globalThis` registry, since Pi has no extension-to-extension event bus.
- `pi-viewport-mouse/client` exports `onViewportClick`, `offViewportClick` and `getViewportMouse` with
  no Pi imports, so consumers can depend on it cheaply. The registry is created lazily by whichever
  side loads first, so extension load order does not matter.
- Events carry the full ancestor chain, plus `closest()` and `rowWithin()` helpers. Returning `true`
  from a handler claims the click and stops dispatch.
- Only left-button releases dispatch. Presses, wheel events, motion, selection drags, OSC 8 link
  clicks and clicks outside the transcript are passed through untouched, and the original handler is
  always called so scrolling and selection are unaffected.
- Handlers are keyed, so re-registering after a session reload replaces rather than stacks.
- A patch marker prevents a second copy of the package from making every click fire twice.
