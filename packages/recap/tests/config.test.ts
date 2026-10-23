import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addSpend, configPath, defaultConfig, loadConfig, saveConfig } from "../src/config.js";

const dir = () => mkdtempSync(join(tmpdir(), "recap-config-"));

test("missing config yields defaults", () => {
  const d = dir();
  try {
    assert.deepEqual(loadConfig(d), { ...defaultConfig(), spendDay: new Date().toISOString().slice(0, 10) });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("round-trip preserves the model choice and auto flag", () => {
  const d = dir();
  try {
    saveConfig(d, { model: { provider: "acme", id: "mini" }, auto: false, enabled: true, providers: [], spendDay: "2000-01-01", spendUsd: 0 });
    const loaded = loadConfig(d);
    assert.deepEqual(loaded.model, { provider: "acme", id: "mini" });
    assert.equal(loaded.auto, false);
    assert.ok(existsSync(configPath(d)));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("corrupt or partial files degrade gracefully", () => {
  const d = dir();
  try {
    writeFileSync(configPath(d), "{not json", "utf8");
    assert.deepEqual(loadConfig(d).model, null);
    writeFileSync(configPath(d), JSON.stringify({ model: { provider: 42 }, auto: "yes" }), "utf8");
    const loaded = loadConfig(d);
    assert.equal(loaded.model, null, "malformed model is dropped");
    assert.equal(loaded.auto, true, "malformed auto falls back to on");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("spend tallies reset on a new day", () => {
  const today = new Date().toISOString().slice(0, 10);
  const a = addSpend({ ...defaultConfig(), spendDay: today, spendUsd: 0.5 }, 0.25);
  assert.equal(a.spendUsd, 0.75);
  const b = addSpend({ ...defaultConfig(), spendDay: "2000-01-01", spendUsd: 9 }, 0.25);
  assert.equal(b.spendDay, today);
  assert.equal(b.spendUsd, 0.25);
  assert.equal(addSpend(defaultConfig(), -1).spendUsd, 0, "negative costs never reduce the tally");
});
