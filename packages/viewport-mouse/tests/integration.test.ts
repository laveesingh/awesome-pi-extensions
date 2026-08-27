/**
 * End-to-end against the real Pi TUI: real components, the real layout engine,
 * and real SGR escape sequences through the shipped patch.
 *
 * These reach into pi-coding-agent's `dist/` to construct transcript components,
 * which is not a public API. If the layout is unavailable the suite skips rather
 * than fails, so a Pi release that moves things does not turn into a red build
 * for the parts of the package that do not depend on it.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mapComponents } from "../src/layout.js";
import { installMousePatch, uninstallMousePatch } from "../src/patch.js";
import { getRegistry } from "../src/registry.js";

/**
 * Package root for a dependency. Uses ESM resolution: these packages declare only
 * an "import" condition, so createRequire().resolve() cannot see their main entry,
 * and they do not export "./package.json" either.
 */
function packageRoot(name: string): string {
	let dir = dirname(fileURLToPath(import.meta.resolve(name)));
	const marker = `node_modules/${name}`;
	while (!dir.replaceAll("\\", "/").endsWith(marker)) {
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`cannot locate root of ${name}`);
		dir = parent;
	}
	return dir;
}

async function loadPi() {
	try {
		const dist = join(packageRoot("@earendil-works/pi-coding-agent"), "dist");
		const tuiDist = join(packageRoot("@earendil-works/pi-tui"), "dist");
		const tui = await import(join(tuiDist, "index.js"));
		const layout = await import(join(tuiDist, "layout.js"));
		const themeModule = await import(join(dist, "modes/interactive/theme/theme.js"));
		themeModule.initTheme();
		const { UserMessageComponent } = await import(
			join(dist, "modes/interactive/components/user-message.js")
		);
		const { ToolExecutionComponent } = await import(
			join(dist, "modes/interactive/components/tool-execution.js")
		);
		return { tui, layout, UserMessageComponent, ToolExecutionComponent };
	} catch {
		return null;
	}
}

const pi = await loadPi();
const skip = pi ? false : "pi-coding-agent internals unavailable";

class StubAltScreen {
	handleViewportInput(data: string): string {
		this.delegated.push(data);
		return "original";
	}
	delegated: string[] = [];
	flashes: string[] = [];
	selectionDragged = false;
	pressedUrl: string | undefined = undefined;
	selectionAnchor: any = undefined;
	currentLayout: any;
	scrollViewRef: any;
	getPrimaryScrollView() {
		return this.scrollViewRef;
	}
	requestRender() {}
	flash(message: string) {
		this.flashes.push(message);
	}
}

const sgr = (button: number, x: number, y: number, press: boolean) =>
	`\x1b[<${button};${x + 1};${y + 1}${press ? "M" : "m"}`;

const WIDTH = 120;
const HEIGHT = 60;

/** A transcript with a bordered user message, thoughts, and four tool blocks. */
function buildTranscript() {
	const { tui, UserMessageComponent, ToolExecutionComponent } = pi!;
	const { Container, Text, ScrollView, VStack, Spacer } = tui;
	const ui = { requestRender() {} };

	const chat = new Container();
	const tools: any[] = [];
	const addTool = (name: string, args: any, output: string) => {
		const component = new ToolExecutionComponent(
			name,
			`${name}-${chat.children.length}`,
			args,
			{},
			undefined,
			ui,
			process.cwd(),
		);
		component.updateArgs(args);
		component.setArgsComplete();
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: output }], isError: false }, false);
		chat.addChild(component);
		tools.push(component);
	};

	// The bordered Box inside this component is what broke the naive walk.
	chat.addChild(
		new UserMessageComponent(
			"Create 1 task:\n- Use a bash tool for test usage\n\nExecute it and mark it complete.",
		),
	);
	chat.addChild(new Spacer(1));
	chat.addChild(new Text("● Thought (0s • ↓ 0)", 1, 0));
	addTool("TaskCreate", { title: "Run verification" }, "Created #1");
	chat.addChild(new Spacer(1));
	addTool("TaskUpdate", { id: 1, status: "in_progress" }, "Task #1 in progress");
	chat.addChild(new Spacer(1));
	addTool("bash", { cmd: "node cli.js --help" }, Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));
	chat.addChild(new Spacer(1));
	addTool("TaskUpdate", { id: 1, status: "completed" }, "Task #1 completed");

	const document = new Container();
	document.addChild(new Container());
	document.addChild(chat);
	const scrollView = new ScrollView(document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: "auto",
	});
	const root = new VStack([
		{ component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: new Text("dock", 0, 0), basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	return { document, scrollView, root, tools };
}

function layoutAt(root: any, scrollView: any, scrollTop: number) {
	const { layout } = pi!;
	layout.renderLayoutFrame(root, WIDTH, HEIGHT, () => {});
	scrollView.scrollTo(scrollTop, { disableFollow: true });
	const frame = layout.renderLayoutFrame(root, WIDTH, HEIGHT, () => {});
	const find = (box: any): any =>
		box.scrollView === scrollView ? box : (box.children ?? []).map(find).find(Boolean);
	return { frame, box: find(frame.root) };
}

beforeEach(() => {
	getRegistry().handlers.clear();
	uninstallMousePatch({ target: StubAltScreen });
	installMousePatch({ target: StubAltScreen });
});

test("walked height matches what the layout actually paints", { skip }, () => {
	const { document, scrollView, root } = buildTranscript();
	for (const scrollTop of [0, 5, 20]) {
		const { box } = layoutAt(root, scrollView, scrollTop);
		const width = scrollView.getContentWidth(box.rect.width);
		const { total } = mapComponents(document, width);
		assert.equal(
			total,
			box.scrollContentLines.length,
			`walked height must equal painted height at scrollTop ${scrollTop}`,
		);
	}
});

test("every tool block sits on the rows it renders", { skip }, () => {
	const { document, scrollView, root, tools } = buildTranscript();
	const { box } = layoutAt(root, scrollView, 0);
	const width = scrollView.getContentWidth(box.rect.width);
	const { hits } = mapComponents(document, width);
	const painted: string[] = box.scrollContentLines;

	for (const tool of tools) {
		const hit = hits.find((h) => h.component === tool)!;
		assert.deepEqual(
			painted.slice(hit.start, hit.start + hit.height),
			tool.render(width),
			`${tool.toolName} at row ${hit.start}`,
		);
	}
});

test("mapped ranges are contiguous and non-overlapping at each depth", { skip }, () => {
	const { document, scrollView, root } = buildTranscript();
	const { box } = layoutAt(root, scrollView, 0);
	const width = scrollView.getContentWidth(box.rect.width);
	const { hits } = mapComponents(document, width);

	const byDepth = new Map<number, typeof hits>();
	for (const hit of hits) {
		if (hit.height === 0) continue;
		byDepth.set(hit.depth, [...(byDepth.get(hit.depth) ?? []), hit]);
	}
	for (const [depth, siblings] of byDepth) {
		const sorted = [...siblings].sort((a, b) => a.start - b.start);
		for (let i = 1; i < sorted.length; i++) {
			assert.ok(
				sorted[i].start >= sorted[i - 1].start + sorted[i - 1].height,
				`depth ${depth}: ${sorted[i].name} overlaps ${sorted[i - 1].name}`,
			);
		}
	}
});

test("a child decorated by its parent still occupies the right rows", { skip }, () => {
	// UserMessageComponent adds OSC 133 markers to its first and last line without
	// changing the count, so its inner Box is mapped to exactly the parent's rows
	// even though the painted bytes differ from the Box's own render.
	const { document, scrollView, root } = buildTranscript();
	const { box } = layoutAt(root, scrollView, 0);
	const width = scrollView.getContentWidth(box.rect.width);
	const { hits } = mapComponents(document, width);

	const message = hits.find((h) => h.name === "UserMessageComponent");
	assert.ok(message, "the user message must be mapped");
	const inner = hits.find((h) => h.depth === message.depth + 1 && h.start === message.start);
	assert.ok(inner, "its decorated child must be mapped at the same start row");
	assert.equal(inner.height, message.height);
	assert.deepEqual(
		box.scrollContentLines.slice(message.start, message.start + message.height),
		message.component.render(width),
		"the parent, which is what gets painted, must match byte for byte",
	);
});

test("clicking a tool block resolves to that block, not its neighbour", { skip }, () => {
	const { document, scrollView, root, tools } = buildTranscript();

	for (const tool of tools) {
		const { frame, box } = layoutAt(root, scrollView, 0);
		const width = scrollView.getContentWidth(box.rect.width);
		const { hits } = mapComponents(document, width);
		const hit = hits.find((h) => h.component === tool)!;

		for (const row of [hit.start, hit.start + Math.floor(hit.height / 2), hit.start + hit.height - 1]) {
			const y = box.rect.y + (row - scrollView.scrollTop);
			if (y < box.rect.y || y >= box.rect.y + box.rect.height) continue;

			const screen = new StubAltScreen();
			screen.currentLayout = frame;
			screen.scrollViewRef = scrollView;
			let resolved: any;
			getRegistry().on("test", (event) => {
				resolved = event.closest((c: any) => typeof c.setExpanded === "function");
				return true;
			});
			screen.handleViewportInput(sgr(0, 4, y, false));
			assert.equal(resolved, tool, `row ${row} of ${tool.toolName} must resolve to itself`);
		}
	}
});

test("expanding one block keeps the others correctly placed", { skip }, () => {
	const { document, scrollView, root, tools } = buildTranscript();
	const bash = tools.find((t) => t.toolName === "bash");
	bash.setExpanded(true);

	const { box } = layoutAt(root, scrollView, 0);
	const width = scrollView.getContentWidth(box.rect.width);
	const { hits, total } = mapComponents(document, width);
	assert.equal(total, box.scrollContentLines.length);

	for (const tool of tools) {
		const hit = hits.find((h) => h.component === tool)!;
		assert.deepEqual(
			box.scrollContentLines.slice(hit.start, hit.start + hit.height),
			tool.render(width),
			`${tool.toolName} must still sit on its painted rows`,
		);
	}
});
