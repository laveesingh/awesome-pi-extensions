import assert from "node:assert/strict";
import { test } from "node:test";
import { recapErrorLine, recapLine, toBullets, type StatusTheme } from "../src/widget.js";

const identity: StatusTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

test("prose becomes at most three short bullets", () => {
  assert.deepEqual(toBullets("- first\n- second\n- third\n- fourth"), ["first", "second", "third"]);
  assert.deepEqual(toBullets("1. one\n2. two"), ["one", "two"]);
  assert.deepEqual(toBullets(""), []);
  const long = toBullets(`x`.repeat(500));
  assert.equal(long.length, 1);
  assert.equal(long[0], `x`.repeat(500), "bullets are never truncated; the transcript wraps");
});

test("the recap line reads like Claude Code: glyph-led, terse, cost inline", () => {
  const line = strip(recapLine(identity, ["Tests pass", "Shipped"], {
    modelId: "gpt-6-luna",
    durationMs: 1800,
    costUsd: 0.00031,
  }));
  assert.match(line, /^⎿ Recap · /);
  assert.ok(line.includes("Tests pass • Shipped"), line);
  assert.ok(line.includes("gpt-6-luna"), "short model id, no provider prefix");
  assert.ok(line.includes("2s"), line);
  assert.ok(line.includes("$0.0003"), line);
  assert.equal(line.includes("\n"), false, "status lines are single-line");
});

test("empty bullets degrade to a bare done line", () => {
  assert.match(strip(recapLine(identity, [], { modelId: "m", durationMs: 0, costUsd: 0 })), /Recap · done/);
});

test("error lines name the remedy", () => {
  const line = strip(recapErrorLine(identity, "no credentials for acme/mini"));
  assert.match(line, /^⎿ Recap · unavailable/);
  assert.match(line, /\/recap model/);
});

test("theme methods are invoked as methods (this survives)", () => {
  // Pi's theme is a Proxy around instance state; extracting fg breaks it.
  // The line builders must call theme.fg(...) so the receiver is preserved.
  const seen: unknown[] = [];
  const theme: StatusTheme = {
    fg(this: unknown, _c: string, s: string) {
      seen.push(this);
      return s;
    },
    bold(s: string) {
      return s;
    },
  };
  recapLine(theme, ["x"], { modelId: "m", durationMs: 0, costUsd: 0 });
  assert.ok(seen.length > 0 && seen.every((t) => t === theme), "fg called with the theme as receiver");
});
