/**
 * The thinking block: one managed line, expandable, with a hitbox of its own.
 *
 * The hitbox tests are the important ones. The thought line lives inside an
 * AssistantMessageComponent that ALSO contains the assistant's text reply, so a
 * click target chosen carelessly makes the whole reply toggle the thought block.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";

let Pi: typeof import("@earendil-works/pi-coding-agent") | null = null;
try {
	Pi = await import("@earendil-works/pi-coding-agent");
	Pi.initTheme();
} catch {
	Pi = null;
}
const skip = Pi ? false : "pi-coding-agent unavailable";

before(async () => {
	if (!Pi) return;
	const noop = () => {};
	const stub = new Proxy(
		{ on: noop, off: noop, registerTool: noop },
		{ get: (t, p) => (p in t ? (t as Record<string, unknown>)[p as string] : noop), set: () => true },
	);
	const { default: visor } = await import("../index.js");
	visor(stub as never);
});

const WIDTH = 100;
const THINKING = "First work out which component owns the rows.\n\nThen map the click back to it.";
const REPLY = "A click arrives as raw coordinates in a character grid.";

type Message = { role: string; content: Array<Record<string, unknown>> };
const withThinking: Message = {
	role: "assistant",
	content: [{ type: "thinking", thinking: THINKING }, { type: "text", text: REPLY }],
};
const withoutThinking: Message = { role: "assistant", content: [{ type: "text", text: REPLY }] };

type Amc = {
	render(w: number): string[];
	setExpanded(v: boolean): void;
	expanded: boolean;
	contentContainer: { children: unknown[] };
	__visorHasThinking?: boolean;
	__visorThinking?: string;
	__visorThoughtLine?: boolean;
};

function build(message: Message): Amc {
	const C = (Pi as unknown as { AssistantMessageComponent: new (m: unknown) => unknown }).AssistantMessageComponent;
	return new C(message) as Amc;
}

const strip = (s: string) =>
	s.replace(/\[[0-9;]*m/g, "").replace(/\]133;[A-Z]/g, "").trim();
const lines = (c: Amc) => c.render(WIDTH).map(strip).filter((l) => l !== "");

test("the expansion contract is installed for ctrl+O", { skip }, () => {
	// Pi's setToolsExpanded walks chatContainer's TOP-LEVEL children only, so the
	// message component itself must carry setExpanded or ctrl+O cannot reach the
	// thought line nested inside it.
	const proto = (Pi as unknown as { AssistantMessageComponent: { prototype: Record<string, unknown> } })
		.AssistantMessageComponent.prototype;
	assert.equal(proto.__visorThinkExpandable, true);
	assert.equal(typeof proto.setExpanded, "function");
});

test("a thinking run collapses to a single managed line", { skip }, () => {
	const out = lines(build(withThinking));
	const thought = out.filter((l) => l.includes("Thought"));
	assert.equal(thought.length, 1, `expected exactly one Thought line, got:\n${out.join("\n")}`);
	assert.match(thought[0], /● Thought \(.+\) \(ctrl\+o\)$/);
	assert.ok(!out.some((l) => l.includes("First work out")), "raw thinking must not leak when collapsed");
	assert.ok(out.some((l) => l.includes("A click arrives")), "the reply is always visible");
});

test("expanding reveals the reasoning and drops the hint", { skip }, () => {
	const c = build(withThinking);
	c.setExpanded(true);
	const out = lines(c);
	assert.ok(out.some((l) => l.includes("First work out")), `reasoning missing:\n${out.join("\n")}`);
	assert.ok(out.some((l) => l.includes("Then map the click")), "later paragraphs must survive");
	assert.ok(!out.some((l) => l.includes("(ctrl+o)")), "the hint belongs to the collapsed state");
});

test("collapsing again restores the single line", { skip }, () => {
	const c = build(withThinking);
	c.setExpanded(true);
	c.setExpanded(false);
	assert.ok(!lines(c).some((l) => l.includes("First work out")));
});

test("a message without thinking is inert", { skip }, () => {
	// ctrl+O visits every message. Toggling one with nothing to show would rebuild
	// the whole transcript for no reason.
	const c = build(withoutThinking);
	assert.equal(!!c.__visorHasThinking, false);
	c.setExpanded(true);
	assert.equal(c.expanded, false);
});

test("the click target is the thought line, never the whole message", { skip }, () => {
	// The regression: AssistantMessageComponent spans the thought line AND the
	// reply, so marking IT as the click target made every reply row toggle
	// thinking. Only the line itself may carry the marker.
	const c = build(withThinking);
	assert.notEqual(c.__visorThoughtLine, true, "the message must not be a click target");

	const line = c.contentContainer.children.find(
		(k) => (k as { __visorThoughtLine?: boolean })?.__visorThoughtLine === true,
	) as { render(w: number): string[]; expanded: boolean; setExpanded(v: boolean): void } | undefined;
	assert.ok(line, "the thought line must be a click target");

	// Its rows are its own, and far fewer than the message's.
	const own = line.render(WIDTH).length;
	assert.equal(own, 1, "a collapsed thought line occupies exactly one row");
	assert.ok(c.render(WIDTH).length > own, "the message spans more rows than the line");

	// Toggling through the line drives the same state ctrl+O uses.
	line.setExpanded(true);
	assert.equal(c.expanded, true);
	assert.ok(line.expanded);
});

test("an expanded thought line owns the rows its reasoning occupies", { skip }, () => {
	const c = build(withThinking);
	c.setExpanded(true);
	const line = c.contentContainer.children.find(
		(k) => (k as { __visorThoughtLine?: boolean })?.__visorThoughtLine === true,
	) as { render(w: number): string[] };
	assert.ok(line.render(WIDTH).length > 1, "expanded reasoning must be inside the clickable line");
});
