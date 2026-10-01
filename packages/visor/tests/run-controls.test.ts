import assert from "node:assert/strict";
import { before, test } from "node:test";
import * as Pi from "@earendil-works/pi-coding-agent";
import { Container, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { RunGroup } from "../src/run-group.js";
import { RunGrouping, TranscriptGrouping, groupingForMode } from "../src/run-integration.js";
import { CommentaryRunChild } from "../src/run-child.js";
import { ThinkingManager } from "../src/thinking.js";
import { ClickToExpand } from "../src/click-to-expand.js";
import { patchToolExecutionComponent } from "../src/tool-display.js";
import { installMousePatch } from "../../viewport-mouse/src/patch.js";
import { getRegistry } from "../../viewport-mouse/src/registry.js";

const tm = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
Pi.initTheme("dark");
const theme = () => tm.theme;
const ui = { requestRender() {} } as never;
before(() => { assert.ok(patchToolExecutionComponent()); assert.ok(new ThinkingManager().installPatch()); });
function msg(text: string, thought = false) {
  return { role: "assistant", timestamp: 1000, stopReason: "toolUse", content: [
    ...(thought ? [{ type: "thinking", thinking: "reasoning body" }] : []),
    ...(text ? [{ type: "text", text }] : []), { type: "toolCall", id: "t", name: "bash", arguments: {} },
  ] } as never;
}
function tool(output = "body", error = false) {
  const c = new Pi.ToolExecutionComponent("bash", "t", { command: "printf x" }, {}, undefined, ui, process.cwd());
  c.updateResult({ content: [{ type: "text", text: output }], isError: error });
  return c;
}
function event(group: RunGroup, y: number, x = 5, width = 80): TuiMouseEvent {
  return { type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: group.render(width).length, shift: false, alt: false, ctrl: false };
}
function fixture() {
  const group = new RunGroup({ index: 1, live: true }, theme);
  const note = group.addCommentary(new Pi.AssistantMessageComponent(msg("Commentary text", true)));
  const c = tool("x".repeat(78)); // W-4 < 78 < W at 80; body wraps only inside frame.
  const view = group.addTool(c, { timing: {} });
  return { group, note, c, view };
}

for (const combined of [false, true]) {
  test(`native chrome/child/thought routing toggles once (${combined ? "visor+viewport-mouse" : "visor only"})`, () => {
    getRegistry().handlers.clear();
    const clicks = new ClickToExpand();
    clicks.install({ on() {} } as never);
    const { group, note, c, view } = fixture();
    const doc = new Container(); doc.addChild(group);
    let nativeCalls = 0;
    const target: any = { prototype: { handleViewportInput(this: any, data: string) {
      nativeCalls++;
      const match = /^\x1b\[<0;(\d+);(\d+)m$/.exec(data);
      if (!match) return;
      const x = Number(match[1]) - 1, y = Number(match[2]) - 1;
      return doc.handleMouse({ ...event(group, y, x), height: doc.render(80).length });
    } } };
    if (combined) installMousePatch({ target });
    const scroll: any = { child: doc, scrollTop: 0, getContentWidth: (width: number) => width };
    const instance: any = Object.create(target.prototype);
    const paint = () => {
      const lines = doc.render(80);
      instance.currentLayout = { root: { scrollView: scroll, rect: { x: 0, y: 0, width: 80, height: lines.length }, scrollContentLines: lines } };
      instance.getPrimaryScrollView = () => scroll;
      instance.requestRender = () => {};
    };
    const click = (y: number, x = 5) => {
      paint(); instance.selectionAnchor = { row: y }; instance.selectionDragged = false;
      instance.handleViewportInput(`\x1b[<0;${x + 1};${y + 1}m`);
    };
    let changes = 0;
    const set = c.setExpanded.bind(c);
    c.setExpanded = (value) => { changes++; set(value); };
    group.render(80);
    click(group.childRows.find((row) => row.child === view)!.start);
    assert.equal((c as any).expanded, true); assert.equal(changes, 1);
    const open = group.render(80);
    const toolRows = group.childRows.find((row) => row.child === view)!;
    assert.ok(toolRows.height >= 6, "width-sensitive body really wraps inside the frame");
    click(toolRows.start + toolRows.height - 1);
    assert.equal((c as any).expanded, false); assert.equal(changes, 2);
    click(group.childRows.find((row) => row.child === note)!.start);
    assert.equal(note.expanded, true);
    group.render(80);
    const noteRows = group.childRows.find((row) => row.child === note)!;
    const thought = note.thoughtLayout(noteRows.width)[0];
    click(noteRows.start + thought.start);
    assert.equal(thought.component.expanded, true); assert.equal(note.expanded, true);
    // Header closure/reopen keeps the child layers untouched.
    click(1); assert.equal(group.expanded, false); assert.equal(note.expanded, true);
    click(1); assert.equal(group.expanded, true); assert.equal(note.expanded, true);
    group.render(80);
    const covered = new Set(group.childRows.flatMap((row) => Array.from({ length: row.height }, (_, i) => row.start + i)));
    const chrome = Array.from({ length: group.render(80).length }, (_, i) => i).filter((y) => !covered.has(y));
    for (const y of chrome) {
      group.setLayerExpanded(true); group.render(80); click(y);
      assert.equal(group.expanded, false, `chrome row ${y} toggles only layer 1`);
    }
    group.setLayerExpanded(true); group.render(80);
    click(group.childRows.find((row) => row.child === view)!.start, 0);
    assert.equal(group.expanded, false, "vertical frame border is parent chrome");
    assert.ok(nativeCalls > 0);
    clicks.dispose(); getRegistry().handlers.clear();
  });
}

test("Ctrl+O cascades to both layers and late children, with D12 thought-only/text meanings", () => {
  const { group, note, c } = fixture();
  const thinkingOnly = group.addCommentary(new Pi.AssistantMessageComponent(msg("", true)));
  group.setExpanded(true);
  assert.equal(group.expanded, true); assert.equal(note.expanded, true); assert.equal((c as any).expanded, true);
  assert.equal((note.component as any).__visorThinkExpanded, undefined, "text commentary thought is independent");
  assert.equal((thinkingOnly.component as any).__visorThinkExpanded, true);
  const lateTool = tool(); group.addTool(lateTool);
  const lateNote = group.addCommentary(new Pi.AssistantMessageComponent(msg("Late visible note")));
  const lateThought = group.addCommentary(new Pi.AssistantMessageComponent(msg("", true)));
  assert.equal((lateTool as any).expanded, true); assert.equal(lateNote.expanded, true);
  assert.equal((lateThought.component as any).__visorThinkExpanded, true);
  group.setExpanded(false);
  assert.equal(group.expanded, false); assert.equal(note.expanded, false); assert.equal((lateTool as any).expanded, false);
  assert.equal((thinkingOnly.component as any).__visorThinkExpanded, false);
  const empty = new Pi.AssistantMessageComponent(msg(""));
  const evolving = group.addCommentary(empty);
  group.setExpanded(true);
  empty.updateContent(msg("Text arrived late"), true); group.render(80);
  assert.equal(evolving.expanded, true);
  assert.equal(group.counts.notes, 3);
});

for (const combined of [false, true]) {
  test(`D11 thought-only owns its own toggle (${combined ? "combined" : "native"})`, () => {
    const group = new RunGroup({ index: 1, live: true }, theme);
    const thought = group.addCommentary(new Pi.AssistantMessageComponent(msg("", true)));
    group.addTool(tool()); group.render(80);
    const row = group.childRows.find((entry) => entry.child === thought)!;
    const clicks = new ClickToExpand(); clicks.install({ on() {} } as never);
    if (combined) {
      // Legacy chain is explicitly deferred; native gets the one actual toggle.
      let matched = false;
      const handler = getRegistry().handlers.get("pi-visor.click-to-expand")!;
      const legacy: any = { closest: (predicate: (c: any) => boolean) => predicate(group) ? group : undefined, requestRender() {}, flash() {} };
      assert.equal(handler(legacy), false); matched = true; assert.ok(matched);
    }
    group.handleMouse(event(group, row.start));
    assert.equal(thought.thoughtLines[0].expanded, true); assert.equal(group.counts.notes, 0);
    assert.equal(thought.expanded, false);
    clicks.dispose(); getRegistry().handlers.clear();
  });
}

test("per-frame settlement collapses untouched success once, preserving touched/error/interrupted exact state", () => {
  for (const state of ["success", "touched-open", "touched-closed", "error-open", "error-closed", "interrupted-open", "interrupted-closed"]) {
    const group = new RunGroup({ index: 1, live: true, outcome: state.startsWith("interrupted") ? "interrupted" : "success" }, theme);
    group.addTool(tool("body", state.startsWith("error")));
    if (state.startsWith("touched")) group.markTouched();
    const closed = state.endsWith("closed"); if (closed) group.setLayerExpanded(false);
    group.settle();
    assert.equal(group.expanded, state === "success" || closed ? false : true, state);
    if (state === "success") { group.setLayerExpanded(true); group.settle(); assert.equal(group.expanded, true, "settlement runs only once"); }
  }
});

test("D12 later abort never relabels earlier closed success/touched/error frames", () => {
  const chat = new Container(); const controller = new TranscriptGrouping(chat, theme, () => {});
  assert.ok(controller.install()); controller.begin();
  const frames: RunGroup[] = [];
  for (const state of ["success", "touched", "error", "current"]) {
    if (frames.length) controller.boundary();
    const note = new Pi.AssistantMessageComponent(msg("Note")); chat.addChild(note);
    const c = tool("body", state === "error"); chat.addChild(c);
    const group = controller.current!.group;
    if (state === "touched") { group.markTouched(); group.setLayerExpanded(false); }
    frames.push(group);
  }
  frames[3].setLayerExpanded(false);
  controller.stopPending(frames[3].children);
  controller.finish();
  assert.equal(frames[0].expanded, false); assert.equal(frames[1].expanded, false);
  assert.equal(frames[2].expanded, true); assert.equal(frames[3].expanded, false);
  for (let i = 0; i < 3; i++) assert.ok(!frames[i].render(120).join("").includes("Interrupted"));
  assert.ok(frames[3].render(120).join("").includes("Interrupted"));
  assert.equal(frames[3].counts.errors, 0); controller.dispose();
});

test("native thinking/output-padding scans, Ctrl+O and abort API reach nested members", async () => {
  const proto = Pi.InteractiveMode.prototype as any;
  const chat = new Container();
  let aborted = 0;
  const mode: any = { chatContainer: chat, pendingTools: new Map(), outputPad: 1, hideThinkingBlock: true,
    ui: { requestRender() {} }, loadedResourcesContainer: new Container(), toolOutputExpanded: false,
    handleEvent: async () => {}, addMessageToChat() {}, renderSessionItems() {}, addCustomEntryToChat() {}, showStatus: proto.showStatus,
    updateThinkingBlockVisibility: proto.updateThinkingBlockVisibility, setToolsExpanded: proto.setToolsExpanded,
    session: { abort: async () => { aborted++; } },
  };
  const service = new RunGrouping(); service.capture(mode, { theme: theme(), notify() {} });
  const controller = groupingForMode(mode)!; controller.begin();
  const note = new Pi.AssistantMessageComponent(msg("Nested note", true)); chat.addChild(note);
  const c = tool(); chat.addChild(c); mode.pendingTools.set("t", c);
  const final = new Pi.AssistantMessageComponent({ ...(msg("Final") as any), content: [{ type: "text", text: "Final native" }], stopReason: "stop" });
  controller.endAssistant(note, { role: "assistant", stopReason: "toolUse", timestamp: 1000 });
  chat.addChild(final);
  mode.setToolsExpanded(true);
  assert.equal(controller.frames[0].group.expanded, true);
  assert.equal((controller.frames[0].group.entries[0] as CommentaryRunChild).expanded, true);
  mode.hideThinkingBlock = false; mode.updateThinkingBlockVisibility();
  assert.equal((note as any).hideThinkingBlock, true, "managed visor placeholder path remains authoritative");
  mode.outputPad = 2;
  assert.equal((note as any).outputPad, 2);
  final.setOutputPad(2); // the original direct-child callback still owns native final siblings
  assert.equal((final as any).outputPad, 2);
  await mode.session.abort(); assert.equal(aborted, 1);
  controller.finish(); assert.equal(controller.frames[0].group.counts.errors, 0);
  assert.ok(controller.frames[0].group.render(120).join("").includes("Interrupted"));
  service.dispose(); assert.equal(mode.outputPad, 2);
});
