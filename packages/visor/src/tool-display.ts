import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { compactResult, extractToolText, formatDuration, formatTime, notifyOnce, stripAnsi } from "./format.js";
import { debugLog } from "./pi-modules.js";
import { toolArgSummary } from "./tool-args.js";

// ── Tool display ─────────────────────────────────────────────────────────────
export const UNCOVERED = new Set([
  "bash",
  "grep",
  "web_search",
  "web_fetch",
  "fetch_content",
  "get_search_content",
  "source_check",
  "ticket_get",
  "ticket_list",
  "ticket_create",
  "ticket_update",
  "ticket_comment",
  "ticket_comment_reply",
  "ticket_comment_update",
  "project_context",
  "sessions_dispatchable",
  "ticket_dispatch",
  "session_notify",
  "session_role",
  "ack",
  "respond",
  "look_at",
  "interactive_bash",
  "glob",
]);

export type CallRenderer = (args: unknown, theme: unknown, context: unknown) => unknown;
export type ResultRenderer = (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;

/**
 * How long the call took, frozen at the first render that carries a settled
 * result. `formatDuration` measures against `Date.now()`, so re-rendering an old
 * block — which is exactly what expanding one does — reports the time since the
 * call rather than how long it took. A 1.25s call read 26.00s after ctrl+O.
 */
export function settledDuration(
  ctx: { state?: Record<string, unknown> } | undefined,
  startedAt: number | undefined,
): string {
  if (!startedAt) return "";
  const state = ctx?.state;
  if (state && typeof state.endedAt !== "number") state.endedAt = Date.now();
  const end = typeof state?.endedAt === "number" ? state.endedAt : Date.now();
  const ms = Math.max(0, end - startedAt);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/** The shared footer: `↳ N lines • hh:mm:ss • dur (ctrl+o)`. One grammar, one place. */
export function collapsedBlock(
  t: { fg: (c: string, s: string) => string },
  result: unknown,
  text: string,
  startedAt: number | undefined,
  dur: string,
): unknown {
  const lines = text ? text.split("\n") : [];
  const lineCount = lines.filter((l) => l.trim()).length || lines.length;
  const ts = formatTime(startedAt);
  const suffix = (ts ? ` • ${ts}` : "") + (dur ? ` • ${dur}` : "") + " (ctrl+o)";
  if (!text) return new Text(t.fg("muted", "↳ done") + t.fg("dim", suffix), 0, 0);
  // No output preview at all: a collapsed block is exactly the call line plus
  // this one, two lines total. A JSON payload still gets its summary, folded
  // into the footer's "what you got" slot rather than a line of its own.
  const what = compactResult(result, text) ?? `${lineCount} line${lineCount === 1 ? "" : "s"}`;
  return new Text(t.fg("muted", `↳ ${what}`) + t.fg("dim", suffix), 0, 0);
}

export function createCallRenderer(name: string): CallRenderer {
  return (args: unknown, theme: unknown, context: unknown) => {
    const t = theme as { fg: (c: string, s: string) => string; bold: (s: string) => string };
    const ctx = context as { state?: Record<string, unknown> } | undefined;
    if (ctx?.state && typeof ctx.state.startedAt !== "number") ctx.state.startedAt = Date.now();
    const summary = toolArgSummary(name, (args as Record<string, unknown>) ?? {});
    let line = t.fg("toolTitle", t.bold(name));
    if (summary) line += ` ${t.fg("accent", summary)}`;
    return new Text(line, 0, 0);
  };
}

export function createResultRenderer(): ResultRenderer {
  return (result: unknown, options: unknown, theme: unknown, context: unknown) => {
    const t = theme as { fg: (c: string, s: string) => string };
    const opts = options as { expanded?: boolean; isPartial?: boolean };
    const ctx = context as { state?: Record<string, unknown> } | undefined;
    if (opts?.isPartial) return new Text(t.fg("warning", "…"), 0, 0);
    const startedAt = ctx?.state?.startedAt as number | undefined;
    const dur = settledDuration(ctx, startedAt);
    const text = extractToolText(result);
    if (!opts?.expanded) return collapsedBlock(t, result, text, startedAt, dur);
    const ts = formatTime(startedAt);
    const body = (text ? text.split("\n") : []).map((l) => t.fg("dim", l)).join("\n");
    const footer = ts ? t.fg("dim", `\n— ${ts} • ${dur}`) : "";
    return new Text(body + footer, 0, 0);
  };
}

// Tools whose Pi-native rendering is worth keeping (edit/write diffs, read previews).
// We own the collapsed footer + expand policy; Pi keeps the call line and expanded body.
export const PASSTHROUGH = new Set(["read", "edit", "write", "ls", "find"]);

/**
 * Passthrough: Pi keeps the call line and the expanded body (edit/write diffs,
 * read previews), we own the collapsed state and the footer. `orig` is whatever
 * Pi itself resolved for this component — including the built-in renderer, which
 * is where the diffs actually live, so this must be given the component's own
 * resolved renderer rather than a registered tool definition.
 */
export function createPassthroughResultRenderer(orig: ResultRenderer | undefined): ResultRenderer {
  return (result: unknown, options: unknown, theme: unknown, context: unknown) => {
    const t = theme as { fg: (c: string, s: string) => string };
    const opts = options as { expanded?: boolean; isPartial?: boolean };
    const ctx = context as { state?: Record<string, unknown> } | undefined;
    if (opts?.isPartial) return new Text(t.fg("warning", "…"), 0, 0);
    const startedAt = ctx?.state?.startedAt as number | undefined;
    const dur = settledDuration(ctx, startedAt);
    if (!opts?.expanded) return collapsedBlock(t, result, extractToolText(result), startedAt, dur);

    const ts = formatTime(startedAt);
    const origOut = (() => {
      try { return orig ? orig(result, options, theme, context) : undefined; } catch { return undefined; }
    })();
    const footLine = t.fg("dim", `— ${ts ? ts + " • " : ""}${dur || "0ms"}`);
    const rawBody = () => (extractToolText(result) || "").split("\n").map((l) => t.fg("dim", l));
    if (!origOut || typeof (origOut as { render?: unknown }).render !== "function") {
      return new Text([...rawBody(), footLine].join("\n"), 0, 0);
    }
    return {
      render: (width: number) => {
        let lines: string[] = [];
        try { lines = (origOut as { render: (w: number) => string[] }).render(width) ?? []; } catch {}
        // Pi's edit/write renderers write their diff into the CALL component and
        // can legitimately return nothing. Only substitute the raw text when the
        // expansion would otherwise be empty, so we never hide the output.
        if (lines.every((l) => !stripAnsi(l).trim())) lines = rawBody();
        return [...lines, footLine];
      },
      invalidate() { try { (origOut as { invalidate?: () => void }).invalidate?.(); } catch {} },
    };
  };
}

/**
 * Start the clock when the call line is drawn. Our own call renderer does this
 * inline; passthrough tools keep Pi's call renderer, so it has to be wrapped or
 * every passthrough block reports a 0ms duration.
 */
export function withTiming(orig: CallRenderer | undefined): CallRenderer | undefined {
  if (!orig) return orig;
  return (args: unknown, theme: unknown, context: unknown) => {
    const ctx = context as { state?: Record<string, unknown> } | undefined;
    if (ctx?.state && typeof ctx.state.startedAt !== "number") ctx.state.startedAt = Date.now();
    return orig(args, theme, context);
  };
}

// ── Deterministic tool decoration — ToolExecutionComponent choke point ────────
//
// Why here and not at the tool registry:
//
//   Every transcript block is a ToolExecutionComponent. It asks itself three
//   questions while drawing — hasRendererDefinition(), getCallRenderer(),
//   getResultRenderer() — and those already resolve Pi's own precedence between
//   the registered tool definition and the built-in one
//   (`toolDefinition.renderX ?? builtInToolDefinition.renderX`). Wrapping the
//   component's methods therefore sits downstream of every source of renderers:
//   built-ins, extension tools and MCP tools alike.
//
//   The registry is the wrong place. `_toolDefinitions` and `_toolRegistry` are
//   rebuilt on every refresh, so anything captured there goes stale, and
//   registration order is a race. The component asks per render, so there is
//   nothing to miss and nothing to keep in sync.
//
//   It also gives passthrough tools something the registry cannot: the ORIGINAL
//   resolved renderer, `origGetResult.call(this)`. For read/edit/write the diff
//   and preview renderers live on builtInToolDefinition, which never appears in
//   the registry at all.
//
// The patch must be installed before the first component is constructed, because
// the constructor calls getRenderShell() to pick its container. Extension load
// happens long before the first turn, so that holds.

/** Tools whose rendering this extension owns end to end. */
export function ownsTool(name: string): boolean {
  return UNCOVERED.has(name) || PASSTHROUGH.has(name);
}

let componentPatched = false;

export function patchToolExecutionComponent(): boolean {
  if (componentPatched) return true;
  const proto = (ToolExecutionComponent as unknown as { prototype?: Record<string, unknown> })?.prototype;
  if (!proto) return false;
  if ((proto as Record<string, unknown>).__visorToolDisplay) {
    componentPatched = true;
    return true;
  }

  const origHasRenderer = proto.hasRendererDefinition as () => boolean;
  const origGetCall = proto.getCallRenderer as () => CallRenderer | undefined;
  const origGetResult = proto.getResultRenderer as () => ResultRenderer | undefined;
  const origGetShell = proto.getRenderShell as () => string;
  if (
    typeof origHasRenderer !== "function" ||
    typeof origGetCall !== "function" ||
    typeof origGetResult !== "function" ||
    typeof origGetShell !== "function"
  ) {
    return false;
  }

  type Self = { toolName: string };

  // Owned tools always take the renderer path, never the raw formatToolExecution()
  // text dump — that fallback is what printed MCP results as raw JSON.
  proto.hasRendererDefinition = function (this: Self) {
    return ownsTool(this.toolName) || origHasRenderer.call(this);
  };

  // Uniform framing for owned blocks. A tool asking for the "self" shell would
  // otherwise skip the Box, and the constructor and updateDisplay would disagree
  // about which container holds the content.
  proto.getRenderShell = function (this: Self) {
    return ownsTool(this.toolName) ? "default" : origGetShell.call(this);
  };

  proto.getCallRenderer = function (this: Self) {
    if (UNCOVERED.has(this.toolName)) return createCallRenderer(this.toolName);
    if (PASSTHROUGH.has(this.toolName)) return withTiming(origGetCall.call(this));
    return origGetCall.call(this);
  };

  proto.getResultRenderer = function (this: Self) {
    if (UNCOVERED.has(this.toolName)) return createResultRenderer();
    if (PASSTHROUGH.has(this.toolName)) return createPassthroughResultRenderer(origGetResult.call(this));
    return origGetResult.call(this);
  };

  (proto as Record<string, unknown>).__visorToolDisplay = true;
  componentPatched = true;
  return true;
}

export class ToolDisplay {
  install(pi: ExtensionAPI): void {
    let patched = false;
    try {
      patched = patchToolExecutionComponent();
    } catch (e) {
      debugLog(`patchToolExecutionComponent threw ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!patched) {
      // Loud, not silent. A no-op here means every block falls back to Pi-native
      // rendering, which is exactly the failure this design replaced.
      notifyOnce(
        null,
        new Set<string>(),
        "tool-display-failed",
        "pi-visor: could not patch ToolExecutionComponent — tool blocks will render Pi-native",
        "error",
      );
    }
    void pi;
  }
}
