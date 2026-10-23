/**
 * pi-viewport-mouse — resolves alt-screen mouse clicks to the components under
 * them and publishes them as events. It performs no UI action of its own.
 *
 * Subscribe from another extension:
 *
 *   import { onViewportClick } from "pi-viewport-mouse/client";
 *
 *   onViewportClick("my-extension", (event) => {
 *     const block = event.closest((c) => typeof c.setExpanded === "function");
 *     if (!block) return false;
 *     block.setExpanded(!block.expanded);
 *     event.requestRender();
 *     return true;
 *   });
 *
 * See README.md for the full contract.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installMousePatch } from "./src/patch.js";
import { getRegistry } from "./src/registry.js";

const LOG_PATH = "/tmp/pi-viewport-mouse.log";

function log(message: string): void {
	if (process.env.PI_VIEWPORT_MOUSE_DEBUG !== "1" && process.env.PI_DEBUG !== "1") return;
	try {
		require("node:fs").appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
	} catch {}
}

export default function viewportMouseExtension(pi: ExtensionAPI): void {
	try {
		installMousePatch({ log });
	} catch (error) {
		try {
			console.error("pi-viewport-mouse: failed to install mouse patch", error);
		} catch {}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") {
			log(`ready with ${getRegistry().handlers.size} handler(s)`);
		}
	});

	// The patch is deliberately left installed across session reloads. Consumers
	// re-register by key on reload, and tearing the patch down here would break a
	// consumer whose own reload completed first.
}

export { getRegistry } from "./src/registry.js";
export { installMousePatch, uninstallMousePatch } from "./src/patch.js";
export { findScrollBox, isDocumentAligned, mapComponents } from "./src/layout.js";
export { VIEWPORT_MOUSE_KEY } from "./src/types.js";
export type {
	Hit,
	ViewportClickEvent,
	ViewportClickHandler,
	ViewportMouseRegistry,
} from "./src/types.js";
