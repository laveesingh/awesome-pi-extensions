/**
 * Consumer entry point: `import { onViewportClick } from "pi-viewport-mouse/client"`.
 *
 * This module imports nothing from Pi and never touches the TUI, so an extension
 * can depend on it cheaply. It also creates the shared registry if it does not
 * exist yet, which means a consumer that loads *before* pi-viewport-mouse still
 * registers successfully — extension load order does not matter.
 *
 * A subscription made when pi-viewport-mouse is not installed at all is simply
 * never called; nothing throws.
 */
import {
	VIEWPORT_MOUSE_KEY,
	type ViewportClickHandler,
	type ViewportMouseRegistry,
} from "./src/types.js";

/**
 * Get the shared registry, creating it if absent.
 *
 * Mirrors `src/registry.ts` on purpose: whichever side loads first creates the
 * object, and both then see the same one. Keep the two implementations in sync.
 */
export function getViewportMouse(): ViewportMouseRegistry {
	const global = globalThis as unknown as Record<symbol, ViewportMouseRegistry | undefined>;
	let registry = global[VIEWPORT_MOUSE_KEY];
	if (!registry) {
		const handlers = new Map<string, ViewportClickHandler>();
		registry = {
			version: 1,
			handlers,
			on(key: string, handler: ViewportClickHandler) {
				handlers.set(key, handler);
				return () => handlers.delete(key);
			},
			off(key: string) {
				handlers.delete(key);
			},
		};
		global[VIEWPORT_MOUSE_KEY] = registry;
	}
	return registry;
}

/**
 * Subscribe to viewport clicks under a stable `key`.
 *
 * Registering the same key twice replaces the previous handler rather than
 * stacking a duplicate, which is what makes this safe across session reloads.
 * Return `true` from the handler to claim the click and stop dispatch.
 *
 * Returns an unsubscribe function.
 */
export function onViewportClick(key: string, handler: ViewportClickHandler): () => void {
	return getViewportMouse().on(key, handler);
}

/** Remove the handler registered under `key`. */
export function offViewportClick(key: string): void {
	getViewportMouse().off(key);
}

export { VIEWPORT_MOUSE_KEY } from "./src/types.js";
export type {
	Hit,
	ViewportClickEvent,
	ViewportClickHandler,
	ViewportMouseRegistry,
} from "./src/types.js";
