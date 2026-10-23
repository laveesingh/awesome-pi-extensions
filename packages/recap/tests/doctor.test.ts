import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatDoctorReport,
  groupByProvider,
  runDoctor,
  skippedCount,
  summarizeDoctorReport,
  visibleResults,
  type DoctorProbe,
} from "../src/doctor.js";
import type { ChatModel } from "../src/chat.js";

const model = (provider: string, id: string): ChatModel => ({ provider, id });

const okProbe = (latencyMs = 100): ((m: ChatModel) => Promise<DoctorProbe>) => async () => ({
  attempts: [{ caller: "private", effort: "off" }],
  text: "doctor-ok",
  costUsd: 0.0001,
  latencyMs,
});

test("providers group alphabetically", () => {
  assert.deepEqual(
    groupByProvider([model("zeta", "a"), model("acme", "b"), model("acme", "c")]).map((g) => g.provider),
    ["acme", "zeta"],
  );
});

test("ok, adjusted, broken, credential-less and model-less providers", async () => {
  const catalog = [model("acme", "mini"), model("beta", "thinker"), model("gamma", "x"), model("delta", "y")];
  const available = [model("acme", "mini"), model("beta", "thinker"), model("gamma", "x")];
  const progress: string[] = [];
  const report = await runDoctor({
    catalog,
    available,
    onProgress: (_n, _t, provider) => void progress.push(provider),
    probe: async (m) => {
      if (m.id === "thinker") {
        return {
          attempts: [
            { caller: "private", effort: "off" },
            { caller: "private", effort: "low" },
          ],
          text: "ok",
          costUsd: 0.0002,
          latencyMs: 300,
        };
      }
      if (m.id === "x") throw new Error("subscription gone");
      return okProbe()(m);
    },
  });
  const byProvider = new Map(report.results.map((r) => [r.provider, r]));
  assert.equal(byProvider.get("acme")?.status, "ok");
  assert.deepEqual(byProvider.get("acme")?.profiles, []);
  assert.equal(byProvider.get("beta")?.status, "adjusted");
  assert.deepEqual(byProvider.get("beta")?.profiles, [{ match: "beta/*", effort: "low" }]);
  assert.equal(byProvider.get("gamma")?.status, "broken");
  assert.ok(byProvider.get("gamma")?.detail.includes("subscription gone"));
  assert.deepEqual(byProvider.get("gamma")?.profiles, []);
  assert.equal(byProvider.get("delta")?.status, "no-credentials");
  assert.deepEqual(progress, ["acme", "beta", "delta", "gamma"], "progress still visits everything");
  assert.deepEqual(
    visibleResults(report).map((r) => r.provider),
    ["acme", "beta", "gamma"],
    "credential-less providers stay out of the report",
  );
  assert.equal(skippedCount(report), 1);
});

test("report formats for the editor and the summary line", () => {
  const report = {
    at: "2026-10-22T00:00:00.000Z",
    results: [
      { provider: "acme", models: 2, status: "ok" as const, detail: "mini answered", profiles: [] },
      {
        provider: "beta",
        models: 1,
        status: "adjusted" as const,
        detail: "needs low",
        profiles: [{ match: "beta/*", effort: "low" as const }],
      },
      { provider: "gamma", models: 1, status: "broken" as const, detail: "boom", profiles: [] },
    ],
  };
  const text = formatDoctorReport(report);
  assert.ok(text.includes("acme (2 models): ok"), text);
  assert.ok(text.includes("BROKEN"), text);
  assert.ok(text.includes("Summary:"), text);
  assert.equal(summarizeDoctorReport(report), "Doctor: 1 ok, 1 adjusted (saved), 1 broken — see report.");
  assert.equal(
    summarizeDoctorReport({ at: "", results: [{ provider: "a", models: 1, status: "ok" as const, detail: "", profiles: [] }] }),
    "Doctor: 1 ok.",
  );
});

test("credential-less providers are counted, not listed", () => {
  const report = {
    at: "t",
    results: [
      { provider: "a", models: 1, status: "ok" as const, detail: "fine", profiles: [] },
      { provider: "b", models: 3, status: "no-credentials" as const, detail: "skipped", profiles: [] },
      { provider: "c", models: 2, status: "no-credentials" as const, detail: "skipped", profiles: [] },
    ],
  };
  const text = formatDoctorReport(report);
  assert.ok(text.includes("a (1 model): ok"), text);
  assert.ok(!text.includes("no credentials — skipped"), "no per-provider skip lines");
  assert.ok(text.includes("(2 providers without credentials skipped)"), text);
  assert.equal(summarizeDoctorReport(report), "Doctor: 1 ok, 2 skipped (no credentials).");
});

test("adjusted lines say what changed, why, and that it was saved", async () => {
  const report = await runDoctor({
    catalog: [{ provider: "beta", id: "thinker" }],
    available: [{ provider: "beta", id: "thinker" }],
    probe: async () => ({
      attempts: [
        { caller: "private", effort: "off", ok: false, error: "'none' is not supported. Supported: 'low'." },
        { caller: "private", effort: "low", ok: true },
      ],
      text: "ok",
      costUsd: 0,
      latencyMs: 10,
    }),
  });
  const detail = report.results[0].detail;
  assert.ok(detail.includes("needed low"), detail);
  assert.ok(detail.includes("none"), `names the evidence: ${detail}`);
  assert.ok(detail.includes("recorded"), detail);
});
