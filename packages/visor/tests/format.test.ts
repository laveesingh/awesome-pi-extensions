/**
 * Pure tests: no Pi, no TUI. These cover the logic that decides what a collapsed
 * block says.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactResult, formatDurShort, formatTokensShort, wrapPlain } from "../src/format.js";

const asResult = (text: string, details?: unknown) => ({
	content: [{ type: "text", text }],
	details,
});

test("plain text is not summarised — it keeps its line preview", () => {
	assert.equal(compactResult(asResult("hello\nworld"), "hello\nworld"), null);
	assert.equal(compactResult(asResult(""), ""), null);
});

test("a JSON object collapses to identity, title and state", () => {
	const value = { id: "GOL-264", title: "Compact tool output", state: "done", kind: "spec" };
	const text = JSON.stringify(value, null, 2);
	const summary = compactResult(asResult(text), text);
	assert.ok(summary);
	assert.match(summary, /GOL-264/);
	assert.match(summary, /done/);
	assert.match(summary, /spec/);
});

test("an array collapses to a count plus ids, not full descriptions", () => {
	const value = [
		{ id: "GOL-1", title: "A long title that must not appear in full", state: "open" },
		{ id: "GOL-2", title: "Another long title", state: "open" },
	];
	const text = JSON.stringify(value, null, 2);
	const summary = compactResult(asResult(text), text)!;
	assert.match(summary, /^2 items/);
	assert.match(summary, /GOL-1, GOL-2/);
	assert.ok(!summary.includes("must not appear"), "titles do not belong in a list summary");
});

test("an empty array says none", () => {
	assert.equal(compactResult(asResult("[]"), "[]"), "none");
});

test("identity wins over a nested comments array", () => {
	// ticket_get returns the ticket itself WITH a nested comments array and no
	// wrapper. Diving into the array first described the comments, not the ticket.
	const value = {
		id: "GOL-264",
		title: "Compact tool output",
		state: "done",
		comments: [{ id: "c1", body: "hi" }, { id: "c2", body: "there" }],
	};
	const text = JSON.stringify(value, null, 2);
	const summary = compactResult(asResult(text), text)!;
	assert.match(summary, /GOL-264/);
	assert.ok(!summary.startsWith("2 items"), "must describe the ticket, not its comments");
});

test("a true wrapper is unwrapped", () => {
	const value = { ticket: { id: "GOL-9", title: "Wrapped", state: "open" } };
	const text = JSON.stringify(value, null, 2);
	assert.match(compactResult(asResult(text), text)!, /GOL-9/);
});

test("truncated JSON falls back to details.result", () => {
	// The golem bridge truncates tool text at 30_000 chars and appends a marker,
	// so a large payload arrives as INVALID JSON while details.result is intact.
	const full = [{ id: "GOL-1" }, { id: "GOL-2" }, { id: "GOL-3" }];
	const truncated = `${JSON.stringify(full, null, 2).slice(0, 40)}\n… output truncated`;
	assert.throws(() => JSON.parse(truncated), "the fixture must really be invalid JSON");

	assert.equal(compactResult(asResult(truncated), truncated), null, "no details: nothing to say");
	const summary = compactResult(asResult(truncated, { ok: true, result: full }), truncated)!;
	assert.match(summary, /^3 items/);
});

test("a human label beats an opaque uuid in a list", () => {
	const value = [
		{ session_id: "01a046f4-333c-79b8-b31e-6ee71e739e00", label: "worker0" },
		{ session_id: "01a046f4-333c-79b8-b31e-6ee71e739e01", label: "worker1" },
	];
	const text = JSON.stringify(value, null, 2);
	const summary = compactResult(asResult(text), text)!;
	assert.match(summary, /worker0, worker1/);
	assert.ok(!summary.includes("01a046f4"), "uuids do not fit on the footer line");
});

test("the summary stays short enough to share the footer line", () => {
	const value = Array.from({ length: 40 }, (_, i) => ({ id: `GOL-${100 + i}` }));
	const text = JSON.stringify(value, null, 2);
	const summary = compactResult(asResult(text), text)!;
	assert.ok(summary.length <= 64, `summary was ${summary.length} chars: ${summary}`);
});

test("wrapPlain breaks on spaces and preserves paragraphs", () => {
	const wrapped = wrapPlain("one two three four five", 9);
	assert.ok(wrapped.every((l) => l.length <= 9));
	assert.equal(wrapped.join(" "), "one two three four five");
	assert.deepEqual(wrapPlain("a\n\nb", 20), ["a", "", "b"]);
});

test("wrapPlain hard-breaks a word longer than the width", () => {
	assert.ok(wrapPlain("x".repeat(25), 10).every((l) => l.length <= 10));
});

test("short formatters", () => {
	assert.equal(formatTokensShort(0), "0");
	assert.equal(formatTokensShort(999), "999");
	assert.equal(formatTokensShort(1500), "1.5K");
	assert.equal(formatTokensShort(15_000), "15K");
	assert.equal(formatDurShort(999), "0s");
	assert.equal(formatDurShort(65_000), "1m5s");
	assert.equal(formatDurShort(3_600_000), "1h");
});
