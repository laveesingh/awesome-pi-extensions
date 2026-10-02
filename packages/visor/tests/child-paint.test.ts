import assert from "node:assert/strict";
import { test, before } from "node:test";
import * as Pi from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { continuousChildPaint } from "../src/child-paint.js";
import { RunGroup } from "../src/run-group.js";
import { patchToolExecutionComponent } from "../src/tool-display.js";
const tm = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
Pi.initTheme("dark");
before(() => { assert.equal(tm.theme.name, "dark"); assert.ok(patchToolExecutionComponent()); });

// Independent cell-style oracle; preserves explicit default colors and inverse.
function cells(line: string) {
  const out: Array<{ char: string; fg: string; bg: string; inverse: boolean; bold: boolean }> = [];
  let fg = "39", bg = "49", inverse = false, bold = false;
  for (const token of line.match(/\x1b\[[\d;]*m|\x1b\][^\x07]*?(?:\x07|\x1b\\)|[^\x1b]+/g) ?? []) {
    const match = /^\x1b\[([\d;]*)m$/.exec(token);
    if (!match) { if (!token.startsWith("\x1b")) for (const char of token) out.push({ char, fg, bg, inverse, bold }); continue; }
    const p = (match[1] || "0").split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      const n = p[i];
      if (n === 38 || n === 48) {
        const end = i + (p[i + 1] === 5 ? 3 : 5);
        const color = p.slice(i, end).join(";");
        if (n === 38) fg = color; else bg = color;
        i = end - 1;
      } else if (n === 0) { fg = "39"; bg = "49"; inverse = bold = false; }
      else if (n === 39 || (n >= 30 && n <= 37) || (n >= 90 && n <= 97)) fg = String(n);
      else if (n === 49 || (n >= 40 && n <= 47) || (n >= 100 && n <= 107)) bg = String(n);
      else if (n === 1) bold = true; else if (n === 22) bold = false;
      else if (n === 7) inverse = true; else if (n === 27) inverse = false;
    }
  }
  return out;
}
const color = (ansi: string) => ansi.slice(2, -1);
const ui = { requestRender() {} } as never;
for (const state of ["pending", "success", "error"] as const) {
  test(`actual dark ${state} header ellipsis and right pad retain native FG/BG only inside grouped child`, () => {
    const c = new Pi.ToolExecutionComponent("bash", `paint-${state}`, { command: "printf " + "long-native-argument-".repeat(12) }, {}, Pi.createBashToolDefinition(process.cwd()), ui, process.cwd());
    if (state !== "pending") c.updateResult({ content: [{ type: "text", text: "native body" }], isError: state === "error" });
    const flat = c.render(76);
    const g = new RunGroup({ index: 1, live: state === "pending" }, () => tm.theme, true);
    const view = g.addTool(c, { timing: {} });
    const native = c.render(76)[1];
    const raw = cells(native);
    const repaired = view.render(76)[0]; const fixed = cells(repaired);
    const e = raw.findIndex((cell) => cell.char === "…"); assert.ok(e > 0);
    assert.equal(raw[e].fg, "39"); assert.equal(raw[e].bg, "49", "reproduce U4 native notch");
    const fg = color(tm.theme.getFgAnsi("accent"));
    const bg = color(tm.theme.getBgAnsi(state === "pending" ? "toolPendingBg" : state === "error" ? "toolErrorBg" : "toolSuccessBg"));
    assert.equal(raw[e - 1].fg, fg);
    assert.deepEqual(fixed.slice(0, e), raw.slice(0, e), "native title/argument styles untouched before reset");
    for (const cell of fixed.slice(e)) { assert.equal(cell.fg, fg); assert.equal(cell.bg, bg); }
    assert.equal(stripTerminalSequences(repaired), stripTerminalSequences(native)); assert.equal(visibleWidth(repaired), 76);
    const outside = cells(repaired + " | ").slice(-3);
    assert.ok(outside.every((cell) => cell.bg === "49" && cell.fg === "39"), "no child paint escapes");
    const frame = g.render(80); assert.deepEqual(g.render(80), frame, "cached frame unchanged");
    const row = frame.find((line) => stripTerminalSequences(line).includes("bash printf"))!;
    const fc = cells(row); assert.equal(fc.length, 80);
    assert.equal(fc[76].char, "…"); assert.equal(fc[77].bg, bg); assert.equal(fc[76].fg, fg); assert.equal(fc[77].fg, fg);
    for (const n of [0, 1, 78, 79]) assert.equal(fc[n].bg, "49", `frame cell ${n + 1} has no child background`);
    assert.equal(fc[79].fg, color(tm.theme.getFgAnsi("borderMuted")));
    g.removeChild(c); assert.deepEqual(c.render(76), flat, "flat byte output unchanged on detach");
  });
}

test("SGR 0/49 restore colors without restoring bold/inverse; payload 49/0 and OSC stay untouched", () => {
  const bg = "48;2;49;0;17", fg = "38;5;49";
  const line = `\x1b[${bg}m\x1b[${fg}m\x1b[1;7mA\x1b[0m…\x1b[49m \x1b[49m`;
  const fixed = cells(continuousChildPaint(line));
  assert.equal(fixed[0].bold, true); assert.equal(fixed[0].inverse, true);
  for (const cell of fixed.slice(1)) { assert.equal(cell.bg, bg); assert.equal(cell.fg, fg); assert.equal(cell.bold, false); assert.equal(cell.inverse, false); }
  const noReset = `\x1b[${bg}m\x1b[${fg}mA\x1b[39;49m`;
  assert.equal(continuousChildPaint(noReset), noReset);
  const osc = `\x1b]8;;file:///49\x1b\\`;
  assert.ok(continuousChildPaint(osc + line).startsWith(osc));
  assert.equal(continuousChildPaint("\x1b[31mplain\x1b[0m text"), "\x1b[31mplain\x1b[0m text", "no native background means no repair");
  const compound = cells(continuousChildPaint(`\x1b[42;31mA\x1b[0;34mB\x1b[49mC\x1b[49m`));
  assert.equal(compound[1].fg, "34"); assert.equal(compound[2].fg, "34"); assert.equal(compound[2].bg, "42");
});
