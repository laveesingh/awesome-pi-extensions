import assert from "node:assert/strict";
import { test } from "node:test";
import { doneLines, errorLines, pendingLines, toBullets, type WidgetTheme } from "../src/widget.js";

const identity: WidgetTheme = { fg: (_c, s) => s, bold: (s) => s };

test("prose becomes at most three short bullets", () => {
  assert.deepEqual(toBullets("- first\n- second\n- third\n- fourth"), ["• first", "• second", "• third"]);
  assert.deepEqual(toBullets("1. one\n2. two"), ["• one", "• two"]);
  assert.deepEqual(toBullets(""), []);
  const long = toBullets(`x`.repeat(500));
  assert.equal(long.length, 1);
  assert.ok(long[0].length <= 115, "bullets stay widget-width");
});

test("pending, done and error states fit Pi's 10-line widget cap", () => {
  assert.ok(pendingLines(identity, "acme/mini").length <= 10);
  const done = doneLines(identity, ["• a", "• b", "• c"], {
    modelLabel: "acme/mini",
    durationMs: 1800,
    costUsd: 0.00031,
    todayUsd: 0.001,
  });
  assert.ok(done.length <= 6);
  assert.match(done[0], /Recap/);
  assert.match(done[0], /\$0\.0003/);
  assert.ok(errorLines(identity, "boom").length <= 10);
  assert.match(errorLines(identity, "boom")[0], /unavailable/);
});

test("theme methods are invoked as methods (this survives)", () => {
  // Pi's theme is a Proxy around instance state; extracting fg breaks it.
  // The widget must call theme.fg(...) so the receiver is preserved.
  const seen: unknown[] = [];
  const theme: WidgetTheme = {
    fg(this: unknown, _c: string, s: string) {
      seen.push(this);
      return s;
    },
    bold(s: string) {
      return s;
    },
  };
  pendingLines(theme, "acme/mini");
  assert.ok(seen.length > 0 && seen.every((t) => t === theme), "fg called with the theme as receiver");
});
