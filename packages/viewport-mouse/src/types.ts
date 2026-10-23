/**
 * Public contract for viewport-mouse. Deliberately free of Pi imports so that
 * consumer packages can depend on these types without pulling in the TUI.
 */

/** A component and the content rows it occupies in the transcript document. */
export interface Hit {
	/** The component instance itself. */
	component: any;
	/** Constructor name, useful for logging and coarse filtering. */
	name: string;
	/** First content row occupied by this component. */
	start: number;
	/** Number of content rows it occupies. */
	height: number;
	/** Depth in the document tree; 0 is the document root. */
	depth: number;
}

export interface ViewportClickEvent {
	/** Innermost component under the click. */
	target: any;
	/**
	 * Every component whose rows contain the click, outermost first. Ranges nest,
	 * so this is the ancestor path from the document root down to `target`.
	 */
	chain: Hit[];
	/** Content row clicked, in document coordinates (not screen coordinates). */
	row: number;
	/** Screen column of the click, zero-based. */
	x: number;
	/** Screen row of the click, zero-based. */
	y: number;
	/** SGR button code of the originating event. */
	button: number;
	/**
	 * Nearest component in the chain satisfying `predicate`, searched innermost
	 * first. Use this rather than `target`: a component may render transparently,
	 * so the innermost hit is often a child of the unit you care about.
	 */
	closest(predicate: (component: any) => boolean): any | undefined;
	/** Row offset of the click inside `component`, or -1 if it is not in the chain. */
	rowWithin(component: any): number;
	/** Request a redraw after mutating a component. */
	requestRender(): void;
	/** Show a transient message in the alternate-screen flash stack. */
	flash(message: string, durationMs?: number): void;
	/** The primary ScrollView the click landed in. */
	scrollView: any;
	/** The TuiAltScreen instance, for anything the helpers above do not cover. */
	tui: any;
}

/**
 * Return `true` to claim the click. Claiming stops dispatch, so later handlers
 * do not see it. Return `false` or nothing to pass it on.
 */
export type ViewportClickHandler = (event: ViewportClickEvent) => boolean | void;

export interface ViewportMouseRegistry {
	/** Contract version. Bumped only for breaking changes to the event shape. */
	version: number;
	/** Registered handlers, keyed. Dispatch follows insertion order. */
	handlers: Map<string, ViewportClickHandler>;
	/**
	 * Register a handler under `key`, replacing any handler already using it.
	 * Returns an unsubscribe function.
	 */
	on(key: string, handler: ViewportClickHandler): () => void;
	/** Remove the handler registered under `key`. */
	off(key: string): void;
}

/**
 * The registry lives on `globalThis` under this symbol because Pi has no
 * extension-to-extension event bus. Both this extension and its consumers create
 * it lazily, so extension load order does not matter.
 */
export const VIEWPORT_MOUSE_KEY = Symbol.for("pi.viewport-mouse.v1");
