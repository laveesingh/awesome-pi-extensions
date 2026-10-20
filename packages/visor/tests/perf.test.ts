/**
 * Regression guard for the Pi 1.3.0 sluggishness: managed thought lines must
 * render through the live theme (ANSI-styled, sub-millisecond). If theme
 * resolution ever falls back to the module/subprocess path again, output goes
 * unstyled AND each line costs tens of milliseconds — which multiplied across
 * every thinking message and every frame froze the TUI for seconds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

let Pi: typeof import("@earendil-works/pi-coding-agent") | null = null;
try {
	Pi = await import("@earendil-works/pi-coding-agent");
	Pi.initTheme();
} catch {
	Pi = null;
}
const skip = Pi ? false : "pi-coding-agent unavailable";

const WIDTH = 120;
const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "").trim();

test("managed thought lines render styled end to end", { skip }, async () => {
	const { ThinkingManager } = await import("../src/thinking.js");
	const themeModule = await import(
		new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
	);
	const mgr = new ThinkingManager();
	(mgr as unknown as { ctx: unknown }).ctx = { ui: { theme: (themeModule as { theme: unknown }).theme } };
	assert.ok(mgr.installPatch());

	const { Container } = await import("@earendil-works/pi-tui");
	const chat = new Container();
	const C = (Pi as unknown as { AssistantMessageComponent: new (m: unknown, hide?: boolean) => unknown })
		.AssistantMessageComponent;
	for (let i = 0; i < 3; i++) {
		const c = new C(undefined, true) as { updateContent(m: unknown, s: boolean): void };
		c.updateContent(
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `reasoning ${i} `.repeat(40) },
					{ type: "text", text: `Reply ${i}` },
				],
			},
			false,
		);
		chat.addChild(c as never);
	}
	const raw = (chat.render(WIDTH) as string[]).join("\n");
	const thought = raw.split("\n").filter((l) => strip(l).includes("Thought"));
	assert.equal(thought.length, 3);
	for (const line of thought) {
		assert.match(line, /\[/, "thought line must carry ANSI styling (unstyled = theme fallback = slow path)");
	}
});
