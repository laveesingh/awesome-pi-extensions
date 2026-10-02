import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ClickToExpand } from "./src/click-to-expand.js";
import { ThinkingManager } from "./src/thinking.js";
import { ToolDisplay } from "./src/tool-display.js";
import { RunGrouping } from "./src/run-integration.js";
import { TurnBar } from "./src/turn-bar.js";

// ── Extension entry ──────────────────────────────────────────────────────────
export default function visorExtension(pi: ExtensionAPI): void {
  const thinking = new ThinkingManager();
  // Give ThinkingManager access to pi for markdown fallback
  (thinking as unknown as { pi?: ExtensionAPI }).pi = pi;
  // Single thinking render path: the patched AssistantMessageComponent.updateContent
  // forces hideThinkingBlock per call, so Pi renders the static "Thinking..."
  // placeholder that the patch then REPLACES with the managed dot-line. The old
  // markdown-transformer fallback was removed — it rendered a duplicate
  // "Thought (0s • ↓ N)" line next to the managed one.

  // The patch targets a statically imported class, so it can install immediately.
  // session_start remains a retry point for a reload that re-runs the factory.
  let patchApplied = false;
  const tryPatch = (ctx?: ExtensionContext): boolean => {
    if (patchApplied) return true;
    try {
      const ok = thinking.installPatch(ctx);
      if (ok) patchApplied = true;
      return ok;
    } catch (e) {
      try {
        console.error("pi-visor: thinking patch failed", e);
        ctx?.ui.notify(`pi-visor thinking patch failed: ${e instanceof Error ? e.message : String(e)}`, "warning");
      } catch {}
      return false;
    }
  };

  // Try immediate (cache may already have it), else defer to session_start
  tryPatch();
  pi.on("session_start", (_e, ctx) => {
    if (!patchApplied) tryPatch(ctx);
    // If still not applied (module not yet loaded), retry once more on next tick
    if (!patchApplied) {
      setTimeout(() => {
        if (!patchApplied) tryPatch(ctx);
      }, 800);
    }
  });

  const turnBar = new TurnBar(thinking);
  const toolDisplay = new ToolDisplay();
  const clickToExpand = new ClickToExpand();
  const runGrouping = new RunGrouping();

  try {
    turnBar.install(pi);
  } catch (e) {
    try {
      console.error("pi-visor: turnBar install failed", e);
    } catch {}
  }
  try {
    toolDisplay.install(pi);
  } catch (e) {
    try {
      console.error("pi-visor: toolDisplay install failed", e);
    } catch {}
  }
  // Slice 2 installs membership/rebuild seams. Native clicks, Ctrl+O cascading
  // and settle policy are the following slice; the controller exposes that seam.
  runGrouping.install(pi);
  try {
    clickToExpand.install(pi);
  } catch (e) {
    try {
      console.error("pi-visor: clickToExpand install failed", e);
    } catch {}
  }

  pi.on("session_shutdown", (event) => {
    const e = event as { reason?: string };
    if (e?.reason === "reload") {
      patchApplied = false;
    }
    thinking.clearTui();
  });
}
