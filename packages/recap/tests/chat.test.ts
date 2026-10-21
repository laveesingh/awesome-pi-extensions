/**
 * Live integration: build a real ModelRuntime against the local agent dir and
 * list chat models. Reads local auth/catalog files only — no network refresh,
 * no model calls, no spend. Opt-in via PI_RECAP_LIVE_TEST=1 so CI stays hermetic.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PiChatBackend, pickDefaultModel } from "../src/chat.js";

const LIVE = process.env.PI_RECAP_LIVE_TEST === "1";
const skip = LIVE ? false : "set PI_RECAP_LIVE_TEST=1 to run";

test("a real runtime lists chat models", { skip }, async () => {
  const backend = new PiChatBackend();
  const models = await backend.listChatModels();
  assert.ok(Array.isArray(models), "model list resolves");
  for (const m of models) {
    assert.equal(typeof m.provider, "string");
    assert.equal(typeof m.id, "string");
  }
  const pick = pickDefaultModel(models);
  if (models.length > 0) {
    assert.ok(pick, "a default is picked whenever models exist");
    assert.ok(
      models.some((m) => m.provider === pick.provider && m.id === pick.id),
      "the default comes from the listed models",
    );
  } else {
    assert.equal(pick, null);
  }
});

test("default prefers cheap fast models", () => {
  const models = [
    { provider: "acme", id: "ultra-pro", name: "Ultra Pro" },
    { provider: "acme", id: "mini", name: "Mini" },
  ];
  assert.deepEqual(pickDefaultModel(models), models[1]);
  assert.equal(pickDefaultModel([]), null);
});
