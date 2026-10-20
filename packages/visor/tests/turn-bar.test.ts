/**
 * Turn-bar coalescing: a widget update rebuilds Pi's widget container and
 * requests a full transcript render, so streaming deltas must not each publish
 * one. Deltas are throttled and identical lines are skipped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ThinkingManager } from "../src/thinking.js";
import { TurnBar } from "../src/turn-bar.js";

const FIXED_NOW = 1_700_000_000_000;

function setup() {
  const widgets: Array<unknown> = [];
  const handlers = new Map<string, (e: unknown, ctx: unknown) => void>();
  const pi = { on: (event: string, handler: never) => { handlers.set(event, handler as never); } };
  const ctx = {
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_c: string, s: string) => s },
      setWidget: (_id: string, content: unknown) => { widgets.push(content); },
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setWorkingMessage: () => {},
    },
  };
  const bar = new TurnBar(new ThinkingManager());
  bar.install(pi as never);
  const contentWidgets = () => widgets.filter((w) => w !== undefined);
  return { handlers, ctx, bar, contentWidgets };
}

function withFixedTime<T>(fn: () => T): T {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

const textDelta = (delta: string) => ({
  message: {},
  assistantMessageEvent: { type: "text_delta", delta },
});

test("rapid deltas publish at most one widget update per throttle window", () => {
  const { handlers, ctx, contentWidgets } = withFixedTime(() => {
    const s = setup();
    s.handlers.get("agent_start")!({}, s.ctx);
    // 8-char deltas move the token estimate (2 -> 4), so without throttling
    // each delta would publish a distinct line.
    s.handlers.get("message_update")!(textDelta("xxxxxxxx"), s.ctx);
    s.handlers.get("message_update")!(textDelta("xxxxxxxx"), s.ctx);
    s.handlers.get("session_shutdown")!({}, s.ctx);
    return s;
  });
  void handlers;
  void ctx;
  // agent_start tick + first delta tick; the second delta is throttled.
  assert.equal(contentWidgets().length, 2);
});

test("an unchanged line never republishes the widget", () => {
  const { bar, ctx, contentWidgets } = withFixedTime(() => {
    const s = setup();
    s.handlers.get("agent_start")!({}, s.ctx);
    (s.bar as unknown as { tick: () => void }).tick();
    (s.bar as unknown as { tick: () => void }).tick();
    s.handlers.get("session_shutdown")!({}, s.ctx);
    return s;
  });
  void bar;
  void ctx;
  // agent_start's own tick publishes once; the two manual ticks are identical.
  assert.equal(contentWidgets().length, 1);
});
