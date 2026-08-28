import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { Text } from "@earendil-works/pi-tui";
import { formatDurShort, formatTokensShort, notifyOnce, stripAnsi, themeFg, wrapPlain } from "./format.js";
import { debugLog, loadAssistantMessageModule } from "./pi-modules.js";

/**
 * Give AssistantMessageComponent the same expansion contract a tool block has.
 *
 * Pi's `setToolsExpanded` (ctrl+O) walks `chatContainer.children` — the TOP
 * level only — and calls `setExpanded` on anything that has it. The managed
 * thought line is nested inside the component's contentContainer, so ctrl+O can
 * never reach it directly; the component itself has to carry the method.
 *
 * `invalidate()` on this class already re-runs `updateContent(lastMessage)`, so
 * flipping the flag and invalidating rebuilds the line through the same patch
 * that created it. No second render path.
 */
export function installThinkingExpansion(proto: Record<string, unknown>): void {
  if (proto.__visorThinkExpandable) return;
  proto.setExpanded = function (this: Record<string, unknown>, expanded: boolean) {
    // Assistant messages without thinking are still visited by ctrl+O. Doing
    // nothing keeps that from rebuilding every message in the transcript.
    if (!this.__visorHasThinking) return;
    if (!!this.__visorThinkExpanded === !!expanded) return;
    this.__visorThinkExpanded = !!expanded;
    try {
      (this as { invalidate?: () => void }).invalidate?.();
    } catch {}
  };
  Object.defineProperty(proto, "expanded", {
    configurable: true,
    get(this: Record<string, unknown>) {
      return !!this.__visorThinkExpanded;
    },
  });
  proto.__visorThinkExpandable = true;
}

// ── Thinking block ───────────────────────────────────────────────────────────
/** The managed thought line: a component that is also an expandable block. */
export interface ThoughtLine {
  /** Marks this as the click target for thought expansion — see ClickToExpand. */
  __visorThoughtLine: true;
  readonly expanded: boolean;
  setExpanded(expanded: boolean): void;
  render(width: number): string[];
  invalidate(): void;
}

export type ThinkSnapshot = { durMs: number; tokens: number };

export class ThinkingManager {
  active = false;
  startAt = 0;
  chars = 0;
  msgRef: unknown = null;
  // Stable id for active thinking — used when Pi clones message objects
  activeId: string | null = null;
  activeContentKey: string | null = null;
  frozen = new WeakMap<object, ThinkSnapshot>();
  frozenByContent = new WeakMap<unknown[], ThinkSnapshot>();
  // Fallback by content hash for history (when WeakMap misses due to clone)
  frozenByHash = new Map<string, ThinkSnapshot>();
  pendingSnap: ThinkSnapshot | null = null;

  tui: { requestRender: (force?: boolean) => void } | null = null;
  ctx: ExtensionContext | null = null;
  private warned = new Set<string>();

  get isActive(): boolean {
    return this.active;
  }

  resetForNewRun(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.active = false;
    this.chars = 0;
    this.msgRef = null;
    this.activeId = null;
    this.activeContentKey = null;
  }

  captureTui(ctx: ExtensionContext): void {
    this.ctx = ctx;
    try {
      (ctx.ui as unknown as { setWidget?: (id: string, c: unknown) => void }).setWidget?.("think-tick", (tui: unknown) => {
        this.tui = tui as { requestRender: (force?: boolean) => void } | null;
        // When TUI becomes available, retry patch via instance (handles bundled cli.js case)
        try {
          setTimeout(() => {
            try {
              this.installPatch(ctx);
            } catch {}
          }, 100);
        } catch {}
        return { render: () => [] as string[], invalidate() {} };
      });
    } catch {}
  }

  clearTui(): void {
    this.tui = null;
  }

  private contentHash(content: unknown[]): string {
    try {
      // Hash first 200 chars of concatenated thinking text
      let s = "";
      for (const b of content as Array<{ type?: string; thinking?: string }>) {
        if (b?.type === "thinking" && typeof b.thinking === "string") s += b.thinking.slice(0, 200);
        if (s.length >= 400) break;
      }
      // Simple hash: length + first 80 chars
      return `${s.length}:${s.slice(0, 80)}`;
    } catch {
      return "";
    }
  }

  private getMessageId(message: unknown): string | null {
    try {
      const m = message as Record<string, unknown>;
      if (typeof m.id === "string") return m.id;
      if (typeof (m as { messageId?: unknown }).messageId === "string") return (m as { messageId?: string }).messageId!;
    } catch {}
    return null;
  }

  trackMessageUpdate(type: string | undefined, delta: string | undefined, message: unknown): void {
    if (type === "thinking_start") {
      this.active = true;
      this.startAt = Date.now();
      this.chars = 0;
      this.msgRef = message ?? null;
      this.activeId = this.getMessageId(message);
      try {
        const c = (message as { content?: unknown[] })?.content;
        this.activeContentKey = Array.isArray(c) ? this.contentHash(c) : null;
      } catch {
        this.activeContentKey = null;
      }
      // For bundled Pi, the file-patch may have missed the actual class — try TUI instance patch now that we have a thinking event
      try {
        if (this.tui) this.patchViaTuiInstance();
      } catch {}
      return;
    }
    if (type === "thinking_delta" && typeof delta === "string" && delta.length) {
      if (!this.active) {
        this.active = true;
        this.startAt = Date.now();
        this.chars = 0;
        this.activeId = this.getMessageId(message);
      }
      this.msgRef = message ?? this.msgRef;
      if (!this.activeId) this.activeId = this.getMessageId(message);
      this.chars += delta.length;
      return;
    }
    if (type === "thinking_end") {
      this.snapshotPending(message);
      this.active = false;
      return;
    }
    if (typeof delta === "string" && delta.length && (type === "text_delta" || type === "toolcall_delta")) {
      if (this.active) this.snapshotPending(message);
      this.active = false;
    }
  }

  private snapshotPending(message: unknown): void {
    try {
      const durMs = Math.max(0, Date.now() - this.startAt);
      const snap: ThinkSnapshot = { durMs, tokens: Math.round(this.chars / 4) };
      this.pendingSnap = snap;
      const m = message as unknown as { content?: unknown[] } | null;
      if (m && Array.isArray(m.content)) {
        this.frozen.set(m as object, snap);
        this.frozenByContent.set(m.content as unknown[], snap);
        const h = this.contentHash(m.content as unknown[]);
        if (h) this.frozenByHash.set(h, snap);
      }
    } catch {}
  }

  finalizeMessage(msg: Record<string, unknown>): void {
    const content = (msg as { content?: unknown[] }).content;
    const hasThinking =
      Array.isArray(content) && (content as Array<{ type?: string }>).some((c) => c?.type === "thinking");
    if (hasThinking) {
      const durMs = this.startAt ? Math.max(0, Date.now() - this.startAt) : 0;
      const snap: ThinkSnapshot = { durMs, tokens: Math.round(this.chars / 4) };
      try {
        this.frozen.set(msg as object, snap);
      } catch {}
      try {
        const arr = (msg.content as unknown[]) as unknown[];
        this.frozenByContent.set(arr, snap);
        const h = this.contentHash(arr as unknown[]);
        if (h) this.frozenByHash.set(h, snap);
      } catch {}
      this.pendingSnap = null;
      this.active = false;
      this.msgRef = null;
      this.activeId = null;
      this.activeContentKey = null;
      return;
    }
    if (msg) {
      this.active = false;
      this.msgRef = null;
      this.activeId = null;
      this.activeContentKey = null;
      this.pendingSnap = null;
    }
  }

  // Synthesize a snapshot for historical messages that have no frozen data.
  private synthesizeSnap(message: unknown): ThinkSnapshot | null {
    try {
      const m = message as { content?: Array<{ type?: string; thinking?: string; thinkingSignature?: string }> };
      if (!m || !Array.isArray(m.content)) return null;
      let totalChars = 0;
      let hasThinking = false;
      let hasSignature = false;
      for (const b of m.content) {
        if (b?.type === "thinking") {
          hasThinking = true;
          if (typeof b.thinking === "string") totalChars += b.thinking.length;
          if (typeof b.thinkingSignature === "string" && b.thinkingSignature.length > 10) hasSignature = true;
        }
      }
      if (!hasThinking) return null;
      // Encrypted thinking (opencode-go) has empty thinking but signature — show 0 tokens, not legacy
      if (totalChars === 0 && hasSignature) return { durMs: 0, tokens: 0 };
      if (totalChars === 0) return null;
      return { durMs: 0, tokens: Math.round(totalChars / 4) };
    } catch {
      return null;
    }
  }

  // Check if a message is the latest assistant message in the current branch.
  private isLatestAssistantMessage(message: unknown): boolean {
    try {
      const branch = (this.ctx as unknown as { sessionManager?: { getBranch?: () => unknown[] } })?.sessionManager?.getBranch?.();
      if (!Array.isArray(branch)) return false;
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i] as Record<string, unknown>;
        if (e.type !== "message") continue;
        const msg = e.message as Record<string, unknown> | undefined;
        if (!msg || msg.role !== "assistant") continue;
        // Match by reference or by id/timestamp
        if (msg === message) return true;
        const a = msg as { id?: string; timestamp?: number };
        const b = message as { id?: string; timestamp?: number };
        if (a.id && b.id && a.id === b.id) return true;
        if (a.timestamp && b.timestamp && Math.abs(a.timestamp - b.timestamp) < 2000) {
          // Also check thinking length similarity to avoid false positive for old messages
          const ac = (a as unknown as { content?: unknown[] })?.content as Array<{ thinking?: string }> | undefined;
          const bc = (b as unknown as { content?: unknown[] })?.content as Array<{ thinking?: string }> | undefined;
          const at = ac?.find((c) => c?.thinking)?.thinking?.slice(0, 40) ?? "";
          const bt = bc?.find((c) => c?.thinking)?.thinking?.slice(0, 40) ?? "";
          if (at && bt && at === bt) return true;
        }
        return false; // latest assistant is not this message
      }
    } catch {}
    return false;
  }

  buildLine(snap: ThinkSnapshot | null): string {
    const live = snap === null;
    const durMs = live ? Date.now() - this.startAt : snap.durMs;
    const tokens = live ? Math.round(this.chars / 4) : snap.tokens;
    const bright = live && Date.now() % 1000 < 500;
    const dotChar = !live ? "●" : bright ? "●" : "○";
    const dot = themeFg(this.ctx, !live ? "dim" : bright ? "success" : "dim", dotChar);
    const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
    const labelText = live ? "Thinking" : "Thought";
    const label = themeFg(this.ctx, "muted", italic(labelText));
    const stats = themeFg(this.ctx, "muted", ` (${formatDurShort(durMs)} • ↓ ${formatTokensShort(tokens)})`);
    return `${dot} ${label}${stats}`;
  }

  /**
   * The managed thought line, expandable like a tool block.
   *
   * The expansion flag lives on the owning AssistantMessageComponent, not in
   * this closure, and is read at render time. That matters because expanding
   * does not re-enter updateContent with a new component — Pi's
   * AssistantMessageComponent.invalidate() re-runs updateContent, which builds a
   * fresh line, but a click may also land between rebuilds.
   */
  makeThoughtLine(
    owner: Record<string, unknown>,
    snap: ThinkSnapshot | null,
    padVal: number,
  ): ThoughtLine {
    const self = this;
    return {
      // Click target marker. The expansion API lives HERE and not only on the
      // owning AssistantMessageComponent, because that component spans the
      // thought line AND the assistant's text reply — putting the only
      // setExpanded on it made the entire reply a hitbox for the thought block.
      // These rows belong to the thought line alone.
      __visorThoughtLine: true,
      get expanded() {
        return !!owner.__visorThinkExpanded;
      },
      setExpanded(expanded: boolean) {
        if (!!owner.__visorThinkExpanded === !!expanded) return;
        owner.__visorThinkExpanded = !!expanded;
        try {
          (owner as { invalidate?: () => void }).invalidate?.();
        } catch {}
      },
      render: (width: number) => {
        const pad = " ".repeat(Math.max(0, padVal));
        const text = typeof owner.__visorThinking === "string" ? owner.__visorThinking : "";
        const expanded = !!owner.__visorThinkExpanded;
        const hint = !expanded && text.trim() ? themeFg(self.ctx, "dim", " (ctrl+o)") : "";
        const head = pad + self.buildLine(snap) + hint;
        if (!expanded || !text.trim()) return [head];
        const body = wrapPlain(text.trim(), Math.max(20, width - padVal - 1));
        const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
        return [head, ...body.map((l) => pad + themeFg(self.ctx, "thinkingText", italic(l)))];
      },
      invalidate() {},
    };
  }

  /** Record the message's thinking text on the component that owns it. */
  captureThinking(owner: Record<string, unknown>, message: unknown): void {
    try {
      const content = (message as { content?: Array<{ type?: string; thinking?: string }> } | null)?.content;
      const blocks = Array.isArray(content)
        ? content
            .filter((c) => c?.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim())
            .map((c) => (c.thinking as string).trim())
        : [];
      owner.__visorThinking = blocks.join("\n\n");
      owner.__visorHasThinking = blocks.length > 0;
    } catch {}
  }

  // Resolve a snapshot for a message: frozen → pending → synthesized (history).
  resolveSnap(message: unknown): ThinkSnapshot | null {
    try {
      let snap: ThinkSnapshot | null | undefined = this.frozen.get(message as object) ?? null;
      if (!snap) {
        const arr = (message as unknown as { content?: unknown[] })?.content as unknown[] | undefined;
        if (arr) {
          snap = this.frozenByContent.get(arr as unknown[]) ?? null;
          if (!snap) {
            const h = this.contentHash(arr as unknown[]);
            if (h) snap = this.frozenByHash.get(h) ?? null;
          }
        }
      }
      if (!snap) snap = this.pendingSnap ?? null;
      if (!snap) snap = this.synthesizeSnap(message);
      return snap ?? null;
    } catch {
      return this.pendingSnap ?? this.synthesizeSnap(message);
    }
  }

  isLiveForMessage(message: unknown): boolean {
    if (!this.active) return false;
    // Most reliable for live: if active and message is the latest assistant message, it's the one being streamed
    try {
      if (this.isLatestAssistantMessage(message)) return true;
    } catch {}
    if (this.msgRef === message) return true;
    try {
      const arr = (message as unknown as { content?: unknown[] })?.content as unknown[] | undefined;
      if (arr && this.msgRef && (this.msgRef as { content?: unknown[] })?.content === arr) return true;
      const mid = this.getMessageId(message);
      if (mid && this.activeId && mid === this.activeId) return true;
      if (arr && this.activeContentKey) {
        const h = this.contentHash(arr as unknown[]);
        if (h && h === this.activeContentKey) return true;
      }
    } catch {}
    return false;
  }

  // Try to patch via instance found in TUI (for bundled cli.js where file patch misses)
  private patchViaTuiInstance(): boolean {
    try {
      const tui = this.tui as unknown as Record<string, unknown> | null;
      debugLog(`patchViaTuiInstance tui=${!!tui} keys=${tui ? Object.keys(tui as object).slice(0,10).join(',') : 'no'}`);
      if (!tui) return false;
      // Dump TUI prototype keys for debugging
      try {
        const proto = Object.getPrototypeOf(tui as object) as Record<string, unknown> | null;
        debugLog(`patchViaTuiInstance tui proto keys=${proto ? Object.getOwnPropertyNames(proto).slice(0,20).join(',') : 'no'}`);
      } catch {}
      // Also try to find via globalThis and require.cache for bundled case
      try {
        const req = createRequire(import.meta.url) as unknown as { cache?: Record<string, { exports: unknown }> };
        const cache = req.cache;
        if (cache) {
          const piKeys = Object.keys(cache).filter(k => k.includes("pi") || k.includes("bundle") || k.includes("interactive-mode"));
          debugLog(`patchViaTuiInstance cache pi keys=${piKeys.slice(0,5).join(',')}`);
          for (const key of piKeys.slice(0,10)) {
            const mod = cache[key]?.exports as Record<string, unknown> | undefined;
            if (mod && (mod as Record<string, unknown>).AssistantMessageComponent) {
              debugLog(`patchViaTuiInstance found AssistantMessageComponent in cache ${key}`);
            }
          }
        }
      } catch (e) {
        debugLog(`patchViaTuiInstance cache scan fail ${e instanceof Error ? e.message : String(e)}`);
      }
      const candidates: unknown[] = [];
      const seen = new WeakSet<object>();
      const queue: unknown[] = [tui];
      // Also try globalThis for any cached component
      try {
        const maybeGlobal = (globalThis as Record<string, unknown>).AssistantMessageComponent as unknown;
        if (maybeGlobal) candidates.push(maybeGlobal);
      } catch {}
      let steps = 0;
      while (queue.length && steps < 500) {
        steps++;
        const cur = queue.shift() as Record<string, unknown> | null;
        if (!cur || typeof cur !== "object" || seen.has(cur as object)) continue;
        seen.add(cur as object);
        try {
          const proto = Object.getPrototypeOf(cur) as Record<string, unknown> | null;
          const ctor = (proto as { constructor?: { name?: string } })?.constructor;
          if (ctor?.name === "AssistantMessageComponent" && typeof (cur as { updateContent?: unknown }).updateContent === "function") {
            candidates.push(cur);
          }
        } catch {}
        // Traverse known container properties
        for (const key of ["children", "contentContainer", "root", "child", "components", "_children"]) {
          const val = cur[key];
          if (Array.isArray(val)) queue.push(...val);
          else if (val && typeof val === "object") queue.push(val);
        }
        // Also check all own properties that are objects
        try {
          for (const k of Object.keys(cur)) {
            const v = cur[k];
            if (v && typeof v === "object" && !seen.has(v as object) && queue.length < 500) {
              if (Array.isArray(v)) queue.push(...(v as unknown[]));
              else queue.push(v);
            }
          }
        } catch {}
      }
      if (candidates.length === 0) return false;
      // Patch the prototype of the first found instance
      const inst = candidates[0] as Record<string, unknown>;
      const proto = Object.getPrototypeOf(inst) as Record<string, unknown>;
      const orig = proto.updateContent as ((msg: unknown, streaming?: boolean) => void) | undefined;
      if (!orig || (orig as unknown as Record<string, unknown>).__visorThinkPatched) return true;
      debugLog(`patchViaTuiInstance found ${candidates.length} instances, patching proto of ${String((proto.constructor as { name?: string })?.name)}`);
      // Reuse the same patched logic as file-based patch — create a new patched function
      const self = this;
      const patched = function (this: Record<string, unknown>, message: unknown, isStreaming?: boolean) {
        // Force placeholder mode (single managed render path) — see installPatch variant.
        try { this.hideThinkingBlock = true; } catch {}
        (orig as (msg: unknown, streaming?: boolean) => void).call(this, message, isStreaming);
        const owner = this;
        self.captureThinking(owner, message);
        try {
          const m = message as { content?: Array<{ type?: string; thinking?: string }> } | null;
          if (!m || !Array.isArray(m.content) || !m.content.some((c) => c?.type === "thinking")) return;
          const container = this.contentContainer as { children?: unknown[] } | undefined;
          const kids = container?.children;
          if (!Array.isArray(kids)) return;
          let placeholderIndex = -1;
          const placeholderIdxs: number[] = [];
          let placeholder: { text?: unknown; paddingX?: unknown } | null = null;
          for (let i = 0; i < kids.length; i++) {
            const k = kids[i] as { text?: unknown } | null;
            if (!k || typeof k.text !== "string") continue;
            const stripped = stripAnsi(k.text).trim();
            if (stripped === "Thinking..." || stripped === "Thinking…" || stripped.startsWith("Thinking")) {
              placeholderIdxs.push(i);
              if (!placeholder) placeholder = k as { text?: unknown; paddingX?: unknown };
            }
          }
          placeholderIndex = placeholderIdxs.length > 0 ? placeholderIdxs[0] : -1;
          const isLive = self.isLiveForMessage(message);
          let snap = self.resolveSnap(message);
          const snapForRender = isLive ? null : snap;
          if (placeholderIndex === -1) {
            if (!snap && !isLive) return;
            const lineComp = self.makeThoughtLine(owner, snapForRender, 1);
            let insertAt = 0;
            for (let i = 0; i < kids.length; i++) {
              const c = kids[i] as { constructor?: { name?: string } } | null;
              if (c?.constructor?.name !== "Spacer") { insertAt = i; break; }
            }
            kids.splice(insertAt, 0, lineComp as unknown);
            return;
          }
          if (!isLive && !snap) {
            const totalChars = (m.content as Array<{ thinking?: string }>).reduce((a, c) => a + (c.thinking?.length || 0), 0);
            if (totalChars === 0) snap = { durMs: 0, tokens: 0 }; else return;
          }
          const finalSnap = isLive ? null : (snap ?? { durMs: 0, tokens: 0 });
          const padVal = typeof placeholder?.paddingX === "number" ? placeholder.paddingX : 1;
          const lineComp = self.makeThoughtLine(owner, finalSnap as ThinkSnapshot | null, padVal as number);
          for (const idx of placeholderIdxs) kids[idx] = lineComp as unknown;
        } catch (e) {
          notifyOnce(self.ctx, self.warned, "patch-render", `pi-visor patch render error: ${e instanceof Error ? e.message : String(e)}`, "warning");
        }
      };
      (patched as unknown as Record<string, unknown>).__visorThinkPatched = true;
      (patched as unknown as Record<string, unknown>).__visorThinkPatchedAt = Date.now();
      (patched as unknown as Record<string, unknown>).__visorThinkPatchedVia = "tui-instance";
      proto.updateContent = patched as unknown as (msg: unknown) => void;
      installThinkingExpansion(proto);
      debugLog(`patchViaTuiInstance success`);
      return true;
    } catch (e) {
      debugLog(`patchViaTuiInstance fail ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  installPatch(ctxForNotify?: ExtensionContext): boolean {
    debugLog(`installPatch called ctx=${!!ctxForNotify || !!this.ctx}`);
    let mod: Record<string, unknown> | null = null;
    let lastError: string | null = null;

    try {
      mod = loadAssistantMessageModule();
      debugLog(`installPatch load result mod=${!!mod}`);
      if (!mod) lastError = "module not found via cache or pi dist";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      debugLog(`installPatch load error ${lastError}`);
    }

    if (!mod) {
      debugLog(`installPatch no mod, trying TUI instance fallback`);
      if (this.patchViaTuiInstance()) return true;
      const msg = `pi-visor: thinking patch unavailable — ${lastError ?? "unknown"}. Thinking will show as 'Thinking...'`;
      debugLog(`installPatch fail ${msg}`);
      notifyOnce(ctxForNotify ?? this.ctx, this.warned, "patch-missing", msg, "warning");
      return false;
    }

    const Cls = mod.AssistantMessageComponent as { prototype: Record<string, unknown> } | undefined;
    const orig = Cls?.prototype?.updateContent as ((msg: unknown, streaming?: boolean) => void) | undefined;

    if (!Cls || typeof orig !== "function") {
      notifyOnce(ctxForNotify ?? this.ctx, this.warned, "patch-no-orig", "pi-visor: AssistantMessageComponent.updateContent not found — patch skipped", "warning");
      // Still try TUI instance fallback for bundled case
      if (this.tui && this.patchViaTuiInstance()) return true;
      return false;
    }
    if ((orig as unknown as Record<string, unknown>).__visorThinkPatched) {
      debugLog(`installPatch already patched file at ${String((orig as unknown as Record<string, unknown>).__visorThinkPatchedAt)}`);
      // File already patched, but bundled instance may still need patching — try TUI
      if (this.tui) {
        const viaTui = this.patchViaTuiInstance();
        debugLog(`installPatch file already patched, TUI viaTui=${viaTui}`);
        if (viaTui) return true;
      }
      return true;
    }

    debugLog(`installPatch patching ${String(Cls)} orig=${typeof orig}`);
    const self = this;
    const patched = function (this: Record<string, unknown>, message: unknown, isStreaming?: boolean) {
      // Force placeholder mode: the original then renders the static "Thinking..." Text
      // (which we replace below) instead of raw thinking markdown. Guarantees a single
      // managed render path even when the SettingsManager hide-flag patch did not stick.
      try { this.hideThinkingBlock = true; } catch {}
      // Call original first to build the placeholder / markdown
      orig.call(this, message, isStreaming);
      const owner = this;
      self.captureThinking(owner, message);

      try {
        debugLog(`patched called hasContent=${!!(message as { content?: unknown })?.content} isStreaming=${isStreaming} hide=${(this as unknown as { hideThinkingBlock?: boolean }).hideThinkingBlock}`);
        const m = message as { content?: Array<{ type?: string; thinking?: string }> } | null;
        if (!m || !Array.isArray(m.content) || !m.content.some((c) => c?.type === "thinking")) {
          debugLog(`patched no thinking`);
          return;
        }

        // Check if original created a visible thinking representation.
        // When hideThinkingBlock=true, it creates Text("Thinking...").
        // When hideThinkingBlock=false, it creates Markdown with thinkingText.
        // In both cases we want to replace/hide it and show managed line.
        // For empty thinking (encrypted), original creates nothing — we still want to show managed line if we have a snap.
        const container = this.contentContainer as { children?: unknown[] } | undefined;
        const kids = container?.children;
        debugLog(`patched kids=${Array.isArray(kids) ? kids.length : 'no'}`);
        if (!Array.isArray(kids)) return;

        // Find ALL placeholders to replace (one per thinking run in the message).
        const placeholderIdxs: number[] = [];
        let placeholder: { text?: unknown; paddingX?: unknown } | null = null;

        for (let i = 0; i < kids.length; i++) {
          const k = kids[i] as { text?: unknown; paddingX?: unknown; constructor?: { name?: string } } | null;
          if (!k || typeof k.text !== "string") continue;
          // Match both "Thinking..." and any text that looks like a thinking placeholder
          const stripped = stripAnsi(k.text).trim();
          if (stripped === "Thinking..." || stripped === "Thinking…" || stripped.startsWith("Thinking")) {
            placeholderIdxs.push(i);
            if (!placeholder) placeholder = k as { text?: unknown; paddingX?: unknown };
          }
        }
        const placeholderIndex = placeholderIdxs.length > 0 ? placeholderIdxs[0] : -1;

        const isLive = self.isLiveForMessage(message);
        let snap = self.resolveSnap(message);
        debugLog(`patched isLive=${isLive} snap=${snap ? `${snap.durMs}ms ${snap.tokens}` : 'null'} active=${self.active} chars=${self.chars} kidsLen=${Array.isArray(kids) ? kids.length : 0}`);
        // For live, we want null snap to render blinking live line
        const snapForRender = isLive ? null : snap;

        // If no placeholder but we have thinking, we need to inject managed line
        // (covers empty-encrypted case where original rendered nothing, and Markdown case).
        if (placeholderIndex === -1) {
          // Check if original rendered a Markdown thinking block (hideThinkingBlock=false)
          // It would be a Markdown component, not Text. We detect by looking for thinking content
          // and the absence of a placeholder — we inject at the position where thinking would be.
          // Find where thinking block would be: first text block before thinking?
          // Simpler: if no placeholder but hasThinking and we have a snap/live, inject at top.
          if (!snap && !isLive) return; // nothing to show for historical empty without snap
          // Inject managed line at the start (above existing content)
          const lineComp = self.makeThoughtLine(owner, snapForRender, 1);
          // Insert before first child that is not a Spacer
          let insertAt = 0;
          for (let i = 0; i < kids.length; i++) {
            const c = kids[i] as { constructor?: { name?: string } } | null;
            if (c?.constructor?.name !== "Spacer") {
              insertAt = i;
              break;
            }
          }
          kids.splice(insertAt, 0, lineComp as unknown);
          return;
        }

        // We have a placeholder to replace
        if (!isLive && !snap) {
          // Historical but no snap synthesized — keep placeholder (better than empty)
          // However synthesize already tried, so truly empty encrypted with no chars → hide placeholder
          const totalChars = (m.content as Array<{ thinking?: string }>).reduce((a, c) => a + (c.thinking?.length || 0), 0);
          if (totalChars === 0) {
            // Remove placeholder for empty encrypted (show nothing, or show Thought (0s))
            // Show Thought (0s • ↓ 0) if we want, else remove
            // We choose to keep a minimal Thought for encrypted
            snap = { durMs: 0, tokens: 0 };
          } else {
            return;
          }
        }

        const finalSnap = isLive ? null : (snap ?? { durMs: 0, tokens: 0 });
        const padVal = typeof placeholder?.paddingX === "number" ? placeholder.paddingX : 1;
        const lineComp = self.makeThoughtLine(owner, finalSnap as ThinkSnapshot | null, padVal as number);
        for (const idx of placeholderIdxs) kids[idx] = lineComp as unknown;
      } catch (e) {
        // Never let patch break rendering — log once
        notifyOnce(self.ctx, self.warned, "patch-render", `pi-visor patch render error: ${e instanceof Error ? e.message : String(e)}`, "warning");
      }
    };

    (patched as unknown as Record<string, unknown>).__visorThinkPatched = true;
    (patched as unknown as Record<string, unknown>).__visorThinkPatchedAt = Date.now();
    Cls.prototype.updateContent = patched as unknown as (msg: unknown) => void;
    installThinkingExpansion(Cls.prototype);
    debugLog(`installPatch success patched file at ${Date.now()}`);
    // Also try TUI instance patch for bundled case (where file patch alone is insufficient)
    try {
      if (this.tui) {
        const viaTui = this.patchViaTuiInstance();
        debugLog(`installPatch also tried TUI instance viaTui=${viaTui}`);
      }
    } catch {}
    return true;

  }
}
