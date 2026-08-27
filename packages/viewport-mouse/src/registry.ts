import {
	VIEWPORT_MOUSE_KEY,
	type ViewportClickHandler,
	type ViewportMouseRegistry,
} from "./types.js";

/**
 * Get the shared registry, creating it if this is the first caller.
 *
 * Consumers may call this too — the creation logic is intentionally duplicated
 * in `client.ts` so a consumer that loads before this extension still ends up
 * with the same object. Keep the two in sync.
 */
export function getRegistry(): ViewportMouseRegistry {
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
