/**
 * Orchestrator flow with a fake chat backend: no Pi runtime, no network, no spend.
 * Recaps publish through notify(info) — Pi's showStatus path — never widgets.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, saveConfig } from "../src/config.js";
import type { ChatBackend } from "../src/chat.js";
import { Recap } from "../src/recap.js";

const turn = () => [
  { type: "message", message: { role: "user", content: "ship it" } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "1", name: "bash", args: { command: "npm test" } }],
    },
  },
  { type: "message", message: { role: "toolResult", content: [] } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "All green, shipped." }] } },
];

const okBackend = (seen: { prompt: string; model?: unknown } = { prompt: "" }): ChatBackend => ({
  listChatModels: async () => [{ provider: "acme", id: "mini", name: "Mini" }],
  listAvailableChatModels: async () => [{ provider: "acme", id: "mini", name: "Mini" }],
  complete: async (model, prompt) => {
    seen.prompt = prompt;
    seen.model = model;
    return { text: "- Tests pass\n- Shipped", costUsd: 0.0002 };
  },
});

function setup(
  backend: ChatBackend,
  branch: unknown[] = turn(),
  mode = "tui",
  model: unknown = undefined,
  registry: unknown = undefined,
  idle = true,
) {
  const agentDir = mkdtempSync(join(tmpdir(), "recap-flow-"));
  const notices: string[] = [];
  const editors: Array<{ title: string; prefill: string }> = [];
  const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    on: (event: string, handler: never) => {
      handlers.set(event, handler as never);
    },
    registerCommand: (name: string, opts: never) => {
      commands.set(name, opts as never);
    },
  };
  const ctx = {
    mode,
    model,
    modelRegistry: registry,
    sessionManager: { getBranch: () => branch },
    isIdle: () => idle,
    ui: {
      theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
      notify: (message: string) => {
        notices.push(message);
      },
      select: async () => undefined as string | undefined,
      editor: async (title: string, prefill: string) => {
        editors.push({ title, prefill });
        return undefined as string | undefined;
      },
    },
  };
  // Zero settle delay: delay behavior has dedicated tests below.
  const recap = new Recap(backend, agentDir, { settleDelayMs: 0 });
  recap.install(pi as never);
  handlers.get("session_start")!({}, ctx);
  const settle = async () => {
    await handlers.get("agent_settled")!({ aborted: false }, ctx);
    await new Promise((r) => setTimeout(r, 20));
  };
  const command = async (args: string) => {
    await commands.get("recap")!.handler(args, ctx);
  };
  const done = () => rmSync(agentDir, { recursive: true, force: true });
  const recaps = () => notices.filter((n) => n.includes("Recap"));
  return { recap, ctx, notices, recaps, editors, handlers, settle, command, agentDir, done };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test("a settled tool turn publishes one Claude-style recap line and tallies spend", async () => {
  const seen = { prompt: "" };
  const s = setup(okBackend(seen));
  try {
    await s.settle();
    assert.equal(s.recaps().length, 1, `expected exactly one recap line, got: ${s.notices.join("\n")}`);
    const line = s.recaps()[0];
    assert.match(line, /^⎿ Recap · /);
    assert.ok(line.includes("Tests pass • Shipped"), line);
    assert.ok(line.includes("$0.0002"), "per-recap cost is shown");
    assert.ok(seen.prompt.includes("bash"), "the model saw the tool calls");
    assert.equal(loadConfig(s.agentDir).spendUsd, 0.0002);
  } finally {
    s.done();
  }
});

test("without a saved model the session model is used", async () => {
  const seen: { prompt: string; model?: unknown } = { prompt: "" };
  const s = setup(okBackend(seen), turn(), "tui", { provider: "acme", id: "pro", name: "Pro" });
  try {
    await s.settle();
    assert.deepEqual(seen.model, { provider: "acme", id: "pro" });
    assert.ok(s.recaps()[0].includes("pro"), "the line names the session model");
    await s.command("status");
    assert.ok(s.notices.some((n) => n.includes("auto → acme/pro")), s.notices.join("\n"));
  } finally {
    s.done();
  }
});

test("without a saved or session model the cheapest catalog model wins", async () => {
  const seen: { prompt: string; model?: unknown } = { prompt: "" };
  const s = setup(okBackend(seen));
  try {
    await s.settle();
    assert.deepEqual(seen.model, { provider: "acme", id: "mini" });
  } finally {
    s.done();
  }
});

test("a failing session model falls back to a credentialed cheap model", async () => {
  const attempts: unknown[] = [];
  const flaky: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    listAvailableChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: async (model) => {
      attempts.push((model as { id: string }).id);
      if ((model as { id: string }).id === "pro") throw new Error("not available for this subscription");
      return { text: "- Fell back fine", costUsd: 0 };
    },
  };
  const s = setup(flaky, turn(), "tui", { provider: "acme", id: "pro" });
  try {
    await s.settle();
    assert.deepEqual(attempts, ["pro", "mini"], "tried session model, then fallback");
    assert.equal(s.recaps().length, 1);
    assert.ok(s.recaps()[0].includes("Fell back fine"), s.recaps()[0]);
    assert.ok(s.recaps()[0].includes("mini"), "the line names the model that actually answered");
  } finally {
    s.done();
  }
});

test("an explicit choice that fails reports it instead of substituting", async () => {
  const attempts: unknown[] = [];
  const failing: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    listAvailableChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: async (model) => {
      attempts.push((model as { id: string }).id);
      throw new Error("boom");
    },
  };
  const s = setup(failing);
  try {
    saveConfig(s.agentDir, { ...loadConfig(s.agentDir), model: { provider: "acme", id: "broken" } });
    await s.settle();
    assert.deepEqual(attempts, ["broken"], "explicit choice stands alone");
    assert.ok(s.recaps()[0].includes("boom"));
  } finally {
    s.done();
  }
});

test("when everything fails the first (session) error surfaces, labelled", async () => {
  const always: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    listAvailableChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: async (model) => {
      throw new Error((model as { id: string }).id === "pro" ? "session entitlement denied" : "fallback noise");
    },
  };
  const s = setup(always, turn(), "tui", { provider: "acme", id: "pro" });
  try {
    await s.settle();
    assert.equal(s.recaps().length, 1);
    assert.ok(s.recaps()[0].includes("acme/pro"), "names the model that mattered");
    assert.ok(s.recaps()[0].includes("session entitlement denied"), s.recaps()[0]);
    assert.ok(!s.recaps()[0].includes("fallback noise"), "fallback noise stays out");
  } finally {
    s.done();
  }
});

test("a busy session after the settle delay skips the recap", async () => {
  let calls = 0;
  const backend: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    listAvailableChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: async () => {
      calls++;
      return { text: "x", costUsd: 0 };
    },
  };
  const agentDir = mkdtempSync(join(tmpdir(), "recap-busy-"));
  try {
    const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
    const pi = {
      on: (event: string, handler: never) => {
        handlers.set(event, handler as never);
      },
      registerCommand: () => {},
    };
    let idle = false;
    const ctx = {
      mode: "tui",
      sessionManager: { getBranch: () => turn() },
      isIdle: () => idle,
      ui: {
        theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
        notify: () => {},
        select: async () => undefined as string | undefined,
      },
    };
    new Recap(backend, agentDir, { settleDelayMs: 5 }).install(pi as never);
    handlers.get("session_start")!({}, ctx);
    // Busy the session mid-delay: the flight must die silently, unbilled.
    setTimeout(() => void (idle = false), 1);
    await handlers.get("agent_settled")!({ aborted: false }, ctx);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 0, "no model call when the session got busy");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("turn_start aborts an in-flight recap before agent_start", async () => {
  let aborted = false;
  const releases: Array<(v: { text: string; costUsd: number }) => void> = [];
  const slow: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    listAvailableChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: (_m, _p, opts) => {
      const signal = (opts as { signal?: AbortSignal }).signal;
      signal?.addEventListener("abort", () => void (aborted = true));
      return new Promise((resolve) => void releases.push(resolve));
    },
  };
  const s = setup(slow);
  try {
    const flight = s.handlers.get("agent_settled")!({ aborted: false }, s.ctx);
    await flush();
    s.handlers.get("turn_start")!({ type: "turn_start" }, s.ctx);
    assert.equal(aborted, true, "user activity aborts the provider call");
    releases[0]?.({ text: "stale", costUsd: 0 });
    await flight;
    await flush();
    assert.equal(s.recaps().length, 0, "aborted flight publishes nothing");
  } finally {
    s.done();
  }
});

test("three straight failures stand auto-recap down with a clear message", async () => {
  const failing: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    listAvailableChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: async () => {
      throw new Error("down");
    },
  };
  const s = setup(failing);
  try {
    await s.settle();
    await s.settle();
    assert.equal(loadConfig(s.agentDir).auto, true, "not yet");
    await s.settle();
    assert.equal(loadConfig(s.agentDir).auto, false, "breaker trips");
    assert.ok(s.recaps().some((l) => l.includes("auto-recap paused")), s.recaps().join("\n"));
  } finally {
    s.done();
  }
});

test("a success resets the breaker count and manual recap bypasses it", async () => {
  let mode: "fail" | "ok" = "fail";
  const backend: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    listAvailableChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: async () => {
      if (mode === "fail") throw new Error("down");
      return { text: "- recovered", costUsd: 0 };
    },
  };
  const s = setup(backend);
  try {
    await s.settle();
    mode = "ok";
    await s.settle();
    mode = "fail";
    await s.settle();
    await s.settle();
    assert.equal(loadConfig(s.agentDir).auto, true, "a success in the middle resets the count");
    await s.settle();
    assert.equal(loadConfig(s.agentDir).auto, false, "three in a row still trips");
    // Manual recap ignores the tripped breaker (explicit user intent).
    mode = "ok";
    await s.command("");
    assert.ok(s.recaps().some((l) => l.includes("recovered")), "forced run bypasses the breaker");
  } finally {
    s.done();
  }
});

test("auto-recap off, empty turns and non-TUI modes stay silent", async () => {
  const calls: number[] = [];
  const counting: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    listAvailableChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: async () => {
      calls.push(1);
      return { text: "x", costUsd: 0 };
    },
  };
  // Empty branch.
  const s1 = setup(counting, []);
  try {
    await s1.settle();
    assert.equal(calls.length, 0);
    assert.equal(s1.recaps().length, 0);
  } finally {
    s1.done();
  }
  // Non-TUI mode.
  const s2 = setup(counting, turn(), "print" as never);
  try {
    await s2.settle();
    assert.equal(calls.length, 0);
    assert.equal(s2.recaps().length, 0);
  } finally {
    s2.done();
  }
});

test("a failing model shows an error line, never throws", async () => {
  const failing: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    listAvailableChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: async () => {
      throw new Error("no credentials for acme/mini");
    },
  };
  const s = setup(failing);
  try {
    await s.settle();
    assert.equal(s.recaps().length, 1);
    assert.ok(s.recaps()[0].includes("unavailable") && s.recaps()[0].includes("credentials"), s.recaps()[0]);
  } finally {
    s.done();
  }
});

test("a new turn supersedes an in-flight recap", async () => {
  const releases: Array<(v: { text: string; costUsd: number }) => void> = [];
  const slow: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    listAvailableChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: () => new Promise((resolve) => void releases.push(resolve)),
  };
  const s = setup(slow);
  try {
    const first = s.handlers.get("agent_settled")!({ aborted: false }, s.ctx);
    await flush();
    // No pending UI anymore: silence until the call completes.
    assert.equal(s.recaps().length, 0);
    const second = s.handlers.get("agent_settled")!({ aborted: false }, s.ctx);
    await flush();
    releases[0]({ text: "stale", costUsd: 0 });
    releases[1]({ text: "fresh", costUsd: 0 });
    await first;
    await second;
    await flush();
    const shown = s.recaps().join("\n");
    assert.ok(!shown.includes("stale"), "stale result dropped");
    assert.ok(shown.includes("fresh"), "current result published");
  } finally {
    s.done();
  }
});

test("commands: manual recap works with auto off; usage guides", async () => {
  const s = setup(okBackend());
  try {
    await s.command("auto off");
    assert.equal(loadConfig(s.agentDir).auto, false);
    await s.settle();
    assert.equal(s.recaps().length, 0, "auto off stays silent");
    await s.command("");
    assert.equal(s.recaps().length, 1, "manual /recap forces a recap");
    await s.command("status");
    assert.ok(s.notices.some((n) => n.includes("auto-recap")), s.notices.join("\n"));
    await s.command("bogus");
    assert.ok(s.notices.some((n) => n.includes("Usage")));
  } finally {
    s.done();
  }
});

test("/recap model picks provider first, then model, and saves the pick", async () => {
  const s = setup(okBackend());
  try {
    const titles: string[] = [];
    const offered: string[][] = [];
    (s.ctx.ui as { select: (t: string, o: string[]) => Promise<string | undefined> }).select = async (
      title,
      options,
    ) => {
      titles.push(title);
      offered.push(options);
      // Provider step, then the only model in it.
      return options.length > 0 && titles.length === 1 ? options[1] : options[0];
    };
    await s.command("model");
    assert.deepEqual(titles, ["Recap provider", "Recap model (acme)"]);
    assert.ok(offered[0][0].startsWith("automatic"), offered[0].join(" | "));
    assert.deepEqual(offered[0].slice(1), ["acme"], "provider step stays short");
    assert.deepEqual(loadConfig(s.agentDir).model, { provider: "acme", id: "mini" });
    assert.ok(s.notices.some((n) => n.includes("acme/mini")));
    await s.command("model clear");
    assert.equal(loadConfig(s.agentDir).model, null);
  } finally {
    s.done();
  }
});

test("cancelling either picker step leaves the saved model untouched", async () => {
  const s = setup(okBackend());
  try {
    let calls = 0;
    (s.ctx.ui as { select: (t: string, o: string[]) => Promise<string | undefined> }).select = async () => {
      calls++;
      return undefined;
    };
    await s.command("model");
    assert.equal(calls, 1, "cancel at provider step stops there");
    assert.equal(loadConfig(s.agentDir).model, null);
    (s.ctx.ui as { select: (t: string, o: string[]) => Promise<string | undefined> }).select = async (
      _t,
      options,
    ) => (options[0].startsWith("automatic") ? options[1] : undefined);
    await s.command("model");
    assert.equal(calls, 1, "no extra provider prompt");
    assert.equal(loadConfig(s.agentDir).model, null, "cancel at model step saves nothing");
  } finally {
    s.done();
  }
});

test("/recap doctor refuses to probe mid-turn", async () => {
  let calls = 0;
  const backend: ChatBackend = {
    listChatModels: async () => [],
    listAvailableChatModels: async () => [],
    complete: async () => {
      calls++;
      return { text: "x", costUsd: 0 };
    },
  };
  const s = setup(backend, turn(), "tui", undefined, undefined, false);
  try {
    await s.command("doctor");
    assert.equal(calls, 0, "no probes while busy");
    assert.equal(s.editors.length, 0);
    assert.ok(s.notices.some((n) => n.includes("in progress")));
  } finally {
    s.done();
  }
});

test("/recap doctor checks every provider, saves discoveries, shows the report", async () => {
  type Opts = { onAttempt?: (i: { caller: "session" | "private"; effort: string }) => void };
  const backend: ChatBackend = {
    listChatModels: async () => [
      { provider: "acme", id: "mini" },
      { provider: "beta", id: "thinker" },
      { provider: "gamma", id: "x" },
      { provider: "delta", id: "y" },
    ],
    listAvailableChatModels: async () => [
      { provider: "acme", id: "mini" },
      { provider: "beta", id: "thinker" },
      { provider: "gamma", id: "x" },
    ],
    complete: async (model, _prompt, opts) => {
      const id = (model as { id: string }).id;
      const onAttempt = (opts as Opts).onAttempt;
      if (id === "x") throw new Error("subscription gone");
      if (id === "thinker") {
        // Only answers at low effort: the doctor must discover that.
        onAttempt?.({ caller: "private", effort: "off" });
        onAttempt?.({ caller: "private", effort: "low" });
        return { text: "ok", costUsd: 0.0002 };
      }
      onAttempt?.({ caller: "private", effort: "off" });
      return { text: "ok", costUsd: 0.0001 };
    },
  };
  const s = setup(backend);
  try {
    await s.command("doctor");
    assert.equal(s.editors.length, 1, "full report shown");
    const report = s.editors[0];
    assert.equal(report.title, "Recap doctor");
    assert.ok(report.prefill.includes("acme") && report.prefill.includes("ok"), report.prefill);
    assert.ok(report.prefill.includes("beta") && report.prefill.includes("adjusted"), report.prefill);
    assert.ok(report.prefill.includes("gamma") && report.prefill.includes("BROKEN"), report.prefill);
    assert.ok(!report.prefill.includes("delta"), "credential-less providers get no line");
    assert.ok(report.prefill.includes("1 provider without credentials skipped"), report.prefill);
    assert.ok(
      s.notices.some((n) => n.startsWith("Doctor:") && n.includes("skipped (no credentials)")),
      s.notices.join("\n"),
    );
    assert.deepEqual(loadConfig(s.agentDir).providers, [{ match: "beta/*", effort: "low" }]);
    assert.ok(Math.abs(loadConfig(s.agentDir).spendUsd - 0.0003) < 1e-9, "probe spend tallied");
  } finally {
    s.done();
  }
});

test("/recap doctor keeps hand-written pins over its own findings", async () => {
  const backend: ChatBackend = {
    listChatModels: async () => [{ provider: "beta", id: "thinker" }],
    listAvailableChatModels: async () => [{ provider: "beta", id: "thinker" }],
    complete: async (_m, _p, opts) => {
      (opts as { onAttempt?: (i: { caller: "session" | "private"; effort: string }) => void }).onAttempt?.({
        caller: "private",
        effort: "off",
      });
      (opts as { onAttempt?: (i: { caller: "session" | "private"; effort: string }) => void }).onAttempt?.({
        caller: "private",
        effort: "low",
      });
      return { text: "ok", costUsd: 0 };
    },
  };
  const s = setup(backend);
  try {
    saveConfig(s.agentDir, { ...loadConfig(s.agentDir), providers: [{ match: "beta/*", effort: "off" }] });
    await s.command("doctor");
    assert.deepEqual(loadConfig(s.agentDir).providers, [{ match: "beta/*", effort: "off" }]);
    assert.ok(s.notices.some((n) => n.includes("Kept your pin")));
  } finally {
    s.done();
  }
});

test("disable stops everything; a fresh instance (reload) stays disabled", async () => {
  let calls = 0;
  const backend: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    listAvailableChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: async () => {
      calls++;
      return { text: "x", costUsd: 0 };
    },
  };
  const s = setup(backend);
  try {
    await s.command("disable");
    assert.equal(loadConfig(s.agentDir).enabled, false, "persisted, so reloads honor it");
    assert.ok(s.notices.some((n) => n.includes("disabled")));
    await s.settle();
    assert.equal(calls, 0, "auto recaps stop");
    await s.command("");
    assert.equal(calls, 0, "manual recaps refuse");
    assert.ok(s.notices.some((n) => n.includes("/recap enable")));
    // Simulate a Pi reload: brand-new extension runtime, same agent dir.
    const reloaded = new Recap(backend, s.agentDir, { settleDelayMs: 0 });
    (reloaded as unknown as { ctx: unknown }).ctx = s.ctx;
    await (reloaded as unknown as { onSettled: (aborted: boolean, forced: boolean) => Promise<void> }).onSettled(
      false,
      false,
    );
    assert.equal(calls, 0, "reload honors the persisted disable");
    await s.command("enable");
    assert.equal(loadConfig(s.agentDir).enabled, true);
    await s.settle();
    assert.equal(calls, 1, "re-enabled recaps run");
  } finally {
    s.done();
  }
});

test("an empty available list falls back to the full catalog", async () => {
  const fallback: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    listAvailableChatModels: async () => [],
    complete: async () => ({ text: "x", costUsd: 0 }),
  };
  const s = setup(fallback);
  try {
    (s.ctx.ui as { select: (t: string, o: string[]) => Promise<string | undefined> }).select = async (
      _t,
      options,
    ) => options[options.length - 1];
    await s.command("model");
    assert.deepEqual(loadConfig(s.agentDir).model, { provider: "acme", id: "mini" });
  } finally {
    s.done();
  }
});
