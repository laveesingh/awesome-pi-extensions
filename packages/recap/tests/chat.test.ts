/**
 * Live integration: build a real ModelRuntime against the local agent dir and
 * list chat models. Reads local auth/catalog files only — no network refresh,
 * no model calls, no spend. Opt-in via PI_RECAP_LIVE_TEST=1 so CI stays hermetic.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isReasoningRejected, needsEffortFallback, PiChatBackend, pickDefaultModel, sessionHeaders } from "../src/chat.js";

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

const reasoningError = (msg: string) => ({
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: msg,
});
const textResult = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  usage: { cost: { total: 0.0001 } },
});

class StubBackend extends PiChatBackend {
  constructor(
    run: (model: unknown, context: unknown, options: { reasoning?: string }) => Promise<unknown>,
    private readonly stubModel: unknown = { provider: "acme", id: "thinker" },
    profiles: Array<{ match: string; effort: "off" | "low" }> = [],
  ) {
    super(run as never, profiles);
  }
  protected override async resolveModelRef(): Promise<unknown> {
    return this.stubModel;
  }
}

test("isReasoningRejected spots effort-level rejections", () => {
  assert.equal(isReasoningRejected(reasoningError("Unsupported value: 'none' is not supported")), true);
  assert.equal(isReasoningRejected(reasoningError("reasoning.effort invalid")), true);
  assert.equal(isReasoningRejected({ stopReason: "error", errorMessage: "overloaded" }), false);
  assert.equal(isReasoningRejected(textResult("hi")), false);
  assert.equal(isReasoningRejected(null), false);
});

test("a reasoning rejection retries once at provider-default effort", async () => {
  const seen: Array<{ reasoning?: string }> = [];
  const backend = new StubBackend(async (_m, _c, options) => {
    seen.push({ reasoning: options.reasoning });
    return seen.length === 1
      ? reasoningError("'none' is not supported. Supported: 'low', 'medium', 'high'.")
      : textResult("- done");
  });
  const result = await backend.complete({ provider: "acme", id: "thinker" }, "prompt", { maxTokens: 10 });
  assert.equal(result.text, "- done");
  assert.deepEqual(seen.map((s) => s.reasoning), ["off", "low"]);
});

test("remembered rejections skip the doomed call next time", async () => {
  let runs = 0;
  const backend = new StubBackend(async () => {
    runs++;
    return runs === 1
      ? reasoningError("'none' is not supported")
      : textResult("fine");
  }, { provider: "acme", id: "memo" });
  await backend.complete({ provider: "acme", id: "memo" }, "p", { maxTokens: 10 });
  assert.equal(runs, 2);
  await backend.complete({ provider: "acme", id: "memo" }, "p", { maxTokens: 10 });
  assert.equal(runs, 3, "second recap goes straight to default effort");
});

test("provider errors surface verbatim instead of 'empty reply'", async () => {
  const backend = new StubBackend(async () => reasoningError("upstream exploded, try later"));
  await assert.rejects(
    backend.complete({ provider: "acme", id: "x" }, "p", { maxTokens: 10 }),
    /upstream exploded/,
  );
  const silent = new StubBackend(async () => ({ role: "assistant", content: [] }));
  await assert.rejects(silent.complete({ provider: "acme", id: "x" }, "p", { maxTokens: 10 }), /empty reply/);
});

const sessionWith = (impl: Partial<{ complete: never; find: never }> = {}) => ({
  complete: (async () => ({ role: "assistant", content: [{ type: "text", text: "session voice" }] })) as never,
  find: (() => ({ provider: "acme", id: "m", source: "session" })) as never,
  ...impl,
});

test("the session registry is preferred and the private runtime stays idle", async () => {
  let sessionCalls = 0;
  let ownCalls = 0;
  const backend = new StubBackend(async () => {
    ownCalls++;
    return textResult("own");
  });
  const result = await backend.complete({ provider: "acme", id: "m" }, "p", {
    maxTokens: 10,
    session: sessionWith({
      complete: (async () => {
        sessionCalls++;
        return textResult("session voice");
      }) as never,
      find: (() => ({ provider: "acme", id: "m", source: "session" })) as never,
    }),
  });
  assert.equal(result.text, "session voice");
  assert.equal(sessionCalls, 1);
  assert.equal(ownCalls, 0);
});

test("a session find miss falls back to private resolution", async () => {
  let ownCalls = 0;
  const backend = new StubBackend(async () => {
    ownCalls++;
    return textResult("own");
  });
  const result = await backend.complete({ provider: "acme", id: "m" }, "p", {
    maxTokens: 10,
    session: sessionWith({ find: (() => undefined) as never }),
  });
  assert.equal(result.text, "own");
  assert.equal(ownCalls, 1);
});

test("a session-path failure still gets one private attempt", async () => {
  let ownCalls = 0;
  const backend = new StubBackend(async () => {
    ownCalls++;
    return textResult("private save");
  });
  const result = await backend.complete({ provider: "acme", id: "m" }, "p", {
    maxTokens: 10,
    session: sessionWith({
      complete: (async () => {
        throw new Error("subscription gone");
      }) as never,
    }),
  });
  assert.equal(result.text, "private save");
  assert.equal(ownCalls, 1);
});

test("when both paths fail the session error surfaces", async () => {
  const backend = new StubBackend(async () => {
    throw new Error("private exploded");
  });
  await assert.rejects(
    backend.complete({ provider: "acme", id: "m" }, "p", {
      maxTokens: 10,
      session: sessionWith({
        complete: (async () => {
          throw new Error("session entitlement denied");
        }) as never,
      }),
    }),
    /session entitlement denied/,
  );
});

test("opencode-family models get session headers, others do not", () => {
  assert.deepEqual(sessionHeaders({ provider: "opencode-go", id: "x" }, "sess-1"), {
    "x-opencode-session": "sess-1",
    "x-opencode-client": "pi",
  });
  assert.deepEqual(sessionHeaders({ provider: "opencode", id: "x" }, "sess-1")?.["x-opencode-session"], "sess-1");
  assert.deepEqual(
    sessionHeaders({ provider: "proxy", id: "x", baseUrl: "https://opencode.ai/inference" }, "s")?.["x-opencode-session"],
    "s",
    "host match covers custom gateway entries",
  );
  assert.equal(sessionHeaders({ provider: "acme", id: "x" }, "sess-1"), undefined);
  assert.equal(sessionHeaders({ provider: "opencode-go", id: "x" }, undefined), undefined);
  assert.equal(sessionHeaders({ provider: "opencode-go", id: "x", baseUrl: "::bad" }, "s")?.["x-opencode-session"], "s");
  assert.equal(sessionHeaders(null, "s"), undefined);
});

test("session headers ride along on the call", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const backend = new StubBackend(async (_m, _c, options) => {
    seen.push(options as Record<string, unknown>);
    return textResult("fine");
  }, { provider: "opencode-go", id: "muse" });
  await backend.complete({ provider: "opencode-go", id: "muse" }, "p", { maxTokens: 10, sessionId: "sess-9" });
  assert.deepEqual((seen[0].headers as Record<string, string>)["x-opencode-session"], "sess-9");
  const plain: Array<Record<string, unknown>> = [];
  const backend2 = new StubBackend(async (_m, _c, options) => {
    plain.push(options as Record<string, unknown>);
    return textResult("fine");
  }, { provider: "acme", id: "m" });
  await backend2.complete({ provider: "acme", id: "m" }, "p", { maxTokens: 10, sessionId: "sess-9" });
  assert.ok(!("headers" in plain[0]), "no headers for other providers");
});

test("silent budget-eating (length stop, thinking present) retries at low", async () => {
  const seen: Array<{ reasoning?: string }> = [];
  const backend = new StubBackend(async (_m, _c, options) => {
    seen.push({ reasoning: options.reasoning });
    return seen.length === 1
      ? { role: "assistant", content: [{ type: "thinking", thinking: "hmm".repeat(300) }], stopReason: "length" }
      : textResult("- recovered");
  }, { provider: "acme", id: "thinkysilent" });
  const result = await backend.complete({ provider: "acme", id: "thinkysilent" }, "p", { maxTokens: 10 });
  assert.equal(result.text, "- recovered");
  assert.deepEqual(seen.map((s) => s.reasoning), ["off", "low"]);
});

test("needsEffortFallback only fires on evidence, never on plain emptiness", () => {
  assert.equal(needsEffortFallback({ stopReason: "length", content: [] }, true), true);
  assert.equal(
    needsEffortFallback({ stopReason: "stop", content: [{ type: "thinking", thinking: "x" }] }, true),
    true,
  );
  assert.equal(needsEffortFallback({ stopReason: "stop", content: [] }, true), false);
  assert.equal(needsEffortFallback({ stopReason: "stop", content: [{ type: "text", text: "hi" }] }, false), false);
  assert.equal(needsEffortFallback(null, true), false);
});

test("a static profile skips the doomed discovery call", async () => {
  const seen: Array<{ reasoning?: string }> = [];
  const backend = new StubBackend(
    async (_m, _c, options) => {
      seen.push({ reasoning: options.reasoning });
      return textResult("profiled");
    },
    { provider: "acme", id: "thinker" },
    [{ match: "acme/*", effort: "low" }],
  );
  const result = await backend.complete({ provider: "acme", id: "thinker" }, "p", { maxTokens: 10 });
  assert.equal(result.text, "profiled");
  assert.deepEqual(seen.map((s) => s.reasoning), ["low"], "no off attempt at all");
});

test("per-call profiles beat constructor profiles", async () => {
  const seen: Array<{ reasoning?: string }> = [];
  const backend = new StubBackend(
    async (_m, _c, options) => {
      seen.push({ reasoning: options.reasoning });
      return textResult("fine");
    },
    { provider: "acme", id: "thinker" },
    [{ match: "acme/*", effort: "low" }],
  );
  await backend.complete({ provider: "acme", id: "thinker" }, "p", {
    maxTokens: 10,
    profiles: [{ match: "acme/*", effort: "off" }],
  });
  assert.deepEqual(seen.map((s) => s.reasoning), ["off"]);
});

test("attempts report caller, effort and outcome for observers", async () => {
  const seen: Array<{ caller: string; effort: string; ok?: boolean; error?: string }> = [];
  const backend = new StubBackend(async () => textResult("fine"));
  await backend.complete({ provider: "acme", id: "mock" }, "p", {
    maxTokens: 10,
    onAttempt: (info) => seen.push(info),
  });
  assert.deepEqual(seen, [{ caller: "private", effort: "off", ok: true }]);
});

test("failed attempts report the provider message", async () => {
  const seen: Array<{ caller: string; effort: string; ok?: boolean; error?: string }> = [];
  const backend = new StubBackend(async () => {
    throw new Error("gateway exploded");
  });
  await assert.rejects(
    backend.complete({ provider: "acme", id: "mock" }, "p", {
      maxTokens: 10,
      onAttempt: (info) => seen.push(info),
    }),
    /gateway exploded/,
  );
  assert.deepEqual(seen, [{ caller: "private", effort: "off", ok: false, error: "gateway exploded" }]);
});

test("default prefers cheap fast models", () => {
  const models = [
    { provider: "acme", id: "ultra-pro", name: "Ultra Pro" },
    { provider: "acme", id: "mini", name: "Mini" },
  ];
  assert.deepEqual(pickDefaultModel(models), models[1]);
  assert.equal(pickDefaultModel([]), null);
});
