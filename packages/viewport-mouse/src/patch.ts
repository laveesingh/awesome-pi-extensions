/**
 * The single point that touches Pi internals.
 *
 * Pi's alt-screen TUI captures SGR mouse events for scrolling, text selection and
 * OSC 8 links, but never routes them to components — `Component` has no mouse
 * hook. This wraps `TuiAltScreen.handleViewportInput` to resolve a click to the
 * components under it, dispatch it to subscribers, and then delegate to the
 * original handler unchanged so scrolling and selection keep working.
 *
 * Because this reaches into a private method, it is deliberately the only file in
 * the package that does so: a Pi release that renames or restructures
 * `handleViewportInput` breaks this file alone, not every consumer.
 */
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { findScrollBox, isDocumentAligned, mapComponents } from "./layout.js";
import { getRegistry } from "./registry.js";
import type { Hit, ViewportClickEvent } from "./types.js";

const PATCH_MARK = "__viewportMousePatched";

/** SGR mouse report: ESC [ < button ; col ; row (M=press, m=release) */
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export interface PatchOptions {
	/** Called with diagnostic messages. Defaults to a no-op. */
	log?: (message: string) => void;
	/** Class to patch. Injectable for tests; defaults to Pi's TuiAltScreen. */
	target?: { prototype: any };
}

/**
 * Install the mouse patch. Safe to call more than once: a marker on the patched
 * function prevents a second copy of the extension from stacking another wrapper,
 * which would make every click fire twice.
 *
 * Returns true if this call installed the patch, false if it was already present.
 */
export function installMousePatch(options: PatchOptions = {}): boolean {
	const log = options.log ?? (() => {});
	const target = options.target ?? (TuiAltScreen as unknown as { prototype: any });
	const proto = target.prototype;
	const original = proto.handleViewportInput;

	if (original?.[PATCH_MARK]) return false;

	const registry = getRegistry();

	const patched = function (this: any, data: string) {
		const match = SGR_MOUSE.exec(data);
		if (!match) return original.call(this, data);

		const button = Number.parseInt(match[1], 10);
		const x = Number.parseInt(match[2], 10) - 1;
		const y = Number.parseInt(match[3], 10) - 1;
		const isRelease = match[4] === "m";

		// Left button releases only. Bit 32 marks motion, bit 64 marks the wheel;
		// both share the low button bits and must be excluded.
		const isLeftRelease =
			isRelease && (button & 3) === 0 && (button & 32) === 0 && (button & 64) === 0;
		if (!isLeftRelease || registry.handlers.size === 0) return original.call(this, data);

		try {
			// Pi's own rule for distinguishing a click from a drag, borrowed from its
			// OSC 8 link activation: a drag is a text selection, and a pressed link
			// takes precedence over anything a subscriber might want to do.
			if (this.selectionDragged || this.pressedUrl) return original.call(this, data);

			const frame = this.currentLayout;
			const scrollView = this.getPrimaryScrollView?.();
			if (!frame || !scrollView) return original.call(this, data);

			const box = findScrollBox(frame.root, scrollView);
			if (!box) return original.call(this, data);
			// Clicks in the editor, status or footer dock are not ours.
			if (y < box.rect.y || y >= box.rect.y + box.rect.height) {
				return original.call(this, data);
			}

			const row = scrollView.scrollTop + (y - box.rect.y);
			// If the press landed on another row this was a drag, not a click.
			const anchor = this.selectionAnchor;
			if (anchor && anchor.row !== row) return original.call(this, data);

			// getContentWidth accounts for a permanently visible scrollbar column.
			// Using box.rect.width would wrap text differently and skew every offset.
			const width = scrollView.getContentWidth(box.rect.width);
			const document = scrollView.child ?? scrollView.children?.[0];
			if (!document) return original.call(this, data);

			const paintedLines: string[] = box.scrollContentLines ?? [];
			const { hits, total } = mapComponents(document, width);
			if (!isDocumentAligned(total, paintedLines)) {
				// Some component measured wrongly, so every offset after it is suspect.
				// Resolving the click would land on the wrong component; do nothing.
				log(`height mismatch: walked=${total} painted=${paintedLines.length} width=${width}`);
				return original.call(this, data);
			}

			const chain: Hit[] = hits
				.filter((hit) => hit.height > 0 && row >= hit.start && row < hit.start + hit.height)
				.sort((a, b) => a.depth - b.depth);
			if (chain.length === 0) return original.call(this, data);

			const tui = this;
			const event: ViewportClickEvent = {
				target: chain[chain.length - 1].component,
				chain,
				row,
				x,
				y,
				button,
				closest(predicate) {
					for (let i = chain.length - 1; i >= 0; i--) {
						try {
							if (predicate(chain[i].component)) return chain[i].component;
						} catch {}
					}
					return undefined;
				},
				rowWithin(component) {
					const found = chain.find((entry) => entry.component === component);
					return found ? row - found.start : -1;
				},
				requestRender() {
					try {
						tui.requestRender?.(true);
					} catch {}
				},
				flash(message, durationMs = 800) {
					try {
						tui.flash?.(message, durationMs);
					} catch {}
				},
				scrollView,
				tui,
			};

			for (const [key, handler] of registry.handlers) {
				try {
					if (handler(event) === true) break;
				} catch (error) {
					log(`handler "${key}" threw: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		} catch (error) {
			log(`error: ${error instanceof Error ? error.message : String(error)}`);
		}

		return original.call(this, data);
	};

	patched[PATCH_MARK] = true;
	patched.__original = original;
	proto.handleViewportInput = patched;
	return true;
}

/** Remove the patch, restoring the original handler. Mainly for tests. */
export function uninstallMousePatch(options: PatchOptions = {}): boolean {
	const target = options.target ?? (TuiAltScreen as unknown as { prototype: any });
	const proto = target.prototype;
	const current = proto.handleViewportInput;
	if (!current?.[PATCH_MARK]) return false;
	proto.handleViewportInput = current.__original;
	return true;
}
