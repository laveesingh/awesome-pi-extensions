/**
 * Mapping content rows back to components.
 *
 * Pi's layout engine only creates boxes for `ScrollView` and `VStack`/`HStack`.
 * Every other component — `Container`, `Box`, `Text`, `ToolExecutionComponent` —
 * renders into lines inside a parent box, so the whole transcript collapses into
 * a single box holding an array of strings. There is no rectangle per block to
 * hit-test against, and `Component` has no mouse hook. The mapping therefore has
 * to be rebuilt by walking the document in render order.
 *
 * Nothing here imports Pi: every function works on the duck-typed shape
 * `{ render(width): string[], children?: Component[] }`, which keeps it testable
 * without a TUI.
 */
import type { Hit } from "./types.js";

/**
 * Find the layout box owning `scrollView`.
 *
 * This is an inlined copy of pi-tui's `getScrollViewBox`. It cannot be imported:
 * Pi resolves bare specifiers for extension code itself, so a runtime require of
 * `@earendil-works/pi-tui/dist/layout.js` fails with MODULE_NOT_FOUND — the
 * package sits inside pi-coding-agent's own node_modules, unreachable from the
 * extension's location.
 */
export function findScrollBox(box: any, scrollView: any): any {
	if (!box) return undefined;
	if (box.scrollView === scrollView) return box;
	for (const child of box.children ?? []) {
		const match = findScrollBox(child, scrollView);
		if (match) return match;
	}
	return undefined;
}

/**
 * Record every component in `doc` with the content rows it occupies. Ranges
 * nest: a parent's range contains its children's.
 *
 * The load-bearing rule is that a component's height is its OWN
 * `render(width).length`, never the sum of its children's. `Box` adds `paddingY`
 * rows and renders children at `width - 2 * paddingX`, so walking through one
 * undercounts twice over — missing padding rows, and missing the extra wrapping
 * from the narrower width. That error accumulates down the document and shifts
 * every block below it, which makes clicks land on the following block.
 *
 * So we descend only into components that are a transparent concatenation of
 * their children, tested directly: if the children's heights sum to the parent's
 * own height, recursion is safe. Anything that frames its children fails the test
 * and keeps its rows attributed to itself.
 */
export function mapComponents(doc: any, width: number): { hits: Hit[]; total: number } {
	const hits: Hit[] = [];
	const heightOf = (component: any): number => {
		try {
			return component?.render ? component.render(width).length : 0;
		} catch {
			return 0;
		}
	};

	const walk = (component: any, offset: number, depth: number, known?: number): number => {
		const height = known ?? heightOf(component);
		hits.push({
			component,
			name: component?.constructor?.name ?? "unknown",
			start: offset,
			height,
			depth,
		});
		const children: any[] = Array.isArray(component?.children) ? component.children : [];
		if (children.length > 0 && height > 0) {
			const heights = children.map(heightOf);
			const sum = heights.reduce((a, b) => a + b, 0);
			if (sum === height) {
				let cursor = offset;
				for (let i = 0; i < children.length; i++) {
					walk(children[i], cursor, depth + 1, heights[i]);
					cursor += heights[i];
				}
			}
		}
		return height;
	};

	const total = walk(doc, 0, 0);
	return { hits, total };
}

/**
 * Whether the walk agrees with what the layout actually painted.
 *
 * `paintedLines` is the ScrollView box's `scrollContentLines` — the exact lines on
 * screen. Because every component's height comes from its own render, and we
 * descend only through faithful concatenations, a document whose walked height
 * equals its painted height has every component at the right offset. A mismatch
 * means some component measured wrongly and every offset after it is suspect.
 *
 * Callers should refuse to act on a document that fails this check: doing nothing
 * is better than resolving a click to the wrong component.
 *
 * Per-component byte comparison deliberately is not used. A parent may decorate
 * its children's lines without changing their count — `UserMessageComponent` adds
 * OSC 133 shell-integration markers to its first and last line — so a child's own
 * render can differ from the painted bytes while occupying exactly the right rows.
 */
export function isDocumentAligned(walkedTotal: number, paintedLines: string[]): boolean {
	if (paintedLines.length === 0) return true;
	return walkedTotal === paintedLines.length;
}
