/**
 * Renders real Pi ToolExecutionComponents through the installed patch.
 *
 * These reach into pi-coding-agent's exported components, which are public but
 * whose internals this package patches. If they are unavailable the suite skips
 * rather than fails, so a Pi release that moves things does not turn the pure
 * tests red too.
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
	// Installing the extension is what patches ToolExecutionComponent.
	const noop = () => {};
	const stub = new Proxy(
		{ on: noop, off: noop, registerTool: noop },
		{ get: (t, p) => (p in t ? (t as Record<string, unknown>)[p as string] : noop), set: () => true },
	);
	const { default: visor } = await import("../index.js");
	visor(stub as never);
});

const WIDTH = 100;
const ui = { requestRender() {} };
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+$/, "");

function block(
	name: string,
	args: unknown,
	output: string,
	opts: { expanded?: boolean; details?: unknown } = {},
): string[] {
	const C = (Pi as unknown as { ToolExecutionComponent: new (...a: unknown[]) => never }).ToolExecutionComponent;
	const c = new C(name, `${name}-1`, args, {}, undefined, ui, process.cwd()) as unknown as {
		updateArgs(a: unknown): void;
		setArgsComplete(): void;
		markExecutionStarted(): void;
		updateResult(r: unknown, partial: boolean): void;
		setExpanded(v: boolean): void;
		render(w: number): string[];
	};
	c.updateArgs(args);
	c.setArgsComplete();
	c.markExecutionStarted();
	c.updateResult({ content: [{ type: "text", text: output }], isError: false, details: opts.details }, false);
	c.setExpanded(!!opts.expanded);
	return c.render(WIDTH).map(strip).filter((l) => l.trim() !== "");
}

const footerOf = (lines: string[]) => lines.find((l) => l.trim().startsWith("↳")) ?? "";

test("the patch is installed on the component prototype", { skip }, () => {
	const proto = (Pi as unknown as { ToolExecutionComponent: { prototype: Record<string, unknown> } }).ToolExecutionComponent
		.prototype;
	assert.equal(proto.__visorToolDisplay, true);
});

test("a collapsed block is two lines: the call line and the footer", { skip }, () => {
	const lines = block("bash", { cmd: "ls" }, Array.from({ length: 12 }, (_, i) => `out ${i}`).join("\n"));
	assert.equal(lines.length, 2, `expected 2 lines, got:\n${lines.join("\n")}`);
	assert.match(lines[0], /bash/);
	// The Box contributes left padding, hence the trim.
	assert.match(lines[1].trim(), /^↳ 12 lines • \d\d:\d\d:\d\d • \d+ms \(ctrl\+o\)$/);
});

test("expanding shows the whole output", { skip }, () => {
	const out = Array.from({ length: 12 }, (_, i) => `out ${i}`).join("\n");
	const lines = block("bash", { cmd: "ls" }, out, { expanded: true });
	for (let i = 0; i < 12; i++) assert.ok(lines.some((l) => l.includes(`out ${i}`)), `missing out ${i}`);
});

test("one line, not one lines", { skip }, () => {
	assert.match(footerOf(block("bash", { cmd: "x" }, "only")), /↳ 1 line •/);
});

test("a JSON result puts its summary in the footer, still two lines", { skip }, () => {
	const value = { id: "GOL-999", title: "Probe", state: "open" };
	const text = JSON.stringify(value, null, 2);
	const lines = block("ticket_create", { title: "Probe" }, text, { details: { ok: true, result: value } });
	assert.equal(lines.length, 2, `expected 2 lines, got:\n${lines.join("\n")}`);
	assert.match(lines[1], /GOL-999/);
	assert.ok(!lines[1].includes("{"), "the footer must not contain raw JSON");
});

test("passthrough tools keep Pi's own expanded body", { skip }, () => {
	// read/edit/write render through Pi's built-in renderers, which we must call
	// rather than replace, or edit diffs disappear.
	const lines = block("read", { path: "/etc/hosts" }, "line 0\nline 1", { expanded: true });
	assert.ok(lines.some((l) => l.includes("line 0")), `expanded body missing:\n${lines.join("\n")}`);
});

test("a tool we do not own is left alone", { skip }, () => {
	const lines = block("some_unowned_tool", { a: 1 }, "untouched output");
	assert.equal(footerOf(lines), "", "an unowned tool must not get our footer");
	assert.ok(lines.some((l) => l.includes("untouched output")));
});

test("duration freezes when the result settles", { skip }, async () => {
	const C = (Pi as unknown as { ToolExecutionComponent: new (...a: unknown[]) => never }).ToolExecutionComponent;
	const c = new C("bash", "dur-1", { cmd: "x" }, {}, undefined, ui, process.cwd()) as unknown as {
		updateArgs(a: unknown): void;
		setArgsComplete(): void;
		markExecutionStarted(): void;
		updateResult(r: unknown, partial: boolean): void;
		setExpanded(v: boolean): void;
		render(w: number): string[];
	};
	c.updateArgs({ cmd: "x" });
	c.setArgsComplete();
	c.markExecutionStarted();
	c.updateResult({ content: [{ type: "text", text: "a\nb" }], isError: false }, false);

	const timing = (lines: string[]) => (lines.map(strip).join("\n").match(/(\d+(?:\.\d+)?)(ms|s)\b/) ?? [])[0];
	const first = timing(c.render(WIDTH));
	await new Promise((r) => setTimeout(r, 1100));
	c.setExpanded(true);
	// Expanding re-renders an old block. A Date.now()-based duration would grow.
	assert.equal(timing(c.render(WIDTH)), first, "duration drifted on re-render");
});
