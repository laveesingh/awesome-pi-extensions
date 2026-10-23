import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CURATED_PROFILES,
  isValidProfile,
  profileMatches,
  resolveProfile,
} from "../src/providers.js";

test("glob matching: provider, provider/id and wildcards", () => {
  assert.equal(profileMatches("acme/*", "acme", "mini"), true);
  assert.equal(profileMatches("acme/mini", "acme", "mini"), true);
  assert.equal(profileMatches("acme/mini", "acme", "pro"), false);
  assert.equal(profileMatches("acme", "acme", "anything"), true, "bare provider matches all its models");
  assert.equal(profileMatches("*/mini", "acme", "mini"), true);
  assert.equal(profileMatches("acme/*", "other", "mini"), false);
  // Dots and special chars are literal, not regex.
  assert.equal(profileMatches("acme/*", "acmeX", "mini"), false);
});

test("first match wins: user overrides precede curated defaults", () => {
  const profiles = [{ match: "acme/*", effort: "off" as const }, ...CURATED_PROFILES];
  assert.deepEqual(resolveProfile(profiles, "acme", "mini"), { match: "acme/*", effort: "off" });
  assert.equal(resolveProfile([], "acme", "mini"), null);
});

test("curated defaults are valid and resolve the proven quirks", () => {
  for (const p of CURATED_PROFILES) assert.ok(isValidProfile(p), JSON.stringify(p));
  assert.equal(resolveProfile(CURATED_PROFILES, "codex-proxy", "gpt-6.1-sol")?.effort, "low");
  assert.equal(resolveProfile(CURATED_PROFILES, "rakuten-ai", "GLM-5.3")?.effort, "low");
  assert.equal(resolveProfile(CURATED_PROFILES, "acme", "mini"), null);
});

test("invalid profiles never match", () => {
  for (const bad of [null, undefined, {}, { match: "" }, { match: "x" }, { match: "x", effort: "high" }]) {
    assert.equal(isValidProfile(bad), false);
    assert.equal(resolveProfile([bad] as never[], "x", "y"), null);
  }
});
