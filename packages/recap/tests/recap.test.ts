/**
 * Orchestrator flow with a fake chat backend: no Pi runtime, no network, no spend.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
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

const okBackend = (seen: { prompt: string } = { prompt: "" }): ChatBackend => ({
  listChatModels: async () => [{ provider: "acme", id: "mini", name: "Mini" }],
  complete: async (_model, prompt) => {
    seen.prompt = prompt;
    return { text: "- Tests pass\n- Shipped", costUsd: 0.0002 };
  },
});

function setup(backend: ChatBackend, branch: unknown[] = turn(), mode = "tui") {
  const agentDir = mkdtempSync(join(tmpdir(), "recap-flow-"));
  const widgets: Array<{ id: string; lines: string[] | undefined }> = [];
  const notices: string[] = [];
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
    sessionManager: { getBranch: () => branch },
    isIdle: () => true,
    ui: {
      theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
      setWidget: (id: string, factory: (() => { render: () => string[] }) | undefined) => {
        widgets.push({ id, lines: factory?.().render() });
      },
      notify: (message: string) => {
        notices.push(message);
      },
      select: async () => undefined as string | undefined,
    },
  };
  const recap = new Recap(backend, agentDir);
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
  return { recap, ctx, widgets, notices, handlers, settle, command, agentDir, done };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test("a settled tool turn publishes pending then done, and tallies spend", async () => {
  const seen = { prompt: "" };
  const s = setup(okBackend(seen));
  try {
    await s.settle();
    assert.ok(s.widgets.length >= 2, `expected pending + done, got ${s.widgets.length}`);
    assert.match(s.widgets[0].lines![0], /Recapping/);
    const done = s.widgets[s.widgets.length - 1].lines!;
    assert.ok(done.some((l) => l.includes("Tests pass")), done.join("\n"));
    assert.ok(done[0].includes("$0.0002"), "per-recap cost is shown");
    assert.ok(seen.prompt.includes("bash"), "the model saw the tool calls");
    assert.equal(loadConfig(s.agentDir).spendUsd, 0.0002);
  } finally {
    s.done();
  }
});

test("auto-recap off, empty turns and non-TUI modes stay silent", async () => {
  const calls: number[] = [];
  const counting: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
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
    assert.equal(s1.widgets.length, 0);
  } finally {
    s1.done();
  }
  // Non-TUI mode.
  const s2 = setup(counting, turn(), "print" as never);
  try {
    await s2.settle();
    assert.equal(calls.length, 0);
    assert.equal(s2.widgets.length, 0);
  } finally {
    s2.done();
  }
});

test("a failing model shows an error widget, never throws", async () => {
  const failing: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: async () => {
      throw new Error("no credentials for acme/mini");
    },
  };
  const s = setup(failing);
  try {
    await s.settle();
    const last = s.widgets[s.widgets.length - 1].lines!;
    assert.ok(last.some((l) => l.includes("unavailable") && l.includes("credentials")), last.join("\n"));
  } finally {
    s.done();
  }
});

test("a new turn supersedes an in-flight recap", async () => {
  const releases: Array<(v: { text: string; costUsd: number }) => void> = [];
  const slow: ChatBackend = {
    listChatModels: async () => [{ provider: "acme", id: "mini" }],
    complete: () => new Promise((resolve) => void releases.push(resolve)),
  };
  const s = setup(slow);
  try {
    const first = s.handlers.get("agent_settled")!({ aborted: false }, s.ctx);
    await flush();
    assert.ok(s.widgets.length >= 1, "pending widget published");
    // Second settle aborts the first flight; releasing it must not publish.
    const second = s.handlers.get("agent_settled")!({ aborted: false }, s.ctx);
    await flush();
    releases[0]({ text: "stale", costUsd: 0 });
    releases[1]({ text: "fresh", costUsd: 0 });
    await first;
    await second;
    await flush();
    const shown = s.widgets.flatMap((w) => w.lines ?? []).join("\n");
    assert.ok(!shown.includes("stale"), "stale result dropped");
    assert.ok(shown.includes("fresh"), "current result published");
  } finally {
    s.done();
  }
});

test("commands: hide clears, model select persists, status reports", async () => {
  const s = setup(okBackend());
  try {
    await s.settle();
    await s.command("hide");
    assert.equal(s.widgets[s.widgets.length - 1].lines, undefined, "hide clears the widget");
    await s.command("status");
    assert.ok(s.notices.some((n) => n.includes("auto-recap")), s.notices.join("\n"));
    await s.command("auto off");
    assert.equal(loadConfig(s.agentDir).auto, false);
    const widgetsBefore = s.widgets.length;
    await s.settle();
    assert.equal(s.widgets.length, widgetsBefore, "auto off stays silent");
    await s.command("bogus");
    assert.ok(s.notices.some((n) => n.includes("Usage")));
  } finally {
    s.done();
  }
});

test("/recap model offers the backend list and saves the pick", async () => {
  const s = setup(okBackend());
  try {
    let offered: string[] = [];
    (s.ctx.ui as { select: (t: string, o: string[]) => Promise<string | undefined> }).select = async (
      _t,
      options,
    ) => {
      offered = options;
      return options[1];
    };
    await s.command("model");
    assert.ok(offered[0].startsWith("automatic"), offered.join(" | "));
    assert.deepEqual(loadConfig(s.agentDir).model, { provider: "acme", id: "mini" });
    assert.ok(s.notices.some((n) => n.includes("acme/mini")));
    await s.command("model clear");
    assert.equal(loadConfig(s.agentDir).model, null);
  } finally {
    s.done();
  }
});
