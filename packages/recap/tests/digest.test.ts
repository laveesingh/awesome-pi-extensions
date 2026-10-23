/**
 * Pure tests: the digest never imports Pi at runtime, so these run anywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecapPrompt, digestLastTurn, shouldAutoRecap } from "../src/digest.js";

const user = (text: string, timestamp = 1000) => ({ type: "message", message: { role: "user", content: text, timestamp } });
const assistant = (content: unknown[], timestamp = 2000) => ({ type: "message", message: { role: "assistant", content, timestamp } });
const toolResult = (timestamp = 3000) => ({ type: "message", message: { role: "toolResult", content: [], timestamp } });
const text = (text: string) => ({ type: "text", text });
const call = (name: string, args?: unknown) => ({ type: "toolCall", id: `${name}-1`, name, args });

test("a tool turn digests prompt, calls, results and reply", () => {
  const d = digestLastTurn(
    [
      user("fix the flaky test"),
      assistant([call("bash", { command: "vitest run auth" }), call("edit", { path: "src/auth.ts" })]),
      toolResult(),
      toolResult(),
      assistant([text("Fixed by awaiting the mutex.")]),
    ],
    false,
  );
  assert.equal(d.empty, false);
  assert.equal(d.userPrompt, "fix the flaky test");
  assert.deepEqual(
    d.toolCalls.map((c) => c.name),
    ["bash", "edit"],
  );
  assert.ok(d.toolCalls[0].args.includes("vitest"), "argument snippets say what the call did");
  assert.equal(d.toolResults, 2);
  assert.ok(d.finalText.includes("mutex"));
  assert.equal(d.durationMs, 2000);
});

test("only the last turn is digested", () => {
  const d = digestLastTurn(
    [user("old task"), assistant([text("old reply")]), user("new task"), assistant([call("bash", { command: "ls" })])],
    false,
  );
  assert.equal(d.userPrompt, "new task");
  assert.equal(d.toolCalls.length, 1);
  assert.equal(d.finalText, "", "the previous turn's reply is not carried over");
});

test("empty and malformed entries digest to empty, never throw", () => {
  for (const entries of [[], [null, 42, "x", {}], [{ type: "message" }]]) {
    const d = digestLastTurn(entries as never[], false);
    assert.equal(d.empty, true);
    assert.equal(shouldAutoRecap(d), false);
  }
});

test("auto-recap triggers on tool use or long replies only", () => {
  assert.equal(shouldAutoRecap(digestLastTurn([user("hi"), assistant([text("ok")])], false)), false);
  assert.equal(
    shouldAutoRecap(digestLastTurn([user("hi"), assistant([text(`x`.repeat(300))])], false)),
    true,
    "long replies are worth recapping",
  );
  assert.equal(
    shouldAutoRecap(digestLastTurn([user("hi"), assistant([call("bash", {})])], false)),
    true,
    "any tool use is worth recapping",
  );
});

test("aborted runs are marked in the prompt", () => {
  const prompt = buildRecapPrompt(digestLastTurn([user("deploy"), assistant([call("bash", { command: "deploy" })])], true));
  assert.match(prompt, /interrupt/i);
});

test("the prompt stays capped on wild turns", () => {
  const calls = Array.from({ length: 50 }, (_, i) => call(`tool${i}`, { blob: "y".repeat(500) }));
  const prompt = buildRecapPrompt(
    digestLastTurn([user("go"), assistant(calls), assistant([text("z".repeat(5000))])], false),
  );
  assert.ok(prompt.length <= 3000, `prompt was ${prompt.length} chars`);
  assert.match(prompt, /Tools \(50/);
  assert.match(prompt, /more\)/);
});
