import assert from "node:assert/strict";
import { before, test } from "node:test";
import * as Pi from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, TuiAltScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ThinkingManager, type ThoughtLine } from "../src/thinking.js";
import { RunGroup } from "../src/run-group.js";
import { patchToolExecutionComponent } from "../src/tool-display.js";
import { getRegistry } from "../../viewport-mouse/src/registry.js";
import { installMousePatch, uninstallMousePatch } from "../../viewport-mouse/src/patch.js";
import { ClickToExpand } from "./fixtures/baseline-click-to-expand.js";
import visorExtension from "../index.js";
import viewportMouseExtension from "../../viewport-mouse/index.js";
// @ts-expect-error Plain-JS profiling fixtures deliberately have no declaration package.
import { mockTerminal } from "../../../scripts/profiling/fixture.js";
// @ts-expect-error Read-only geometry helper observes real render caches, never rerenders.
import { cachedChildren, firstMouseRegion, visiblePoint } from "../../../scripts/profiling/geometry.js";

const tm = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
Pi.initTheme("dark");
const manager = new ThinkingManager();
before(() => { assert.ok(manager.installPatch()); assert.ok(patchToolExecutionComponent()); });
const ui = { requestRender() {} } as never;
const message = (text: string, thought = true) => ({ role: "assistant", content: [
  ...(thought ? [{ type: "thinking", thinking: "synthetic reasoning first\nsynthetic reasoning last" }] : []),
  { type: "text", text }], timestamp: 1700000000000, stopReason: "toolUse", api: "fixture", provider: "fixture", model: "fixture",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
function assistant() {
  const owner: any = new Pi.AssistantMessageComponent(message("ordinary final prose outside thinking"));
  return { owner, line: () => owner.contentContainer.children.find((c: any) => c.__visorThoughtLine) as ThoughtLine };
}
function tool() {
  const c = new Pi.ToolExecutionComponent("bash", "mouse-fixture", { command: "synthetic not executed" }, {}, undefined, ui, process.cwd());
  c.setArgsComplete(); c.updateResult({ content: [{ type: "text", text: "synthetic result one\nsynthetic result two" }], isError: false });
  return c;
}
function screenFixture(component: Container) {
  const scroll = new ScrollView(component, { primary: true, scrollbar: "hidden" });
  const native = new TuiAltScreen(mockTerminal(120, () => {}));
  const screen = native as any; // reflect actual same-version host private seams; no stub dispatch
  screen.requestRender = () => {};
  native.setLayoutRoot(scroll); screen.altScreenActive = true; screen.stopped = false;
  const paint = () => screen.doRender();
  const bounds = (target: object): any => {
    const seen = new Set();
    const visit = (box: any): any => {
      if (!box || seen.has(box.component)) return;
      seen.add(box.component);
      if (box.component === target) return box;
      for (const child of cachedChildren(box)) { const found = visit(child); if (found) return found; }
    };
    return visit(screen.currentLayout?.root);
  };
  const gesture = (point: { x: number; y: number }, button = 0) => {
    screen.lastClick = undefined; screen.lastComponentClick = undefined; // separate deliberate gestures, not double/triple selection
    screen.handleViewportInput(`\x1b[<${button};${point.x + 1};${point.y + 1}M`);
    screen.handleViewportInput(`\x1b[<${button};${point.x + 1};${point.y + 1}m`);
    paint();
  };
  paint();
  return { screen, scroll, paint, bounds, gesture, close: () => native.stop({ preserveScreen: true }) };
}
function point(box: any, row = 0): { x: number; y: number } {
  assert.ok(box, "actual rendered target must exist");
  const result = visiblePoint(box, row, 2);
  assert.ok(result, "actual target must be visible and clipped");
  return result;
}

test("standalone native thought press/release uses only the owner flag; reasoning rows and prose stay distinct", () => {
  const a = assistant(), doc = new Container(); doc.addChild(a.owner);
  const f = screenFixture(doc);
  let invalidates = 0; const invalidate = a.owner.invalidate.bind(a.owner);
  a.owner.invalidate = () => { invalidates++; invalidate(); };
  try {
    f.gesture(point(f.bounds(a.line())));
    assert.equal(a.owner.expanded, true); assert.equal(invalidates, 1);
    const expanded = f.bounds(a.line()); assert.ok(expanded.rect.height > 1);
    f.gesture(point(expanded, expanded.rect.height - 1));
    assert.equal(a.owner.expanded, false); assert.equal(invalidates, 2);
    const own = f.bounds(a.owner), thought = f.bounds(a.line());
    f.gesture(point(own, thought.rect.y - own.rect.y + thought.rect.height + 1));
    assert.equal(a.owner.expanded, false); assert.equal(invalidates, 2, "ordinary/final prose must not toggle thought");
    a.owner.setExpanded(true); f.paint(); assert.equal(a.line().expanded, true, "Ctrl+O owner path shares the same state");
  } finally { f.close(); }
});

test("normalized native thought handler ignores bounds, press/release, non-primary, wheel and motion", () => {
  const owner: any = { __visorThinking: "synthetic reasoning", invalidate() { this.calls = (this.calls ?? 0) + 1; } };
  const line = manager.makeThoughtLine(owner, { durMs: 0, tokens: 1 }, 1);
  const event: TuiMouseEvent = { type: "click", button: "left", x: 2, y: 0, width: 120, height: 1,
    screenX: 2, screenY: 0, shift: false, alt: false, ctrl: false };
  for (const change of [{ x: -1 }, { x: 120 }, { y: -1 }, { y: 1 }, { x: NaN },
    { type: "press" }, { type: "release" }, { type: "move" }, { type: "drag" }, { type: "wheel" }, { button: "right" }, { button: "middle" }] as const) {
    assert.equal(line.handleMouse({ ...event, ...change }), undefined);
    assert.equal(line.expanded, false); assert.equal(owner.calls, undefined);
  }
  assert.deepEqual(line.handleMouse(event), { handled: true, render: true });
  assert.equal(line.expanded, true); assert.equal(owner.__visorThinkExpanded, true); assert.equal(owner.calls, 1);
});

for (const combined of [false, true]) {
  test(`actual native grouped thought/commentary press-release keeps independent states (${combined ? "viewport passive client" : "visor only"})`, () => {
    if (combined) installMousePatch(); else uninstallMousePatch();
    const unsubscribe = combined ? getRegistry().on("native-mouse-passive-test", () => false) : () => {};
    const group = new RunGroup({ index: 1, live: true }, () => tm.theme);
    const a = assistant(); const note = group.addCommentary(a.owner); group.addTool(tool());
    const doc = new Container(); doc.addChild(group);
    const f = screenFixture(doc);
    try {
      let row = group.childRows.find((r) => r.child === note)!;
      const base = f.bounds(group);
      f.gesture(point(base, row.start)); assert.equal(note.expanded, true);
      row = group.childRows.find((r) => r.child === note)!;
      const thought = note.thoughtLayout(row.width)[0];
      f.gesture(point(f.bounds(group), row.start + thought.start));
      assert.equal(a.owner.expanded, true); assert.equal(note.expanded, true);
      row = group.childRows.find((r) => r.child === note)!;
      f.gesture(point(f.bounds(group), row.start + row.height - 1));
      assert.equal(note.expanded, false); assert.equal(a.owner.expanded, true);
      group.setExpanded(false); f.paint(); assert.equal(a.owner.expanded, true, "note thought remains independent of text-note cascade");
      group.setExpanded(true); f.paint(); assert.equal(note.expanded, true);
      if (combined) assert.ok(getRegistry().handlers.has("native-mouse-passive-test"));
    } finally { f.close(); unsubscribe(); uninstallMousePatch(); }
  });
}

test("actual native selection drag, non-primary input and links do not toggle managed thought", () => {
  const a = assistant(), doc = new Container(); doc.addChild(a.owner);
  const link = new Text("\x1b]8;;https://example.invalid\x07synthetic link\x1b]8;;\x07", 0, 0); doc.addChild(link);
  const f = screenFixture(doc); let opened = 0; f.screen.openUrl = () => { opened++; };
  try {
    const p = point(f.bounds(a.line()));
    f.gesture(p, 2); assert.equal(a.owner.expanded, false);
    f.screen.handleViewportInput(`\x1b[<64;${p.x + 1};${p.y + 1}M`); f.paint(); assert.equal(a.owner.expanded, false);
    f.screen.lastClick = undefined;
    f.screen.handleViewportInput(`\x1b[<0;${p.x + 1};${p.y + 1}M`);
    f.screen.handleViewportInput(`\x1b[<32;${p.x + 4};${p.y + 1}M`);
    f.screen.handleViewportInput(`\x1b[<0;${p.x + 4};${p.y + 1}m`); f.paint();
    assert.equal(a.owner.expanded, false, "a selection drag is not a click");
    f.gesture(point(f.bounds(link))); assert.equal(opened, 1); assert.equal(a.owner.expanded, false);
  } finally { f.close(); }
});

for (const order of ["visor-only", "visor-first", "viewport-first"]) {
  test(`native ownership and independent subscriber survive factory load order/reload (${order})`, () => {
    uninstallMousePatch();
    const registry = getRegistry();
    const off = registry.on("native-mouse-independent-client", () => false);
    const createRuntime = () => {
      const shutdown: Array<(event: any) => void> = [];
      const pi = new Proxy({ on(event: string, fn: any) { if (event === "session_shutdown") shutdown.push(fn); } },
        { get(target, key) { return key in target ? (target as any)[key] : () => {}; } });
      if (order === "viewport-first") viewportMouseExtension(pi as never);
      visorExtension(pi as never);
      if (order === "visor-first") viewportMouseExtension(pi as never);
      return () => { for (const handler of shutdown) handler({ reason: "reload" }); };
    };
    try {
      for (let reload = 0; reload < 3; reload++) {
        const stop = createRuntime();
        assert.equal(registry.handlers.has("pi-visor.click-to-expand"), false, "candidate never registers the superseded subscriber");
        assert.ok(registry.handlers.has("native-mouse-independent-client"));
        const a = assistant(), c = tool(), doc = new Container(); doc.addChild(c); doc.addChild(a.owner);
        const f = screenFixture(doc);
        let calls = 0; const set = c.setExpanded.bind(c); c.setExpanded = (value) => { calls++; set(value); };
        try {
          f.gesture(point(firstMouseRegion(f.bounds(c)))); assert.equal(calls, 1); assert.equal((c as any).expanded, true);
          f.gesture(point(f.bounds(a.line()))); assert.equal(a.owner.expanded, true);
        } finally { f.close(); stop(); }
        assert.ok(registry.handlers.has("native-mouse-independent-client"), "reload must not clear external clients");
      }
    } finally { off(); uninstallMousePatch(); }
  });
}

test("actual standalone tool reproduces baseline double toggle; native-only path toggles once", () => {
  const c = tool(), doc = new Container(); doc.addChild(c);
  const f = screenFixture(doc); const legacy = new ClickToExpand();
  let toggles = 0; const set = c.setExpanded.bind(c);
  c.setExpanded = (value) => { toggles++; set(value); };
  try {
    uninstallMousePatch();
    f.gesture(point(firstMouseRegion(f.bounds(c))));
    assert.equal(toggles, 1); assert.equal((c as any).expanded, true);
    c.setExpanded(false); toggles = 0; f.paint();
    legacy.install({ on() {} } as never); installMousePatch();
    f.gesture(point(firstMouseRegion(f.bounds(c))));
    assert.equal(toggles, 2); assert.equal((c as any).expanded, false, "known baseline dual ownership is real, not only a timing claim");
  } finally { legacy.dispose(); uninstallMousePatch(); f.close(); }
});
