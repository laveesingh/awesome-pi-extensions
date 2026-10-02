import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import * as Pi from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { RunGroup } from "../src/run-group.js";
import { patchToolExecutionComponent } from "../src/tool-display.js";
const tm = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
Pi.initTheme("dark");
const ui = { requestRender() {} } as never;
before(() => { assert.ok(patchToolExecutionComponent()); assert.equal(tm.theme.name, "dark"); });
function title(component: Pi.ToolExecutionComponent) {
  return component.render(80).find((line) => /^(bash|read|edit) /.test(stripTerminalSequences(line).trim()))!;
}
function plainMuted(line: string, text: string) {
  assert.equal(stripTerminalSequences(line).trim(), text);
  assert.ok(line.includes(tm.theme.getFgAnsi("muted")));
  assert.ok(!line.includes("\x1b[1m"), "repeated line must not be bold");
  assert.ok(!line.includes(tm.theme.getFgAnsi("accent")), "repeated args must not be accent");
  assert.ok(!line.includes(tm.theme.getFgAnsi("toolTitle")), "repeated name must not be title color");
  assert.ok(!line.includes("\x1b]8;"), "the plain repeat has no native hyperlink payload");
}
for (const pending of [false, true]) {
  test(`grouped generic repeated call is plain semantic muted; first/flat call stays native (${pending ? "pending" : "settled"})`, () => {
    const c = new Pi.ToolExecutionComponent("bash", "repeat", { command: "printf fixture" }, {}, undefined, ui, process.cwd());
    if (!pending) c.updateResult({ content: [{ type: "text", text: "fixture body" }], isError: false });
    const first = title(c);
    const g = new RunGroup({ index: 1 }, () => tm.theme, true);
    const view = g.addTool(c, { timing: {} }); view.setExpanded(true);
    const lines = view.render(80);
    assert.equal(lines[0], first, "first styled call is byte-for-byte unchanged");
    plainMuted(lines[2], "bash printf fixture");
    if (!pending) assert.ok(stripTerminalSequences(lines[4]).includes("fixture body"));
    view.setExpanded(false); g.removeChild(c);
    assert.equal(title(c), first, "flat styling unchanged after detach");
  });
}

test("native read/edit repeated calls are plain muted while body/diff colors and first call survive", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "visor-repeat-"));
  try {
    await writeFile(join(cwd, "fixture.txt"), "before\nend\n");
    const editArgs = { path: "fixture.txt", edits: [{ oldText: "before", newText: "after" }] };
    const definition = Pi.createEditToolDefinition(cwd);
    const edit = new Pi.ToolExecutionComponent("edit", "edit-repeat", editArgs, {}, definition, ui, cwd);
    edit.setArgsComplete();
    const result = await definition.execute("edit-repeat", editArgs, undefined, undefined, { cwd } as never);
    edit.updateResult({ ...result, isError: false });
    const first = title(edit);
    const g = new RunGroup({ index: 1 }, () => tm.theme, true);
    const view = g.addTool(edit, { timing: {} }); view.setExpanded(true);
    const lines = view.render(80);
    assert.equal(lines[0], first);
    plainMuted(lines[2], "edit fixture.txt");
    const added = lines.find((line) => /\+1 after/.test(stripTerminalSequences(line)))!;
    const removed = lines.find((line) => /-1 before/.test(stripTerminalSequences(line)))!;
    assert.ok(added.includes(tm.theme.getFgAnsi("toolDiffAdded")), "native additions retain diff color");
    assert.ok(removed.includes(tm.theme.getFgAnsi("toolDiffRemoved")), "native removals retain diff color");
    const read = new Pi.ToolExecutionComponent("read", "read-repeat", { path: "fixture.txt" }, {}, Pi.createReadToolDefinition(cwd), ui, cwd);
    read.updateResult({ content: [{ type: "text", text: "native read body" }], isError: false });
    const readFirst = title(read);
    const readView = g.addTool(read, { timing: {} }); readView.setExpanded(true);
    const readLines = readView.render(80);
    assert.equal(readLines[0], readFirst); plainMuted(readLines[2], "read fixture.txt");
    assert.ok(readLines.some((line) => stripTerminalSequences(line).includes("native read body") && line.includes(tm.theme.getFgAnsi("toolOutput"))));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
