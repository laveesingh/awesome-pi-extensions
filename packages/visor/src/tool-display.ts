import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { timingParts, type RecordedTiming } from "./run-style.js";
import { compactResult, extractToolText, formatTime, notifyOnce, stripAnsi } from "./format.js";
import { debugLog } from "./pi-modules.js";
import { toolArgSummary } from "./tool-args.js";

// ── Tool display ─────────────────────────────────────────────────────────────
// Native rendering is opt-out. Add an exclusion only with a documented reason;
// exclusions take precedence over PASSTHROUGH and have no user-facing setting.
export const EXCLUDED = new Set<string>();

export type CallRenderer = (args: unknown, theme: unknown, context: unknown) => unknown;
export type ResultRenderer = (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;

/** D10 is opt-in per component; flat AWE-1 renderers never see this state. */
export interface GroupToolPresentation {
  timing?: RecordedTiming;
  stopped?: boolean;
  hasResult?: boolean;
  callHeader?: (width: number) => string;
  callBody?: (width: number) => string[];
}
const groupedTools = new WeakMap<object, GroupToolPresentation>();
export function setGroupedToolPresentation(component: object, presentation?: GroupToolPresentation): void {
  if (presentation) groupedTools.set(component, presentation);
  else groupedTools.delete(component);
}

function groupFooter(result: unknown, context: unknown, theme: unknown, presentation: GroupToolPresentation): string {
  const t = theme as { fg(c: string, s: string): string; bold(s: string): string };
  const ctx = context as { state?: Record<string, unknown>; isPartial?: boolean; isError?: boolean };
  if (!presentation.hasResult || ctx?.isPartial) return t.fg("muted", "↳ … running");
  const text = extractToolText(result);
  const lines = text ? text.split("\n") : [];
  const count = lines.filter((line) => line.trim()).length || lines.length;
  let label = `↳ ${count} line${count === 1 ? "" : "s"}`;
  const r = result as { details?: { exitCode?: number; exit_code?: number } };
  const exit = r.details?.exitCode ?? r.details?.exit_code ?? text.match(/(?:Exit code:|Command exited with code)\s*(-?\d+)/i)?.[1];
  const error = ctx?.isError && !presentation.stopped;
  if (error && exit !== undefined) label += ` · exit ${exit}`;
  const startedAt = ctx?.state?.startedAt as number | undefined;
  const timing = presentation.timing ? timingParts(presentation.timing)
    : [formatTime(startedAt), settledDuration(ctx, startedAt)].filter(Boolean);
  const footer = label + timing.map((part) => ` • ${part}`).join("") + " (ctrl+o)";
  return (error ? t.fg("text", t.bold("Error · ")) : "") + t.fg("muted", footer);
}

function groupedResult(
  result: unknown, options: unknown, theme: unknown, context: unknown,
  presentation: GroupToolPresentation, body: (width: number) => string[],
): Component {
  const expanded = !!(options as { expanded?: boolean })?.expanded;
  // Freeze live duration at the settled renderer invocation, not a later draw.
  const footer = groupFooter(result, context, theme, presentation);
  return {
    render(width) {
      if (!expanded) return wrapTextWithAnsi(footer, width);
      const header = presentation.callHeader?.(width) ?? "";
      return [...wrapTextWithAnsi(footer, width), ...wrapTextWithAnsi(header, width), "", ...body(width)];
    },
    invalidate() {},
  };
}

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

export function createCallRenderer(name: string, presentation?: GroupToolPresentation): CallRenderer {
  return (args: unknown, theme: unknown, context: unknown) => {
    const t = theme as { fg: (c: string, s: string) => string; bold: (s: string) => string };
    const ctx = context as { state?: Record<string, unknown>; executionStarted?: boolean; expanded?: boolean } | undefined;
    if (ctx?.executionStarted === true && ctx.state && typeof ctx.state.startedAt !== "number") {
      ctx.state.startedAt = Date.now();
    }
    const summary = toolArgSummary(name, (args as Record<string, unknown>) ?? {});
    let line = t.fg("toolTitle", t.bold(name));
    if (summary) line += ` ${t.fg("accent", summary)}`;
    if (!presentation) return new Text(line, 0, 0);
    presentation.callHeader = () => line;
    presentation.callBody = () => [];
    return {
      render(width: number) {
        return [truncateToWidth(line, width, "…"), ...(!presentation.hasResult
          ? [t.fg("muted", "↳ … running"), ...(ctx?.expanded ? [...wrapTextWithAnsi(line, width), ""] : [])] : [])];
      },
      invalidate() {},
    };
  };
}

export function createResultRenderer(presentation?: GroupToolPresentation): ResultRenderer {
  return (result: unknown, options: unknown, theme: unknown, context: unknown) => {
    const t = theme as { fg: (c: string, s: string) => string };
    const opts = options as { expanded?: boolean; isPartial?: boolean };
    const ctx = context as { state?: Record<string, unknown> } | undefined;
    if (presentation) {
      return groupedResult(result, options, theme, context, presentation, (width) =>
        wrapTextWithAnsi(t.fg("muted", extractToolText(result)), width));
    }
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
 * Pi itself resolved from the component's toolDefinition. Pi 0.99's edit renderer
 * also updates the native call component with the settled diff, even while our
 * result is collapsed. Preserve native lastComponent identities across wrappers.
 */
const nativeComponent = Symbol("visorNativeComponent");
type WrappedComponent = Component & { [nativeComponent]?: Component };

function nativeContext(context: unknown): unknown {
  const ctx = context as { lastComponent?: WrappedComponent } | undefined;
  if (!ctx) return context;
  return { ...ctx, lastComponent: ctx.lastComponent?.[nativeComponent] ?? ctx.lastComponent };
}

function keepNative<T extends object>(component: T, native: unknown): T {
  if (native && typeof (native as Component).render === "function") {
    (component as WrappedComponent)[nativeComponent] = native as Component;
  }
  return component;
}

export function createPassthroughResultRenderer(orig: ResultRenderer | undefined, presentation?: GroupToolPresentation): ResultRenderer {
  return (result: unknown, options: unknown, theme: unknown, context: unknown) => {
    const t = theme as { fg: (c: string, s: string) => string };
    const opts = options as { expanded?: boolean; isPartial?: boolean };
    const ctx = context as { state?: Record<string, unknown> } | undefined;
    if (opts?.isPartial && !presentation) return new Text(t.fg("warning", "…"), 0, 0);
    const startedAt = ctx?.state?.startedAt as number | undefined;
    const dur = settledDuration(ctx, startedAt);
    const origOut = (() => {
      try { return orig ? orig(result, options, theme, nativeContext(context)) : undefined; } catch { return undefined; }
    })();
    if (presentation) {
      return keepNative(groupedResult(result, options, theme, context, presentation, (width) => {
        const callBody = presentation.callBody?.(width) ?? [];
        let resultBody = (origOut as Component | undefined)?.render(width) ?? [];
        if (resultBody.every((line) => !stripAnsi(line).trim())) {
          resultBody = wrapTextWithAnsi(t.fg("dim", extractToolText(result)), width);
        }
        return [...callBody, ...resultBody];
      }), origOut);
    }
    if (!opts?.expanded) {
      return keepNative(collapsedBlock(t, result, extractToolText(result), startedAt, dur) as object, origOut);
    }

    const ts = formatTime(startedAt);
    const timing = [ts, dur].filter(Boolean).join(" • ");
    const footer = timing ? [t.fg("dim", `— ${timing}`)] : [];
    const rawBody = () => (extractToolText(result) || "").split("\n").map((l) => t.fg("dim", l));
    if (!origOut || typeof (origOut as { render?: unknown }).render !== "function") {
      return new Text([...rawBody(), ...footer].join("\n"), 0, 0);
    }
    return keepNative({
      render: (width: number) => {
        let lines: string[] = [];
        try { lines = (origOut as { render: (w: number) => string[] }).render(width) ?? []; } catch {}
        // Pi 0.99's edit diff and write content live in the CALL component, so
        // the native result can legitimately be empty. Substitute raw text when the
        // expansion would otherwise be empty, so we never hide the output.
        if (lines.every((l) => !stripAnsi(l).trim())) lines = rawBody();
        return [...lines, ...footer];
      },
      invalidate() { try { (origOut as { invalidate?: () => void }).invalidate?.(); } catch {} },
    }, origOut);
  };
}

/**
 * Start the clock only after Pi marks a live execution as started. Rebuilt
 * transcript components never receive that mark, so they must not invent a
 * resume clock or duration. Passthrough calls need the same timing guard.
 */
export function withTiming(orig: CallRenderer | undefined, selfShell = false, presentation?: GroupToolPresentation): CallRenderer | undefined {
  if (!orig) return orig;
  return (args: unknown, theme: unknown, context: unknown) => {
    const ctx = context as { state?: Record<string, unknown>; expanded?: boolean; executionStarted?: boolean } | undefined;
    if (ctx?.executionStarted === true && ctx.state && typeof ctx.state.startedAt !== "number") {
      ctx.state.startedAt = Date.now();
    }
    const native = orig(args, theme, nativeContext(context)) as Component;
    const nativeLines = (width: number) => {
      const children = (native as Component & { children?: Component[] }).children;
      return selfShell && Array.isArray(children) ? children.flatMap((child) => child.render(width)) : native.render(width);
    };
    if (presentation) {
      const n = native as Component & { text?: string; children?: Array<{ text?: string }> };
      presentation.callHeader = (width) => (n.text ?? n.children?.[0]?.text)?.split("\n")[0]
        ?? nativeLines(width).find((line) => stripAnsi(line).trim()) ?? "";
      presentation.callBody = (width) => {
        const lines = nativeLines(width).slice(wrapTextWithAnsi(presentation.callHeader!(width), width).length);
        while (lines.length && !stripAnsi(lines[0]).trim()) lines.shift();
        while (lines.length && !stripAnsi(lines.at(-1)!).trim()) lines.pop();
        return lines;
      };
    }
    return keepNative({
      render(width: number) {
        // Edit owns a Box in Pi 0.99's self shell. Visor supplies the outer Box,
        // so render its children without adding a second frame or padding.
        // Pi's shrinkwrap can install a second pi-tui copy. Use the public
        // children contract rather than instanceof across module identities.
        if (presentation) {
          const t = theme as { fg(c: string, s: string): string };
          const header = presentation.callHeader!(width);
          return [truncateToWidth(header, width, "…"), ...(!presentation.hasResult
            ? [t.fg("muted", "↳ … running"), ...(ctx?.expanded
              ? [...wrapTextWithAnsi(header, width), "", ...presentation.callBody!(width)] : [])] : [])];
        }
        const lines = nativeLines(width);
        // Native edit/write calls include body previews. Only the header belongs
        // in the two-line collapsed form; retain the full native body on expand.
        return ctx?.expanded ? lines : lines.filter((line) => stripAnsi(line).trim()).slice(0, 1);
      },
      invalidate() { native.invalidate?.(); },
    }, native);
  };
}

// ── Deterministic tool decoration — ToolExecutionComponent choke point ────────
//
// Why here and not at the tool registry:
//
//   Every transcript block is a ToolExecutionComponent. It asks itself three
//   questions while drawing — hasRendererDefinition(), getCallRenderer(),
//   getResultRenderer() — which resolve toolDefinition's renderers in Pi 0.99.
//   Wrapping the component's methods sits downstream of every source of tool
//   definitions: built-ins, extension tools and MCP tools alike.
//
//   The registry is the wrong place. `_toolDefinitions` and `_toolRegistry` are
//   rebuilt on every refresh, so anything captured there goes stale, and
//   registration order is a race. The component asks per render, so there is
//   nothing to miss and nothing to keep in sync.
//
//   It also gives passthrough tools something the registry cannot: the ORIGINAL
//   resolved renderer, `origGetResult.call(this)`, together with the native call
//   renderer. On Pi 0.99 these carry read previews and edit/write bodies.
//
// The patch must be installed before the first component is constructed, because
// the constructor calls getRenderShell() to pick its container. Extension load
// happens long before the first turn, so that holds.

/** Tools whose rendering this extension owns end to end. */
export function ownsTool(name: string): boolean {
  return !EXCLUDED.has(name);
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

  type Self = { toolName: string; result?: unknown };

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
    if (!ownsTool(this.toolName)) return origGetCall.call(this);
    const presentation = groupedTools.get(this);
    if (presentation) presentation.hasResult = this.result !== undefined;
    if (PASSTHROUGH.has(this.toolName)) {
      return withTiming(origGetCall.call(this), origGetShell.call(this) === "self", presentation)
        ?? createCallRenderer(this.toolName, presentation);
    }
    return createCallRenderer(this.toolName, presentation);
  };

  proto.getResultRenderer = function (this: Self) {
    if (!ownsTool(this.toolName)) return origGetResult.call(this);
    const presentation = groupedTools.get(this);
    if (PASSTHROUGH.has(this.toolName)) return createPassthroughResultRenderer(origGetResult.call(this), presentation);
    return createResultRenderer(presentation);
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
