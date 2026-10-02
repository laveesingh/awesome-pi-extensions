/**
 * Required integration tests against real Pi components and native definitions.
 * An unavailable Pi or a changed patch contract must fail, never silently skip.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import * as Pi from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { EXCLUDED, ownsTool, PASSTHROUGH } from "../src/tool-display.js";

Pi.initTheme();

before(async () => {
  const noop = () => {};
  const stub = new Proxy(
    { on: noop, off: noop, registerTool: noop },
    { get: (t, p) => (p in t ? (t as Record<string, unknown>)[p as string] : noop), set: () => true },
  );
  const { default: visor } = await import("../index.js");
  visor(stub as never);
});

const WIDTH = 160;
const ui = { requestRender() {} } as never;
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\]8;;[^\u001b]*\u001b\\/g, "").replace(/\s+$/, "");
const content = (c: Pi.ToolExecutionComponent) => c.render(WIDTH).map(strip).filter((l) => l.trim() !== "");
const footerOf = (lines: string[]) => lines.find((l) => l.trim().startsWith("↳")) ?? "";

type Definition = ConstructorParameters<typeof Pi.ToolExecutionComponent>[4];
const nativeDefinitions: Record<string, Definition> = {
  read: Pi.createReadToolDefinition(process.cwd()),
  edit: Pi.createEditToolDefinition(process.cwd()),
  write: Pi.createWriteToolDefinition(process.cwd()),
  ls: Pi.createLsToolDefinition(process.cwd()),
  find: Pi.createFindToolDefinition(process.cwd()),
};

function component(name: string, args: unknown, definition: Definition | null = nativeDefinitions[name], cwd = process.cwd(), live = true) {
  const c = new Pi.ToolExecutionComponent(name, `${name}-1`, args, {}, definition ?? undefined, ui, cwd);
  c.updateArgs(args);
  c.setArgsComplete();
  if (live) c.markExecutionStarted();
  return c;
}

function block(name: string, args: unknown, output: string, opts: { expanded?: boolean; details?: unknown } = {}) {
  const c = component(name, args);
  c.updateResult({ content: [{ type: "text", text: output }], isError: false, details: opts.details }, false);
  c.setExpanded(!!opts.expanded);
  return content(c);
}

test("the patch is installed on the component prototype", () => {
  assert.equal((Pi.ToolExecutionComponent.prototype as unknown as Record<string, unknown>).__visorToolDisplay, true);
});

test("ownership is opt-out and exclusions take precedence over passthrough", () => {
  assert.equal(EXCLUDED.size, 0);
  assert.equal(ownsTool("future_tool"), true);
  assert.equal(ownsTool(""), true);
  assert.ok(PASSTHROUGH.has("read"));
  for (const name of ["future_tool", "read"]) {
    EXCLUDED.add(name);
    try { assert.equal(ownsTool(name), false); }
    finally { EXCLUDED.delete(name); }
  }
});

test("a collapsed block is two content lines: the call line and the footer", () => {
  const lines = block("bash", { command: "ls" }, Array.from({ length: 12 }, (_, i) => `out ${i}`).join("\n"));
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[0], /bash ls/);
  assert.match(lines[1].trim(), /^↳ 12 lines • \d\d:\d\d:\d\d • \d+ms \(ctrl\+o\)$/);
});

test("unknown tools use generic renderers even if they have native renderers", () => {
  const c = component("future_tool", { a: 1 }, {
    renderShell: "self",
    renderCall: () => new Text("native call", 0, 0),
    renderResult: () => new Text("native result", 0, 0),
  });
  c.updateResult({ content: [{ type: "text", text: "output one\noutput two" }], isError: false });
  assert.equal(content(c).length, 2);
  assert.match(content(c)[0], /future_tool 1 args/);
  assert.match(footerOf(content(c)), /2 lines/);
  c.setExpanded(true);
  assert.ok(content(c).some((l) => l.includes("output two")));
  assert.ok(!content(c).some((l) => l.includes("native result")));
});

test("expanding shows the whole output", () => {
  const out = Array.from({ length: 12 }, (_, i) => `out ${i}`).join("\n");
  const lines = block("bash", { command: "ls" }, out, { expanded: true });
  for (let i = 0; i < 12; i++) assert.ok(lines.some((l) => l.includes(`out ${i}`)), `missing out ${i}`);
});

test("codemode expansion retains all text output blocks, not only the status header", () => {
  const c = component("codemode", { code: 'text("first"); text("last");' });
  c.updateResult({ content: [
    { type: "text", text: "Script completed\nOutput:" },
    { type: "text", text: "first output" },
    { type: "text", text: "last output" },
  ], isError: false });
  assert.equal(content(c).length, 2);
  assert.match(footerOf(content(c)), /4 lines/);
  c.setExpanded(true);
  assert.ok(content(c).some((l) => l.trim() === "first output"));
  assert.ok(content(c).some((l) => l.trim() === "last output"));
});

test("one line, not one lines", () => {
  assert.match(footerOf(block("bash", { command: "x" }, "only")), /↳ 1 line •/);
});

test("a JSON result puts its summary in the footer, still two lines", () => {
  const value = { id: "fixture-999", title: "Probe", state: "open" };
  const lines = block("ticket_create", { title: "Probe" }, JSON.stringify(value, null, 2), { details: { ok: true, result: value } });
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[1], /fixture-999/);
  assert.ok(!lines[1].includes("{"));
});

test("every passthrough name retains its native call and expanded result", () => {
  for (const name of PASSTHROUGH) {
    const c = component(name, {}, {
      renderCall: () => new Text(`native ${name} header\ncall preview`, 0, 0),
      renderResult: () => new Text(`native ${name} body`, 0, 0),
    });
    c.updateResult({ content: [{ type: "text", text: "raw body" }], isError: false });
    assert.equal(content(c).length, 2, name);
    assert.match(content(c)[0], new RegExp(`native ${name} header`));
    c.setExpanded(true);
    assert.ok(content(c).some((l) => l.includes(`native ${name} body`)), name);
  }
});

test("real read and write bodies remain native across repeated expansion", () => {
  for (const [name, args] of [
    ["read", { path: "fixture.txt" }],
    ["write", { path: "fixture.txt", content: "write line 0\nwrite line 1" }],
  ] as const) {
    const c = component(name, args);
    c.updateResult({ content: [{ type: "text", text: "read line 0\nread line 1" }], isError: false });
    for (let i = 0; i < 3; i++) {
      assert.equal(content(c).length, 2, content(c).join("\n"));
      c.setExpanded(true);
      assert.ok(content(c).some((l) => l.includes(`${name} line 1`)), content(c).join("\n"));
      c.setExpanded(false);
    }
  }
});

test("excluded tools retain native renderers, self shell, and fallback", () => {
  // read is also passthrough: this proves exclusion wins at every patched method.
  for (const name of ["future_tool", "read"]) {
    EXCLUDED.add(name);
    try {
      const definition = {
        renderShell: "self" as const,
        renderCall: () => new Text("native call", 0, 0),
        renderResult: () => new Text("native result", 0, 0),
      };
      const c = component(name, { a: 1 }, definition);
      c.updateResult({ content: [{ type: "text", text: "untouched output" }], isError: false });
      const methods = c as unknown as {
        getCallRenderer(): unknown; getResultRenderer(): unknown;
        getRenderShell(): string; hasRendererDefinition(): boolean;
      };
      assert.equal(methods.getCallRenderer(), definition.renderCall);
      assert.equal(methods.getResultRenderer(), definition.renderResult);
      assert.equal(methods.getRenderShell(), "self");
      assert.equal(methods.hasRendererDefinition(), true);
      assert.deepEqual(content(c), ["native call", "native result"]);
      const fallback = component(name, { a: 1 }, null);
      const fallbackMethods = fallback as unknown as { hasRendererDefinition(): boolean };
      assert.equal(fallbackMethods.hasRendererDefinition(), false);
      fallback.updateResult({ content: [{ type: "text", text: "untouched output" }], isError: false });
      assert.equal(footerOf(content(fallback)), "");
      assert.ok(content(fallback).some((l) => l.includes("untouched output")));
    } finally { EXCLUDED.delete(name); }
  }
});

test("real Pi 0.99 edit execution keeps its native diff, two collapsed lines, and one frame", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "visor-edit-"));
  try {
    await writeFile(join(cwd, "fixture.txt"), "unchanged\nbefore\nend\n");
    const args = { path: "fixture.txt", edits: [{ oldText: "before", newText: "after" }] };
    const definition = Pi.createEditToolDefinition(cwd);
    assert.equal(definition.renderShell, "self");
    const c = component("edit", args, definition, cwd);
    const result = await definition.execute("edit-1", args, undefined, undefined, { cwd } as never);
    assert.ok(result.details);
    assert.match(result.details.diff, /-2 before/);
    assert.equal(await readFile(join(cwd, "fixture.txt"), "utf8"), "unchanged\nafter\nend\n");
    c.updateResult({ ...result, isError: false });
    for (let i = 0; i < 3; i++) {
      assert.equal(content(c).length, 2, content(c).join("\n"));
      assert.match(content(c)[0], /^ edit fixture.txt$/); // one outer Box's padding
      assert.ok(!content(c).some((l) => /before|after/.test(l)));
      assert.equal(c.render(WIDTH).length, 5, "one Spacer + one Box with 2 padding rows");
      c.setExpanded(true);
      const expanded = content(c);
      assert.ok(expanded.some((l) => /-.*before/.test(l)), expanded.join("\n"));
      assert.ok(expanded.some((l) => /\+.*after/.test(l)), expanded.join("\n"));
      assert.match(expanded[0], /^ edit fixture.txt$/);
      c.invalidate();
      assert.ok(content(c).some((l) => /\+.*after/.test(l)), "native component must survive invalidation");
      c.setExpanded(false);
    }
    const rebuilt = component("edit", args, definition, cwd, false);
    rebuilt.updateResult({ ...result, isError: false });
    assert.equal(footerOf(content(rebuilt)).trim(), "↳ 1 line (ctrl+o)");
    assert.equal(content(rebuilt).length, 2);
    rebuilt.setExpanded(true);
    const restoredDiff = content(rebuilt);
    assert.ok(restoredDiff.some((line) => /-.*before/.test(line)), restoredDiff.join("\n"));
    assert.ok(restoredDiff.some((line) => /\+.*after/.test(line)), restoredDiff.join("\n"));
    assert.ok(!restoredDiff.some((line) => /•|^\s*—|\d+ms\b/.test(line)), restoredDiff.join("\n"));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("live generic and passthrough clocks start only when execution starts", (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  for (const [name, args] of [["future_tool", {}], ["read", { path: "fixture.txt" }]] as const) {
    const c = component(name, args, nativeDefinitions[name], process.cwd(), false);
    // Construction and argument rendering precede live execution. They must not
    // consume the five seconds before Pi marks this execution as started.
    now += 5000;
    c.markExecutionStarted();
    now += 1250;
    c.updateResult({ content: [{ type: "text", text: "body one\nbody two" }], isError: false });
    const collapsedFooter = footerOf(content(c));
    assert.match(collapsedFooter, /↳ 2 lines • \d\d:\d\d:\d\d • 1\.25s \(ctrl\+o\)$/);
    now += 10000;
    c.setExpanded(true);
    const expanded = content(c);
    assert.match(expanded.at(-1)!, /— \d\d:\d\d:\d\d • 1\.25s$/);
    c.setExpanded(false);
    assert.equal(footerOf(content(c)), collapsedFooter, name);
  }
});

test("rebuilt generic and passthrough blocks omit unavailable timing in both views", () => {
  for (const [name, args] of [["future_tool", {}], ["read", { path: "fixture.txt" }]] as const) {
    const c = component(name, args, nativeDefinitions[name], process.cwd(), false);
    c.updateResult({ content: [{ type: "text", text: "body one\nbody two" }], isError: false });
    for (let i = 0; i < 3; i++) {
      assert.equal(footerOf(content(c)).trim(), "↳ 2 lines (ctrl+o)");
      c.setExpanded(true);
      const expanded = content(c);
      assert.ok(expanded.some((line) => line.trim() === "body two"), expanded.join("\n"));
      assert.ok(!expanded.some((line) => /•|\d\d:\d\d:\d\d|\d+(?:\.\d+)?(?:ms|s)\b|^\s*—/.test(line)), expanded.join("\n"));
      c.invalidate();
      c.setExpanded(false);
    }
  }
});

test("rebuilt passthrough raw fallback omits the invented 0ms footer", () => {
  for (const renderResult of [undefined, () => { throw new Error("native renderer fixture failure"); }]) {
    const c = component("read", {}, { renderCall: () => new Text("native read", 0, 0), renderResult }, process.cwd(), false);
    c.updateResult({ content: [{ type: "text", text: "raw body" }], isError: false });
    assert.equal(footerOf(content(c)).trim(), "↳ 1 line (ctrl+o)");
    c.setExpanded(true);
    assert.deepEqual(content(c).map((line) => line.trim()), ["native read", "raw body"]);
  }
});

test("duration freezes when the result settles", async () => {
  const c = component("bash", { command: "x" });
  c.updateResult({ content: [{ type: "text", text: "a\nb" }], isError: false });
  const timing = (lines: string[]) => (lines.map(strip).join("\n").match(/(\d+(?:\.\d+)?)(ms|s)\b/) ?? [])[0];
  const first = timing(c.render(WIDTH));
  await new Promise((r) => setTimeout(r, 1100));
  c.setExpanded(true);
  assert.equal(timing(c.render(WIDTH)), first, "duration drifted on re-render");
});
