import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { before, test } from "node:test";
import * as Pi from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { RunGroup } from "../src/run-group.js";
import { RunGrouping, TranscriptGrouping, groupingForMode, type TranscriptMessage } from "../src/run-integration.js";
import { patchToolExecutionComponent } from "../src/tool-display.js";
import { formatTime } from "../src/format.js";
import { ThinkingManager } from "../src/thinking.js";
import { CommentaryRunChild } from "../src/run-child.js";

const themeModule = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
Pi.initTheme("dark");
const theme = () => themeModule.theme;
before(() => { assert.ok(patchToolExecutionComponent()); assert.ok(new ThinkingManager().installPatch()); });
const directory = new URL("./fixtures/native-order/", import.meta.url);
const trace = async (name: string): Promise<any[]> => (await readFile(new URL(name, directory), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
const natural = await trace("natural.jsonl");
const seeded = await trace("seeded-cleanup.jsonl");
const plain = (group: RunGroup, width = 120) => group.render(width).map(stripTerminalSequences).join("\n");
const nativeUi = { requestRender() {} } as never;

/** The input is captured native calls. Only the transcript storage is fake. */
function replay(rows: any[], onCheckpoint?: (record: any, state: any) => void) {
  let clock = rows[0].time;
  const chat = new Container();
  const notices: string[] = [];
  const controller = new TranscriptGrouping(chat, theme, (message) => notices.push(message), () => clock);
  assert.ok(controller.install());
  const components = new Map<string, Component>();
  const ids = new WeakMap<object, string>();
  const toolIds = new Map<string, Component>();
  const messageStack: Array<TranscriptMessage | undefined> = [];
  const endings = new Map<string, Component | undefined>();
  const leafIds = () => chat.children.flatMap((child) => child instanceof RunGroup ? child.children : [child]).map((child) => ids.get(child));
  for (const row of rows) {
    clock = row.time;
    if (row.op === "component") {
      let component: Component;
      if (row.kind === "AssistantMessageComponent") component = new Pi.AssistantMessageComponent(undefined);
      else if (row.kind === "ToolExecutionComponent") {
        component = new Pi.ToolExecutionComponent(row.toolName, row.toolCallId, row.args, {}, undefined, nativeUi, process.cwd());
        toolIds.set(row.toolCallId, component);
      } else if (row.kind === "UserMessageComponent") component = new Pi.UserMessageComponent((row.text ?? "user fixture").trim());
      else if (row.kind === "Spacer") component = new Spacer(1);
      else component = new Text(row.text ?? "fixture row", 0, 0);
      components.set(row.id, component); ids.set(component, row.id);
    } else if (row.op === "component_call") {
      const component = components.get(row.id) as any;
      const args = [...row.args];
      // JSON represents absent optional flags as null; native calls used undefined.
      if (["updateContent", "updateResult"].includes(row.method) && args[1] === null) args[1] = undefined;
      component[row.method](...args);
    } else if (row.op === "event" && row.phase === "before") {
      if (row.event.type === "agent_start") controller.begin();
      if (row.event.message) controller.beforeMessage(row.event.message);
      if (row.event.type === "message_end" && row.event.message?.role === "assistant") {
        endings.set(String(row.event.message.timestamp), components.get(row.streaming));
        if (row.event.message.stopReason === "aborted") controller.stopPending(row.pending.map((id: string) => toolIds.get(id)!).filter(Boolean));
      }
    } else if (row.op === "method" && row.phase === "before") {
      if (row.method === "addMessageToChat") {
        messageStack.push(controller.message);
        controller.beforeMessage(row.args[0]);
      }
      if (row.method === "renderSessionItems") { controller.rebuilding++; controller.prepareRebuild(row.args[0]); }
    } else if (row.op === "method" && row.phase === "after") {
      if (row.method === "addMessageToChat") controller.message = messageStack.pop();
      if (row.method === "renderSessionItems") controller.rebuilding--;
      if (row.method === "showStatus" && row.statusText) (components.get(row.statusText) as Text).setText(row.statusMessage);
    } else if (row.op === "addChild") chat.addChild(components.get(row.id)!);
    else if (row.op === "removeChild") chat.removeChild(components.get(row.id)!);
    else if (row.op === "clear") chat.clear();
    else if (row.op === "splice") {
      if (row.count) {
        // Container.removeChild itself invokes Array.splice. The parent operation
        // already removed it through the group-aware seam; do not remove twice.
        for (const id of row.before.slice(row.index, row.index + row.count)) {
          if (leafIds().includes(id)) chat.removeChild(components.get(id)!);
        }
      }
      if (row.ids.length) controller.spliceBefore(components.get(row.before[row.index]), row.ids.map((id: string) => components.get(id)!));
    } else if (row.op === "event" && row.phase === "after") {
      if (row.event.type === "message_end" && row.event.message?.role === "assistant") controller.endAssistant(endings.get(String(row.event.message.timestamp)), row.event.message);
      if (row.event.type === "agent_settled") controller.finish();
      // Grouping changes chrome, not the native logical operation order.
      assert.deepEqual(leafIds(), row.children, `logical order at recorded seq ${row.seq} (${row.scene}/${row.event.type})`);
      onCheckpoint?.(row, { controller, chat, components, ids, leafIds });
    }
  }
  return { chat, controller, components, notices, ids, leafIds };
}

test("fixture provenance is actual Pi 0.99.1 native order with all required natural scenarios", async () => {
  const provenance = JSON.parse(await readFile(new URL("natural-provenance.json", directory), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("natural-paths.json", directory), "utf8"));
  assert.equal(provenance.piVersion, "0.99.1");
  assert.equal(provenance.groupingLoaded, false);
  assert.equal(provenance.seedEnabled, false);
  const recorder = await readFile(new URL("./fixtures/record-pi-order.js", import.meta.url));
  assert.equal(createHash("sha256").update(recorder).digest("hex"), provenance.recorderSha256);
  const bytes = await readFile(new URL("natural.jsonl", directory));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.traceSha256);
  assert.ok(natural.length > 400);
  for (const scene of ["abort-text", "provider-error", "abort-toolstream"]) {
    assert.ok(natural.some((row) => row.scene === scene && row.op === "provider_pause"));
    assert.ok(natural.some((row) => row.scene === scene && row.op === "event" && row.phase === "after" && row.event.type === "agent_settled"));
    assert.equal(natural.filter((row) => row.scene === scene && row.op === "removeChild").length, 0);
  }
  assert.deepEqual(manifest.removeChildCounts, { "abort-text": 0, "provider-error": 0, "abort-toolstream": 0 });
  assert.ok(natural.some((row) => row.op === "splice"));
  assert.ok(natural.some((row) => row.op === "fixture_input"));
  assert.ok(natural.some((row) => row.op === "event" && row.event.message?.role === "user" && row.event.message.content?.some((block: any) => block.text === "steer-case")));
  assert.ok(natural.some((row) => row.op === "event" && row.event.message?.role === "user" && row.event.message.content?.some((block: any) => block.text === "followup-case")));
  assert.ok(natural.some((row) => row.op === "clear" && row.scene === "compaction"));
  assert.ok(natural.some((row) => row.op === "method" && row.method === "renderSessionItems" && row.scene === "compaction"));
  assert.ok(!natural.some((row) => row.op === "fixture_setup"));
});

test("replay preserves every recorded native leaf order, user boundary, final/no-tool placement and custom/status row", () => {
  let queueChecked = false, emptyChecked = false, rebuildChecked = false;
  const state = replay(natural, (row, state) => {
    if (row.event.type === "agent_settled" && row.scene === "queue") {
      queueChecked = true;
      assert.equal(state.controller.frames.length, 3, "steering and follow-up each close the current frame");
      assert.deepEqual(state.controller.frames.map((frame: any) => frame.group.counts.tools), [1, 1, 1]);
      assert.deepEqual(state.controller.frames.map((frame: any) => frame.group.counts.notes), [1, 1, 1]);
      assert.ok(state.controller.frames[0].group.entries.some((child: any) => child.kind === "row"));
      const final = state.chat.children.filter((child: Component) => child.constructor.name === "AssistantMessageComponent");
      assert.ok(final.length >= 1);
      assert.ok(final.every((child: any) => !child.hasToolCalls), "final text stays native outside the frames");
    }
    if (row.event.type === "agent_settled" && row.scene === "no-tool") {
      emptyChecked = true;
      assert.equal(state.controller.frames.length, 3, "no-tools adds no frame");
    }
    if (row.event.type === "compaction_end") {
      rebuildChecked = true;
      assert.equal(state.controller.frames.length, 1);
      const group = state.controller.frames[0].group;
      assert.equal(group.expanded, false);
      assert.ok(group.entries.every((child: any) => child.kind === "row" || !child.expanded));
      assert.match(plain(group), /Run 1 · Interrupted/);
      assert.match(plain(group), /0 errors/);
    }
  });
  assert.ok(queueChecked && emptyChecked && rebuildChecked);
  assert.deepEqual(state.notices, []);
  state.controller.dispose();
});

test("seeded cleanup is marked fixture setup before a real native agent_end removeChild", async () => {
  const provenance = JSON.parse(await readFile(new URL("seeded-provenance.json", directory), "utf8"));
  assert.equal(provenance.seedEnabled, true);
  const setup = seeded.find((row) => row.op === "fixture_setup");
  assert.equal(setup.source, "FIXTURE SETUP");
  const removal = seeded.find((row) => row.op === "removeChild");
  assert.equal(removal.source, "native");
  assert.equal(removal.id, setup.id);
  assert.ok(removal.seq > setup.seq);
  const event = seeded.find((row) => row.op === "event" && row.phase === "before" && row.event.type === "agent_end");
  assert.ok(event.seq < setup.seq);
  const state = replay(seeded);
  assert.ok(!state.leafIds().includes(setup.id));
  assert.equal(state.controller.frames.length, 0);
  state.controller.dispose();
});

function assistant(timestamp?: number) {
  return new Pi.AssistantMessageComponent({ role: "assistant", timestamp, content: [{ type: "text", text: "Commentary" }, { type: "toolCall", id: "tool", name: "fixture_hold", arguments: {} }], stopReason: "toolUse" } as never);
}
function component() { return new Pi.ToolExecutionComponent("fixture_hold", "tool", {}, {}, undefined, nativeUi, process.cwd()); }

test("group-aware removeChild removes a streaming component inside the frame, not just flat siblings", () => {
  const chat = new Container();
  const controller = new TranscriptGrouping(chat, theme, () => {});
  assert.ok(controller.install()); controller.begin();
  const note = assistant(1000); chat.addChild(note);
  const tool = component(); chat.addChild(tool);
  assert.equal(controller.frames[0].group.counts.notes, 1);
  assert.ok(!chat.children.includes(note));
  chat.removeChild(note);
  assert.equal(controller.frames[0].group.counts.notes, 0);
  assert.equal(controller.frames[0].group.counts.tools, 1);
  assert.ok(!controller.frames[0].group.children.includes(note));
  controller.dispose();
});

test("provisional stream stays flat until its first tool; no-tools final never becomes a note", () => {
  const chat = new Container();
  const controller = new TranscriptGrouping(chat, theme, () => {});
  assert.ok(controller.install()); controller.begin();
  controller.beforeMessage({ role: "assistant", timestamp: 1000, content: [], stopReason: "pending" });
  const stream = new Pi.AssistantMessageComponent(undefined); chat.addChild(stream);
  assert.ok(chat.children.includes(stream)); assert.equal(controller.frames.length, 0);
  stream.updateContent({ role: "assistant", timestamp: 1000, content: [{ type: "text", text: "Direct final" }], stopReason: "stop" } as never, false);
  controller.endAssistant(stream, { role: "assistant", timestamp: 1000, content: [{ type: "text", text: "Direct final" }], stopReason: "stop" });
  assert.equal(controller.frames.length, 0); assert.ok(chat.children.includes(stream));
  controller.dispose();
});

test("runtime seam failure rolls back partial grouping without duplicate flat components", () => {
  const chat = new Container();
  const originalAdd = chat.addChild;
  const notices: string[] = [];
  const controller = new TranscriptGrouping(chat, theme, (message) => notices.push(message));
  assert.ok(controller.install()); controller.begin();
  const note = assistant(1000); chat.addChild(note);
  // Model a future Pi component with a working native renderer but no old Box field.
  const future = Object.create(Pi.ToolExecutionComponent.prototype);
  future.render = () => ["future native tool"]; future.invalidate = () => {};
  chat.addChild(future);
  assert.equal(controller.active, false);
  assert.deepEqual(chat.children, [note, future]);
  assert.equal(chat.addChild, originalAdd);
  assert.equal(notices.length, 1);
  assert.ok(!chat.children.some((child) => child instanceof RunGroup));
});

test("rebuilt E8 tool time uses result timestamp, duration is always omitted, and missing values omit separators", () => {
  for (const [start, end] of [[1000, 2250], [1000, undefined], [undefined, 2250]] as const) {
    const chat = new Container();
    const controller = new TranscriptGrouping(chat, theme, () => {});
    assert.ok(controller.install()); controller.rebuilding++;
    const message = { role: "assistant", timestamp: start, stopReason: "toolUse", content: [{ type: "toolCall", id: "tool" }] };
    const result = { role: "toolResult", timestamp: end, toolCallId: "tool", content: [{ type: "text", text: "body" }] };
    controller.prepareRebuild([message, result]);
    controller.beforeMessage(message);
    chat.addChild(assistant(start));
    const tool = component(); chat.addChild(tool);
    tool.updateResult({ content: [{ type: "text", text: "body" }], isError: false });
    controller.rebuilding--;
    const group = controller.frames[0].group;
    assert.equal(group.expanded, false);
    group.setLayerExpanded(true);
    const text = plain(group);
    if (start !== undefined) assert.ok(text.includes(formatTime(start)), "run/commentary time still uses first assistant");
    if (end !== undefined) assert.ok(text.includes("↳ 1 line • " + formatTime(end) + " (ctrl+o)"));
    else assert.ok(text.includes("↳ 1 line (ctrl+o)"));
    const toolFooter = text.split("\n").find((line) => line.includes("↳ 1 line"))!;
    assert.ok(!/\d+(?:\.\d+)?(?:ms|s)\b/.test(toolFooter), "single-call restored execution duration is unavailable");
    assert.ok(!text.includes("0ms"));
    assert.ok(!/•\s*\(ctrl\+o\)/.test(text));
    assert.ok(!/Commentary.*(?:ms|s)\b/.test(text));
    controller.dispose();
  }
});

test("rebuilt parallel tools never inherit assistant or whole-batch durations", () => {
  const chat = new Container(); const controller = new TranscriptGrouping(chat, theme, () => {});
  assert.ok(controller.install()); controller.rebuilding++;
  const m = { role: "assistant", timestamp: 1000, stopReason: "toolUse", content: [
    { type: "toolCall", id: "slow" }, { type: "toolCall", id: "fast" },
  ] };
  controller.prepareRebuild([m,
    { role: "toolResult", toolCallId: "slow", timestamp: 13011 },
    { role: "toolResult", toolCallId: "fast", timestamp: 13012 },
  ]);
  controller.beforeMessage(m);
  chat.addChild(new Pi.AssistantMessageComponent(m as never));
  for (const id of ["slow", "fast"]) {
    const c = new Pi.ToolExecutionComponent("fixture_hold", id, {}, {}, undefined, nativeUi, process.cwd());
    chat.addChild(c); c.updateResult({ content: [{ type: "text", text: "body" }], isError: false });
  }
  controller.rebuilding--;
  const group = controller.frames[0].group; group.setLayerExpanded(true);
  const rows = plain(group).split("\n").filter((line) => line.includes("↳ 1 line"));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes(formatTime(13011))); assert.ok(rows[1].includes(formatTime(13012)));
  assert.ok(rows.every((line) => !/12\.01|12\.02|\d+ms/.test(line)));
  assert.equal(controller.frames[0].first, 1000); assert.equal(controller.frames[0].last, 13012);
  assert.ok(plain(group).includes("12s"), "the recorded run span remains available");
  controller.dispose();
});

test("D11 live and rebuilt tool-only/thought-only members remain uncounted and preserve timing/order", () => {
  for (const rebuilding of [false, true]) {
    for (const thought of [false, true]) {
      const chat = new Container();
      const controller = new TranscriptGrouping(chat, theme, () => {});
      assert.ok(controller.install());
      if (rebuilding) controller.rebuilding++; else controller.begin();
      const message = { role: "assistant", timestamp: 1000, stopReason: "toolUse", content: [
        ...(thought ? [{ type: "thinking", thinking: "Reasoning fixture" }] : []),
        { type: "toolCall", id: "tool", name: "fixture_hold", arguments: {} },
      ] };
      const result = { role: "toolResult", timestamp: 2500, toolCallId: "tool", content: [{ type: "text", text: "body" }] };
      controller.prepareRebuild([message, result]); controller.beforeMessage(message);
      const member = new Pi.AssistantMessageComponent(message as never); chat.addChild(member);
      const tool = component(); chat.addChild(tool); tool.updateResult({ content: [{ type: "text", text: "body" }], isError: false });
      if (rebuilding) controller.rebuilding--;
      const group = controller.frames[0].group; group.setLayerExpanded(true);
      assert.equal(group.counts.notes, 0);
      assert.equal(group.children[0], member, "timestamp-bearing original member stays in order");
      const text = plain(group);
      assert.ok(!text.includes("Commentary")); assert.ok(!text.includes("↳ 0 lines"));
      assert.equal(text.includes("Thought"), thought);
      const view = group.entries[0] as CommentaryRunChild;
      assert.equal(view.kind, "row");
      if (thought) {
        const regions = view.thoughtLayout(116);
        assert.equal(regions[0].start, 0); assert.equal(regions[0].x, 0); assert.equal(regions[0].width, 116);
        regions[0].component.setExpanded(true);
        assert.ok(plain(group).includes("Reasoning fixture"));
        assert.equal(group.counts.notes, 0);
      } else assert.deepEqual(view.render(116), []);
      if (rebuilding) assert.ok(text.includes(formatTime(1000)), "hidden member still supplies E8 timestamp");
      controller.dispose();
    }
  }
});

test("D11 dynamically creates a commentary shell when visible text arrives after empty streaming content", () => {
  const chat = new Container();
  const controller = new TranscriptGrouping(chat, theme, () => {});
  assert.ok(controller.install()); controller.begin();
  const initial = { role: "assistant", timestamp: 1000, stopReason: "pending", content: [{ type: "toolCall", id: "tool", name: "fixture_hold", arguments: {} }] };
  controller.beforeMessage(initial);
  const stream = new Pi.AssistantMessageComponent(initial as never); chat.addChild(stream); chat.addChild(component());
  const group = controller.frames[0].group;
  assert.equal(group.counts.notes, 0); assert.ok(!plain(group).includes("Commentary"));
  stream.updateContent({ ...initial, content: [{ type: "text", text: "Now visible commentary" }, ...initial.content] } as never, true);
  assert.equal(group.counts.notes, 1); assert.match(plain(group), /Commentary Now visible commentary/);
  const view = group.entries[0] as CommentaryRunChild;
  view.setGroupExpanded(true);
  assert.equal((stream as any).__visorThinkExpanded, undefined);
  assert.ok(plain(group).includes("Now visible commentary"));
  assert.equal(group.children[0], stream);
  controller.dispose();
});

test("hook failure leaves the original flat tree and emits one notice", () => {
  const chat = new Container();
  const row = new Text("native flat", 0, 0); chat.addChild(row);
  Object.defineProperty(chat, "addChild", { value: chat.addChild, writable: false, configurable: false });
  const notices: string[] = [];
  const controller = new TranscriptGrouping(chat, theme, (notice) => notices.push(notice));
  assert.equal(controller.install(), false);
  assert.equal(controller.install(), false);
  assert.deepEqual(chat.children, [row]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /transcript stays flat/);
});

test("reload owner handoff recaptures retained mode/UI before rebuild without another UI factory call", () => {
  const chat = new Container(); const notice: string[] = [];
  const mode: any = { chatContainer: chat, pendingTools: new Map(), ui: { requestRender() {} },
    handleEvent: async () => {}, addMessageToChat() {}, renderSessionItems() {}, addCustomEntryToChat() {}, showStatus() {} };
  const handlers = new Map<string, (...args: any[]) => void>();
  const pi = { on: (event: string, handler: (...args: any[]) => void) => { handlers.set(event, handler); } } as never;
  const old = new RunGrouping(); old.install(pi); old.capture(mode, { theme: theme(), notify: (text: string) => notice.push(text) });
  const previous = groupingForMode(mode)!;
  handlers.get("session_shutdown")!({ reason: "reload" });
  assert.equal(groupingForMode(mode), undefined);
  const next = new RunGrouping(); next.install(pi);
  const current = groupingForMode(mode)!;
  assert.ok(current, "new install must capture before beforeSessionStart rebuild");
  assert.notEqual(current, previous);
  chat.clear(); chat.addChild(assistant(1000)); chat.addChild(component());
  assert.equal(current.frames.length, 1); assert.equal(current.frames[0].group.expanded, false);
  current.begin(); current.boundary(); chat.addChild(assistant(2000)); chat.addChild(component());
  assert.equal(current.frames.length, 2);
  assert.equal(current.frames[1].group.counts.tools, 1);
  assert.deepEqual(notice, []);
  handlers.get("session_shutdown")!({ reason: "quit" });
  assert.equal(groupingForMode(mode), undefined);
});

test("live instance capture is idempotent; native status duplicate detection and custom splice see grouped children", () => {
  const chat = new Container();
  const notify: string[] = [];
  const nativeStatus = (Pi.InteractiveMode.prototype as any).showStatus;
  const mode: any = { chatContainer: chat, pendingTools: new Map(), ui: { requestRender() {} },
    handleEvent: async () => {}, addMessageToChat() {}, renderSessionItems() {}, showStatus: nativeStatus,
    addCustomEntryToChat(component: Component) { const index = this.chatContainer.children.indexOf(this.streamingComponent); if (index >= 0) this.chatContainer.children.splice(index, 0, component); else this.chatContainer.addChild(component); },
  };
  const grouping = new RunGrouping();
  grouping.capture(mode, { theme: theme(), notify: (message: string) => notify.push(message) });
  const first = groupingForMode(mode)!;
  grouping.capture(mode, { theme: theme(), notify() {} });
  assert.equal(groupingForMode(mode), first);
  first.begin();
  const note = assistant(1000); mode.streamingComponent = note; chat.addChild(note); chat.addChild(component());
  mode.showStatus("one status"); mode.showStatus("replacement status");
  assert.equal(first.frames[0].group.entries.filter((entry) => entry.kind === "row").length, 2);
  assert.ok(plain(first.frames[0].group).includes("replacement status"));
  const custom = new Text("custom before commentary", 0, 0);
  mode.addCustomEntryToChat(custom);
  assert.equal(first.frames[0].group.children[0], custom);
  grouping.dispose();
  assert.equal(groupingForMode(mode), undefined);
  assert.ok(chat.children.includes(note));
  assert.equal(mode.showStatus, nativeStatus);
  assert.deepEqual(notify, []);
  // Reload takes a new owner and a fresh local state, not another wrapper layer.
  chat.clear();
  const reloaded = new RunGrouping();
  reloaded.capture(mode, { theme: theme(), notify() {} });
  const next = groupingForMode(mode)!;
  assert.notEqual(next, first);
  next.begin(); chat.addChild(assistant(2000)); chat.addChild(component());
  assert.equal(next.frames.length, 1);
  assert.equal(next.frames[0].group.counts.tools, 1);
  reloaded.dispose();
  assert.equal(groupingForMode(mode), undefined);
  assert.equal(mode.showStatus, nativeStatus);
});
