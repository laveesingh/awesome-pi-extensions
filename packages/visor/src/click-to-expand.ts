import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./pi-modules.js";

// ── Click to expand ──────────────────────────────────────────────────────────
// Consumes click events published by the viewport-mouse extension and toggles the
// tool block that was clicked. This extension owns what "collapsed" looks like
// (see createResultRenderer, which reads options.expanded), so it also
// owns expanding one block on demand. It does no hit-testing of its own.

export const VIEWPORT_MOUSE_KEY = Symbol.for("pi.viewport-mouse.v1");
export const CLICK_HANDLER_KEY = "pi-visor.click-to-expand";

export interface ViewportClickEventLike {
  closest(predicate: (component: Record<string, unknown>) => boolean): Record<string, unknown> | undefined;
  requestRender(): void;
  flash(message: string, durationMs?: number): void;
}

export interface ViewportMouseRegistry {
  version: number;
  handlers: Map<string, (event: ViewportClickEventLike) => boolean | void>;
  on(key: string, handler: (event: ViewportClickEventLike) => boolean | void): () => void;
  off(key: string): void;
}

// Created lazily by whichever of the two extensions loads first, so load order
// does not matter. Pi has no extension-to-extension event bus.
export function viewportMouseRegistry(): ViewportMouseRegistry {
  const g = globalThis as unknown as Record<symbol, ViewportMouseRegistry | undefined>;
  let registry = g[VIEWPORT_MOUSE_KEY];
  if (!registry) {
    const handlers = new Map<string, (event: ViewportClickEventLike) => boolean | void>();
    registry = {
      version: 1,
      handlers,
      on(key, handler) {
        handlers.set(key, handler);
        return () => handlers.delete(key);
      },
      off(key) {
        handlers.delete(key);
      },
    };
    g[VIEWPORT_MOUSE_KEY] = registry;
  }
  return registry;
}

export class ClickToExpand {
  private unsubscribe: (() => void) | null = null;

  install(pi: ExtensionAPI): void {
    try {
      this.unsubscribe = viewportMouseRegistry().on(CLICK_HANDLER_KEY, (event) => {
        // A framed group owns native width/row routing. The legacy walker can
        // stop at the frame or accidentally descend at document width; either
        // way defer its entire chain so Pi performs exactly one native toggle.
        if (event.closest((component) => component.__visorRunGroup === true)) return false;
        const block = event.closest((c) => {
          const comp = c as { setExpanded?: unknown; toolName?: unknown; __visorThoughtLine?: unknown };
          if (typeof comp.setExpanded !== "function") return false;
          if (typeof comp.toolName === "string") return true; // a tool block
          // Only the thought LINE, never its owning AssistantMessageComponent.
          // That component also covers the assistant's text reply, so matching
          // it would make clicking anywhere in the reply toggle the thought
          // block. It keeps setExpanded for ctrl+O, which reaches it by a
          // different path (top-level chatContainer walk, not hit-testing).
          return comp.__visorThoughtLine === true;
        });
        if (!block) return false; // not a collapsible block — let other consumers see it
        const target = block as {
          expanded?: boolean;
          toolName?: string;
          __visorThoughtLine?: boolean;
          setExpanded(v: boolean): void;
        };
        const wasExpanded = !!target.expanded;
        target.setExpanded(!wasExpanded);
        event.requestRender();
        const label = target.toolName ?? (target.__visorThoughtLine ? "thinking" : "block");
        event.flash(`${label} ${wasExpanded ? "collapsed" : "expanded"}`);
        return true; // claimed
      });
    } catch (e) {
      debugLog(`ClickToExpand install fail ${e instanceof Error ? e.message : String(e)}`);
    }
    pi.on("session_shutdown", () => this.dispose());
  }

  dispose(): void {
    try {
      this.unsubscribe?.();
    } catch {}
    this.unsubscribe = null;
  }
}
