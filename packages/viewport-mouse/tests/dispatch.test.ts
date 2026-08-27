/**
 * The mouse patch and event dispatch, driven with real SGR escape sequences
 * against a stub alt screen. Pi is not started; `installMousePatch({ target })`
 * takes the class to patch, so this exercises the shipped code paths directly.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { installMousePatch, uninstallMousePatch } from "../src/patch.js";
import { getRegistry } from "../src/registry.js";
import type { ViewportClickEvent } from "../src/types.js";

class Stack {
	children: any[] = [];
	constructor(...children: any[]) {
		this.children = children;
	}
	render(width: number): string[] {
		return this.children.flatMap((c) => c.render(width));
	}
}

class Block {
	children: any[] = [];
	expanded = false;
	constructor(
		public toolName: string,
		private lines: number,
	) {}
	setExpanded(value: boolean) {
		this.expanded = value;
	}
	render(): string[] {
		return Array.from({ length: this.lines }, (_, i) => `${this.toolName}:${i}`);
	}
}

class StubAltScreen {
	handleViewportInput(data: string): string {
		this.delegated.push(data);
		return "original";
	}
	delegated: string[] = [];
	flashes: string[] = [];
	renders = 0;
	selectionDragged = false;
	pressedUrl: string | undefined = undefined;
	selectionAnchor: { row: number } | undefined = undefined;
	currentLayout: any;
	scrollView: any;
	getPrimaryScrollView() {
		return this.scrollView;
	}
	requestRender() {
		this.renders++;
	}
	flash(message: string) {
		this.flashes.push(message);
	}
}

const VIEWPORT_TOP = 5;
const VIEWPORT_HEIGHT = 20;

function buildScreen({ scrollTop = 0 } = {}) {
	const first = new Block("alpha", 3);
	const second = new Block("beta", 4);
	const doc = new Stack(first, second);
	const painted = doc.render(80);
	const scrollView = {
		scrollTop,
		child: doc,
		getContentWidth: (w: number) => w,
	};
	const box = {
		scrollView,
		rect: { x: 0, y: VIEWPORT_TOP, width: 80, height: VIEWPORT_HEIGHT },
		scrollContentLines: painted,
		children: [],
	};
	const screen = new StubAltScreen();
	screen.scrollView = scrollView;
	screen.currentLayout = { root: { children: [box] } };
	return { screen, first, second, doc, painted };
}

/** SGR mouse report. `press` false emits a release. */
const sgr = (button: number, x: number, y: number, press: boolean) =>
	`\x1b[<${button};${x + 1};${y + 1}${press ? "M" : "m"}`;

/** Screen row showing content row `row`. */
const screenRow = (row: number, scrollTop = 0) => VIEWPORT_TOP + (row - scrollTop);

beforeEach(() => {
	getRegistry().handlers.clear();
	uninstallMousePatch({ target: StubAltScreen });
	installMousePatch({ target: StubAltScreen });
});

test("a left-button release dispatches the component under the click", () => {
	const { screen, second } = buildScreen();
	const seen: ViewportClickEvent[] = [];
	getRegistry().on("test", (event) => {
		seen.push(event);
		return true;
	});

	// Content row 4 is the second line of `beta` (alpha occupies rows 0-2).
	const result = screen.handleViewportInput(sgr(0, 2, screenRow(4), false));

	assert.equal(seen.length, 1);
	assert.equal(seen[0].row, 4);
	assert.equal(seen[0].closest((c: any) => typeof c.setExpanded === "function"), second);
	assert.equal(seen[0].rowWithin(second), 1, "offset inside the block");
	assert.equal(result, "original", "must still delegate to the original handler");
	assert.equal(screen.delegated.length, 1);
});

test("the event exposes the full ancestor chain, outermost first", () => {
	const { screen, doc, second } = buildScreen();
	let chain: any[] = [];
	getRegistry().on("test", (event) => {
		chain = event.chain;
		return true;
	});
	screen.handleViewportInput(sgr(0, 2, screenRow(4), false));

	assert.equal(chain[0].component, doc, "outermost first");
	assert.equal(chain[chain.length - 1].component, second, "innermost last");
	assert.ok(chain.every((c, i) => i === 0 || c.depth >= chain[i - 1].depth), "sorted by depth");
});

test("returning true claims the click and stops dispatch", () => {
	const { screen } = buildScreen();
	const order: string[] = [];
	getRegistry().on("first", () => {
		order.push("first");
		return true;
	});
	getRegistry().on("second", () => {
		order.push("second");
		return false;
	});
	screen.handleViewportInput(sgr(0, 2, screenRow(1), false));
	assert.deepEqual(order, ["first"]);
});

test("returning false passes the click to the next handler", () => {
	const { screen } = buildScreen();
	const order: string[] = [];
	getRegistry().on("first", () => {
		order.push("first");
		return false;
	});
	getRegistry().on("second", () => {
		order.push("second");
		return false;
	});
	screen.handleViewportInput(sgr(0, 2, screenRow(1), false));
	assert.deepEqual(order, ["first", "second"]);
});

test("a throwing handler does not stop the others or the original handler", () => {
	const { screen } = buildScreen();
	const logged: string[] = [];
	uninstallMousePatch({ target: StubAltScreen });
	installMousePatch({ target: StubAltScreen, log: (m) => logged.push(m) });

	let reached = false;
	getRegistry().on("bad", () => {
		throw new Error("boom");
	});
	getRegistry().on("good", () => {
		reached = true;
		return true;
	});
	const result = screen.handleViewportInput(sgr(0, 2, screenRow(1), false));

	assert.ok(reached, "later handlers still run");
	assert.equal(result, "original");
	assert.ok(logged.some((m) => m.includes('handler "bad" threw')));
});

test("registering the same key twice replaces rather than stacks", () => {
	const { screen } = buildScreen();
	let calls = 0;
	getRegistry().on("dup", () => {
		calls++;
		return true;
	});
	getRegistry().on("dup", () => {
		calls++;
		return true;
	});
	assert.equal(getRegistry().handlers.size, 1);
	screen.handleViewportInput(sgr(0, 2, screenRow(1), false));
	assert.equal(calls, 1);
});

test("unsubscribing stops delivery", () => {
	const { screen } = buildScreen();
	let calls = 0;
	const off = getRegistry().on("test", () => {
		calls++;
		return true;
	});
	off();
	screen.handleViewportInput(sgr(0, 2, screenRow(1), false));
	assert.equal(calls, 0);
});

test("scroll offset is applied when resolving the row", () => {
	const { screen, second } = buildScreen({ scrollTop: 3 });
	let target: any;
	getRegistry().on("test", (event) => {
		target = event.closest((c: any) => typeof c.setExpanded === "function");
		return true;
	});
	// With scrollTop 3, the top viewport row shows content row 3 — `beta`.
	screen.handleViewportInput(sgr(0, 2, VIEWPORT_TOP, false));
	assert.equal(target, second);
});

test("requestRender and flash reach the screen", () => {
	const { screen } = buildScreen();
	getRegistry().on("test", (event) => {
		event.requestRender();
		event.flash("hello");
		return true;
	});
	screen.handleViewportInput(sgr(0, 2, screenRow(1), false));
	assert.equal(screen.renders, 1);
	assert.deepEqual(screen.flashes, ["hello"]);
});

for (const [label, sequence, state] of [
	["a button press", sgr(0, 2, screenRow(1), true), {}],
	["wheel up", sgr(64, 2, screenRow(1), true), {}],
	["wheel down", sgr(65, 2, screenRow(1), true), {}],
	["a motion event", sgr(32, 2, screenRow(1), true), {}],
	["a right-button release", sgr(2, 2, screenRow(1), false), {}],
	["a selection drag", sgr(0, 2, screenRow(1), false), { selectionDragged: true }],
	["a link click", sgr(0, 2, screenRow(1), false), { pressedUrl: "https://example.com" }],
	["a click below the viewport", sgr(0, 2, VIEWPORT_TOP + VIEWPORT_HEIGHT, false), {}],
	["a click above the viewport", sgr(0, 2, VIEWPORT_TOP - 1, false), {}],
	[
		"a drag that started on another row",
		sgr(0, 2, screenRow(1), false),
		{ selectionAnchor: { row: 9 } },
	],
] as const) {
	test(`${label} is ignored but still delegated`, () => {
		const { screen } = buildScreen();
		Object.assign(screen, state);
		let called = false;
		getRegistry().on("test", () => {
			called = true;
			return true;
		});
		const result = screen.handleViewportInput(sequence);
		assert.equal(called, false);
		assert.equal(result, "original");
		assert.equal(screen.delegated.length, 1);
	});
}

test("non-mouse input passes straight through", () => {
	const { screen } = buildScreen();
	let called = false;
	getRegistry().on("test", () => {
		called = true;
		return true;
	});
	const result = screen.handleViewportInput("plain text");
	assert.equal(called, false);
	assert.equal(result, "original");
	assert.deepEqual(screen.delegated, ["plain text"]);
});

test("installing twice does not stack a second patch", () => {
	const before = StubAltScreen.prototype.handleViewportInput;
	const installedAgain = installMousePatch({ target: StubAltScreen });
	assert.equal(installedAgain, false, "second install must report that it did nothing");
	assert.equal(StubAltScreen.prototype.handleViewportInput, before);

	const { screen } = buildScreen();
	let calls = 0;
	getRegistry().on("test", () => {
		calls++;
		return true;
	});
	screen.handleViewportInput(sgr(0, 2, screenRow(1), false));
	assert.equal(calls, 1, "a click must fire exactly once");
});

test("uninstall restores the original handler", () => {
	assert.equal(uninstallMousePatch({ target: StubAltScreen }), true);
	const { screen } = buildScreen();
	let called = false;
	getRegistry().on("test", () => {
		called = true;
		return true;
	});
	assert.equal(screen.handleViewportInput(sgr(0, 2, screenRow(1), false)), "original");
	assert.equal(called, false);
	assert.equal(uninstallMousePatch({ target: StubAltScreen }), false, "second uninstall is a no-op");
});

test("with no subscribers the click is delegated untouched", () => {
	const { screen } = buildScreen();
	assert.equal(getRegistry().handlers.size, 0);
	const result = screen.handleViewportInput(sgr(0, 2, screenRow(1), false));
	assert.equal(result, "original");
});
