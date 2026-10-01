import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import * as Pi from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { RunGroup } from "../src/run-group.js";
import { CommentaryRunChild } from "../src/run-child.js";
import { type RunTheme } from "../src/run-style.js";
import { EXCLUDED, patchToolExecutionComponent } from "../src/tool-display.js";
import { ThinkingManager } from "../src/thinking.js";

const themeModule = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
Pi.initTheme("dark");
const currentTheme = () => themeModule.theme as RunTheme;
const start = new Date(2026, 9, 1, 10, 4, 12).getTime();
const ui = { requestRender() {} } as never;
const plain = (lines: string[]) => lines.map(stripTerminalSequences);
const thinking = new ThinkingManager();
before(() => { assert.ok(patchToolExecutionComponent()); assert.ok(thinking.installPatch()); });

function message(text: string, thought?: string) {
  return { role: "assistant", content: [...(thought ? [{ type: "thinking", thinking: thought }] : []), { type: "text", text }],
    timestamp: start, stopReason: "toolUse", api: "fixture", provider: "fixture", model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never;
}
function tool(name: string, args: unknown, text?: string, error = false, details?: unknown, definition?: ConstructorParameters<typeof Pi.ToolExecutionComponent>[4]) {
  const c = new Pi.ToolExecutionComponent(name, name + "-fixture", args, {}, definition, ui, process.cwd());
  c.setArgsComplete();
  if (text !== undefined) c.updateResult({ content: [{ type: "text", text }], details, isError: error });
  return c;
}

// A small fixed fixture covers every visual row; real native definitions have separate checks below.
function fixture(state: string) {
  const group = new RunGroup({ index: 1, timestamp: start, durationMs: state === "live" ? 3000 : 27000, live: state === "live",
    outcome: state === "error" ? "error" : state === "interrupted" ? "interrupted" : "success" }, currentTheme, state !== "A");
  const note = group.addCommentary(new Pi.AssistantMessageComponent(message("Trace the settled duration.\nKeep the native diff.")), { timestamp: start, durationMs: 1000 });
  const first = group.addTool(tool("bash", { command: "printf hello" }, "hello\nworld"), { timing: { timestamp: start + 1000, durationMs: 136 } });
  const second = group.addTool(tool("bash", { command: "npm run check" }, state === "live" ? undefined : state === "error" ? "failed\nExit code: 1" : "all checks passed", state === "error" || state === "interrupted", { exitCode: state === "error" ? 1 : undefined }),
    { timing: { timestamp: start + 2000, durationMs: 312 }, stopped: state === "interrupted" });
  if (state === "C") first.setExpanded(true);
  return { group, note, first, second };
}

for (const width of [80, 120]) {
  for (const state of ["A", "B", "C", "error", "interrupted", "live"]) {
    test(`bounded frame golden ${state} at ${width} columns`, async () => {
      const { group } = fixture(state);
      const actual = plain(group.render(width)).join("\n") + "\n";
      const expected = await readFile(new URL(`./fixtures/run-groups/${state}-${width}.txt`, import.meta.url), "utf8");
      assert.equal(actual, expected);
      for (const line of group.render(width)) assert.equal(visibleWidth(line), width);
    });
  }
}

test("frame uses the exact current Pi semantic colors", () => {
  const calls: Array<[string, string]> = [];
  const base = currentTheme();
  const recording: RunTheme = { fg: (color, text) => { calls.push([color, text]); return base.fg(color, text); }, bg: base.bg.bind(base), bold: base.bold.bind(base) };
  for (const [outcome, live, dot] of [["success", false, "success"], ["error", false, "error"], ["interrupted", false, "error"], ["success", true, "warning"]] as const) {
    const g = new RunGroup({ index: 2, live, outcome }, () => recording);
    g.addTool(tool("bash", { command: "echo x" }, "x"));
    g.render(80);
    assert.ok(calls.some(([color, text]) => color === dot && text === "●"));
  }
  assert.ok(calls.some(([color, text]) => color === "accent" && /▸|▾/.test(text)));
  assert.ok(calls.some(([color, text]) => color === "text" && text.includes("Run 2")));
  assert.ok(calls.some(([color, text]) => color === "muted" && text.includes("tools")));
  assert.ok(calls.some(([color, text]) => color === "borderMuted" && text.includes("┌")));
  assert.equal(themeModule.getResolvedThemeColors("dark").borderMuted, "#768186");
});

test("grouped footer is wholly muted, pending/error colors and native padding are exact", () => {
  const t = currentTheme();
  const { group } = fixture("error");
  const lines = group.render(80);
  assert.ok(lines.some((line) => line.includes(t.fg("muted", "↳ 2 lines · exit 1 • 10:04:14 • 312ms (ctrl+o)"))));
  assert.ok(lines.some((line) => line.includes(t.fg("text", t.bold("Error · ")))));
  const { group: live } = fixture("live");
  const pending = live.render(80).find((line) => stripTerminalSequences(line).includes("↳ … running"))!;
  assert.ok(pending.includes(t.fg("muted", "↳ … running")));
  assert.ok(pending.includes(themeModule.theme.getBgAnsi("toolPendingBg")));
  assert.ok(lines.some((line) => line.includes(themeModule.theme.getBgAnsi("toolErrorBg"))));
  assert.ok(plain(lines).some((line) => line.startsWith("│  bash ")), "one frame cell + one native tool padding cell");
  assert.ok(plain(lines).some((line) => line.startsWith("│ Commentary ")), "commentary has no tool background/padding");
});

test("an open pending child retains D10 call/footer/repeated-call/blank ordering", () => {
  for (const [name, args, definition] of [
    ["bash", { command: "echo x" }, undefined],
    ["read", { path: "read.txt" }, Pi.createReadToolDefinition(process.cwd())],
  ] as const) {
    const group = new RunGroup({ index: 1, live: true }, currentTheme);
    const view = group.addTool(tool(name, args, undefined, false, undefined, definition));
    view.setExpanded(true);
    const lines = plain(view.render(76)).map((line) => line.trim());
    assert.match(lines[0], new RegExp(`^${name} `));
    assert.equal(lines[1], "↳ … running");
    assert.equal(lines[2], lines[0]);
    assert.equal(lines[3], "");
  }
});

test("missing or invalid timing has no invented separators; stopped tools are not errors", () => {
  const group = new RunGroup({ index: 7, outcome: "interrupted" }, currentTheme, true);
  group.addCommentary(new Pi.AssistantMessageComponent(message("One note")), { timestamp: NaN, durationMs: -1 });
  group.addTool(tool("bash", {}, "interrupted", true), { timing: {}, stopped: true });
  const lines = plain(group.render(120));
  assert.ok(lines.some((line) => line.includes("1 tools • 1 notes • 0 errors · stopped after 0 tools · kept open (ctrl+o)")));
  assert.ok(lines.some((line) => line.includes("↳ 1 line (ctrl+o)")));
  assert.ok(!lines.some((line) => /Error ·|0ms|\d\d:\d\d:\d\d|•\s*\(ctrl/.test(line)));
});

test("empty grouped tool results retain the lab's zero-line footer", () => {
  const group = new RunGroup({ index: 1 }, currentTheme, true);
  group.addTool(tool("bash", {}, ""), { timing: {} });
  assert.ok(plain(group.render(80)).some((line) => line.includes("↳ 0 lines (ctrl+o)")));
});

test("commentary state is per group instance, native final text and thinking controls stay native", () => {
  const inside = new Pi.AssistantMessageComponent(message("**Trace** the source.\nRead the diff.", "private reasoning"));
  const outside = new Pi.AssistantMessageComponent(message("Final answer stays **native**."));
  const nativeRender = outside.render;
  const nativeExpanded = (inside as unknown as { setExpanded(v: boolean): void }).setExpanded;
  const view = new CommentaryRunChild(inside, currentTheme, { timestamp: start, durationMs: 2000 });
  assert.equal(view.render(80).length, 2);
  view.setGroupExpanded(true);
  assert.equal((inside as unknown as { __visorThinkExpanded?: boolean }).__visorThinkExpanded, undefined);
  const open = plain(view.render(80));
  assert.match(open[0], /^Commentary \*\*Trace\*\*/);
  assert.match(open[1], /^↳ 2 lines • 10:04:12 • 2s/);
  assert.match(open[2], /Thought/);
  assert.equal(open[3], "**Trace** the source.");
  assert.ok(view.render(80)[3].includes(themeModule.theme.getFgAnsi("muted")));
  assert.equal((inside as unknown as { setExpanded(v: boolean): void }).setExpanded, nativeExpanded);
  const other = new CommentaryRunChild(new Pi.AssistantMessageComponent(message("Other commentary")), currentTheme);
  assert.equal(other.expanded, false);
  assert.equal(outside.render, nativeRender);
  assert.ok(!plain(outside.render(80)).some((line) => line.includes("Commentary")));
  const thought = view.thoughtLines[0];
  thought.setExpanded(true);
  assert.ok(plain(view.render(80)).some((line) => line.includes("private reasoning")));
  assert.equal(view.expanded, true);
  view.setGroupExpanded(false);
  assert.equal(view.render(80).length, 2);
  assert.equal(thought.expanded, true);
});

test("commentary open form and supplied partial timing retain exact rows at 80 and 120", () => {
  for (const width of [80, 120]) {
    const note = new CommentaryRunChild(new Pi.AssistantMessageComponent(message("First note line.\nSecond note line.")), currentTheme, { timestamp: start });
    note.setGroupExpanded(true);
    assert.deepEqual(plain(note.render(width)), [
      "Commentary First note line.", "↳ 2 lines • 10:04:12 (ctrl+o)", "First note line.", "Second note line.",
    ]);
    note.setMetadata({ timestamp: NaN, durationMs: 2000 });
    assert.equal(plain(note.render(width))[1], "↳ 2 lines • 2s (ctrl+o)");
    const group = new RunGroup({ index: 1, keptOpen: true }, currentTheme, true);
    group.addTool(tool("bash", {}, "body"), { timing: { durationMs: 42 } });
    const rows = plain(group.render(width));
    assert.ok(rows.some((line) => line.includes("0 errors · kept open (ctrl+o)")));
    assert.ok(rows.some((line) => line.includes("↳ 1 line • 42ms (ctrl+o)")));
  }
});

test("settled children cache by width, revision and current theme; live updates do not repaint siblings", () => {
  let theme = currentTheme();
  const group = new RunGroup({ index: 1, live: true }, () => theme);
  const settled = group.addTool(tool("bash", {}, "settled output"));
  const liveComponent = tool("bash", {}, undefined);
  group.addTool(liveComponent);
  let renders = 0;
  const original = settled.render.bind(settled);
  settled.render = (width) => { renders++; return original(width); };
  group.render(80);
  liveComponent.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
  group.setMetadata({ durationMs: 5000 });
  group.render(80);
  assert.equal(renders, 1);
  settled.setExpanded(true);
  group.render(80);
  assert.equal(renders, 2);
  group.render(120);
  assert.equal(renders, 3);
  theme = { fg: theme.fg.bind(theme), bg: theme.bg.bind(theme), bold: theme.bold.bind(theme) };
  group.render(120);
  assert.equal(renders, 4);
  group.invalidate();
  group.render(120);
  assert.equal(renders, 5);
});

test("grouped live timing freezes before a delayed first draw", (t) => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const group = new RunGroup({ index: 1 }, currentTheme, false);
  const c = tool("bash", { command: "echo x" });
  group.addTool(c);
  c.markExecutionStarted();
  now += 125;
  c.updateResult({ content: [{ type: "text", text: "x" }], isError: false });
  now += 5000;
  group.setLayerExpanded(true);
  assert.ok(plain(group.render(80)).some((line) => line.includes("↳ 1 line • 10:04:12 • 125ms (ctrl+o)")));
});

test("narrow widths wrap parent metadata, truncate calls and have no inner viewport", () => {
  const group = new RunGroup({ index: 123456, durationMs: 27000, timestamp: start }, currentTheme, true);
  group.addTool(tool("bash", { command: "a".repeat(110) }, "body"));
  for (const width of [20, 40, 79, 80, 120]) {
    const lines = group.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (width < 80) assert.ok(plain(lines).some((line) => line.includes("…")));
    assert.equal(group.childRows[0].width, width - 4);
  }
  assert.ok(!group.children.some((child) => child.constructor.name === "ScrollView"));
});

test("auxiliary rows are uncounted and commentary-only runs show no frame", () => {
  const group = new RunGroup({ index: 1 }, currentTheme, true);
  group.addCommentary(new Pi.AssistantMessageComponent(message("Note")));
  assert.deepEqual(group.render(80), []);
  group.addTool(tool("bash", {}, "body"));
  const status = new Text("Status in order", 0, 0);
  group.addRow(status);
  assert.deepEqual(group.counts, { tools: 1, notes: 1, errors: 0, completedTools: 1 });
  assert.ok(plain(group.render(80)).some((line) => line.includes("Status in order")));
  status.setText("Updated status in order");
  assert.ok(plain(group.render(80)).some((line) => line.includes("Updated status in order")));
});

test("native edit/read and complete codemode output follow D10; flat output and exclusions stay unchanged", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "visor-group-native-"));
  try {
    await writeFile(join(cwd, "edit.txt"), "before\nend\n");
    const args = { path: "edit.txt", edits: [{ oldText: "before", newText: "after" }] };
    const definition = Pi.createEditToolDefinition(cwd);
    const edit = new Pi.ToolExecutionComponent("edit", "native-edit", args, {}, definition, ui, cwd);
    edit.setArgsComplete();
    const result = await definition.execute("native-edit", args, undefined, undefined, { cwd } as never);
    edit.updateResult({ ...result, isError: false });
    const flatBefore = plain(edit.render(80));
    const group = new RunGroup({ index: 1 }, currentTheme, true);
    const view = group.addTool(edit, { timing: { timestamp: start, durationMs: 56 } });
    view.setExpanded(true);
    const lines = plain(group.render(80));
    const call = lines.findIndex((line) => line.includes("edit edit.txt"));
    assert.match(lines[call + 1], /↳ 1 line • 10:04:12 • 56ms/);
    assert.match(lines[call + 2], /edit edit.txt/);
    assert.match(lines[call + 3], /^│\s+│$/);
    assert.ok(lines.slice(call + 4).some((line) => /-1 before/.test(line)));
    assert.ok(lines.slice(call + 4).some((line) => /\+1 after/.test(line)));
    assert.ok(!lines.some((line) => /— \d\d:/.test(line)));
    for (let i = 0; i < 3; i++) { view.setExpanded(false); group.render(80); view.setExpanded(true); group.render(80); }
    const bashDefinition = Pi.createBashToolDefinition(cwd);
    const bashResult = await bashDefinition.execute("exit-fixture", { command: "printf 'failed fixture\\n'; exit 1" }, undefined, undefined, undefined as never);
    const failedBash = tool("bash", { command: "exit 1" });
    failedBash.updateResult({ ...bashResult, isError: true });
    group.addTool(failedBash, { timing: {} });
    assert.ok(plain(group.render(80)).some((line) => line.includes("Error · ↳ 2 lines · exit 1 (ctrl+o)")));
    const read = tool("read", { path: "edit.txt" }, "native read body", false, undefined, Pi.createReadToolDefinition(cwd));
    group.addTool(read).setExpanded(true);
    assert.ok(plain(group.render(80)).some((line) => line.includes("native read body")));
    const write = tool("write", { path: "write.txt", content: "native write one\nnative write two" }, "Successfully wrote fixture", false, undefined, Pi.createWriteToolDefinition(cwd));
    group.addTool(write).setExpanded(true);
    assert.ok(plain(group.render(80)).some((line) => line.includes("native write two")));
    const code = tool("codemode", { code: 'text("last output");' });
    code.updateResult({ content: [{ type: "text", text: "Script completed" }, { type: "text", text: "last output" }], isError: false });
    group.addTool(code).setExpanded(true);
    assert.ok(plain(group.render(80)).some((line) => line.includes("last output") && !line.includes("codemode")));
    view.setExpanded(false);
    group.removeChild(edit);
    assert.deepEqual(plain(edit.render(80)), flatBefore, "detaching restores flat AWE-1 shell");
    EXCLUDED.add("read");
    try {
      const excluded = tool("read", {}, "raw", false, undefined, { renderShell: "self", renderCall: () => new Text("native excluded", 0, 0), renderResult: () => new Text("native raw", 0, 0) });
      const before = plain(excluded.render(80));
      const excludedView = group.addTool(excluded);
      assert.deepEqual(plain(excludedView.render(80)), before);
    } finally { EXCLUDED.delete("read"); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
