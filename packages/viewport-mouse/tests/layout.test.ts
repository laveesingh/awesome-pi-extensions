/**
 * Row-to-component mapping. No Pi required: every function under test works on
 * the duck-typed component shape, so these run anywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { findScrollBox, isDocumentAligned, mapComponents } from "../src/layout.js";

/** A plain container: renders exactly the concatenation of its children. */
class Stack {
	children: any[] = [];
	constructor(...children: any[]) {
		this.children = children;
	}
	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}
}

/** A leaf that wraps its text to `width`, like Text does. */
class Line {
	constructor(private text: string) {}
	render(width: number): string[] {
		const out: string[] = [];
		for (let i = 0; i < this.text.length; i += width) out.push(this.text.slice(i, i + width));
		return out.length ? out : [""];
	}
}

/**
 * A framing container, like pi-tui's Box: adds paddingY rows and renders its
 * children at a reduced width. This is the shape that broke the naive walk.
 */
class Frame {
	children: any[] = [];
	constructor(
		private paddingX: number,
		private paddingY: number,
		...children: any[]
	) {
		this.children = children;
	}
	render(width: number): string[] {
		const inner = Math.max(1, width - this.paddingX * 2);
		const body = this.children.flatMap((child) => child.render(inner));
		const pad = Array.from({ length: this.paddingY }, () => "");
		return [...pad, ...body.map((l) => " ".repeat(this.paddingX) + l), ...pad];
	}
}

test("maps a flat document", () => {
	const a = new Line("aaa");
	const b = new Line("bbb");
	const doc = new Stack(a, b);
	const { hits, total } = mapComponents(doc, 10);

	assert.equal(total, 2);
	assert.equal(total, doc.render(10).length, "walked height must equal rendered height");
	assert.deepEqual(
		hits.map((h) => [h.name, h.start, h.height]),
		[
			["Stack", 0, 2],
			["Line", 0, 1],
			["Line", 1, 1],
		],
	);
});

test("descends into transparent containers and records nesting depth", () => {
	const leaf = new Line("x");
	const doc = new Stack(new Stack(new Stack(leaf)));
	const { hits } = mapComponents(doc, 10);

	assert.equal(hits.length, 4);
	assert.deepEqual(hits.map((h) => h.depth), [0, 1, 2, 3]);
	assert.ok(hits.every((h) => h.start === 0 && h.height === 1), "nested ranges must coincide");
});

test("does NOT descend into a framing container, and stays aligned after one", () => {
	// Regression: descending into a Frame counts only its children's lines, missing
	// the padding rows and the extra wrapping from the narrower inner width. The
	// deficit accumulates, shifting every later component upward — which made
	// clicks land on the following block.
	const framed = new Frame(1, 1, new Line("0123456789"));
	const after = new Line("tail");
	const doc = new Stack(framed, after);
	const width = 10;

	// Frame: 1 pad + 2 wrapped rows (inner width 8) + 1 pad = 4 rows.
	assert.equal(framed.render(width).length, 4);
	// A naive children-only walk would have said 1 row, losing 3.
	assert.equal(new Line("0123456789").render(width).length, 1);

	const { hits, total } = mapComponents(doc, width);
	assert.equal(total, doc.render(width).length, "walked height must equal rendered height");

	const frameHit = hits.find((h) => h.name === "Frame");
	assert.ok(frameHit);
	assert.equal(frameHit.start, 0);
	assert.equal(frameHit.height, 4);

	// The component after the frame must not be shifted.
	const tailHit = hits.find((h) => h.component === after);
	assert.ok(tailHit);
	assert.equal(tailHit.start, 4, "component after a frame must not drift upward");

	// Nothing inside the frame is recorded: its rows belong to the frame itself.
	assert.equal(hits.filter((h) => h.depth > 1).length, 0);
});

test("drift does not accumulate across several framing containers", () => {
	const doc = new Stack(
		new Frame(1, 1, new Line("aaaa")),
		new Line("one"),
		new Frame(1, 1, new Line("bbbb")),
		new Line("two"),
		new Frame(1, 1, new Line("cccc")),
	);
	const width = 20;
	const { hits, total } = mapComponents(doc, width);
	assert.equal(total, doc.render(width).length);

	// Every recorded component must sit exactly on the rows it renders.
	const painted = doc.render(width);
	for (const hit of hits) {
		if (hit.height === 0) continue;
		const claimed = painted.slice(hit.start, hit.start + hit.height);
		assert.deepEqual(claimed, hit.component.render(hit.depth === 0 ? width : width),
			`${hit.name} at ${hit.start} must sit on its own rendered rows`);
	}
});

test("a component that renders nothing gets a zero-height range", () => {
	const empty = { render: () => [] as string[] };
	const doc = new Stack(empty as any, new Line("x"));
	const { hits, total } = mapComponents(doc, 10);
	assert.equal(total, 1);
	const emptyHit = hits.find((h) => h.component === empty);
	assert.equal(emptyHit?.height, 0);
});

test("a throwing render is contained rather than propagating to the caller", () => {
	// A child that throws makes its parent's render throw too, so the document
	// measures as zero height and the walk stops there. The point is that a broken
	// component cannot take down the click handler.
	const broken = {
		render() {
			throw new Error("boom");
		},
	};
	const doc = new Stack(broken as any, new Line("x"));

	assert.doesNotThrow(() => mapComponents(doc, 10));
	const { hits, total } = mapComponents(doc, 10);
	assert.equal(total, 0);
	assert.deepEqual(hits.map((h) => [h.name, h.height]), [["Stack", 0]]);
});

test("isDocumentAligned compares the walked height against the painted height", () => {
	assert.equal(isDocumentAligned(3, ["a", "b", "c"]), true);
	assert.equal(isDocumentAligned(2, ["a", "b", "c"]), false);
	assert.equal(isDocumentAligned(0, []), true, "nothing painted means nothing to check");
	assert.equal(isDocumentAligned(7, []), true);
});

test("a decorating parent keeps its children correctly placed", () => {
	// UserMessageComponent wraps its child's lines with OSC 133 shell-integration
	// markers: same line count, different bytes. The child still occupies exactly
	// the right rows, which is why placement is checked by height, not by bytes.
	class Decorate {
		children: any[] = [];
		constructor(...children: any[]) {
			this.children = children;
		}
		render(width: number): string[] {
			const lines = this.children.flatMap((c) => c.render(width));
			if (lines.length === 0) return lines;
			return [`<start>${lines[0]}`, ...lines.slice(1, -1), `<end>${lines[lines.length - 1]}`];
		}
	}
	const inner = new Line("abcdefghij");
	const doc = new Stack(new Decorate(inner), new Line("tail"));
	const width = 5;

	const { hits, total } = mapComponents(doc, width);
	assert.equal(total, doc.render(width).length);
	assert.ok(isDocumentAligned(total, doc.render(width)));

	// The decorator preserves the line count, so the walk descends and the inner
	// component lands on the decorator's own rows.
	const innerHit = hits.find((h) => h.component === inner);
	assert.ok(innerHit, "the child of a count-preserving decorator is still mapped");
	assert.equal(innerHit.start, 0);
	assert.equal(innerHit.height, 2);

	// And what follows is not shifted.
	assert.equal(hits.find((h) => h.name === "Line" && h.depth === 1)?.start, 2);
});

test("findScrollBox locates the box owning a scroll view", () => {
	const sv = { id: "primary" };
	const target = { scrollView: sv, children: [] };
	const tree = { children: [{ children: [] }, { children: [target] }] };
	assert.equal(findScrollBox(tree, sv), target);
	assert.equal(findScrollBox(tree, { id: "other" }), undefined);
	assert.equal(findScrollBox(undefined, sv), undefined);
});
