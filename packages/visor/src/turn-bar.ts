import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDurShort, formatTokensShort, themeFg } from "./format.js";
import { ThinkingManager } from "./thinking.js";

// ── Turn bar ─────────────────────────────────────────────────────────────────
export class TurnBar {
  private turnStartAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ctx: ExtensionContext | null = null;
  private active = false;

  private perTurnInput = 0;
  private perTurnOutput = 0;
  private perTurnCache = 0;
  private inputSeeded = false;

  private liveOutChars = 0;
  private liveOutTokensEst = 0;

  constructor(private readonly thinking: ThinkingManager) {}

  install(pi: ExtensionAPI): void {
    pi.on("agent_start", this.beginAgentRun as never);
    pi.on("message_update", this.onMessageUpdate as never);
    pi.on("message_end", this.onMessageEnd as never);
    pi.on("agent_settled", this.settleAgentRun as never);
    pi.on("session_start", this.onSessionStart as never);
    pi.on("session_shutdown", this.onShutdown as never);
  }

  private getTaskProgress(): { pct: number; filled: number; label: string } | null {
    if (!this.ctx) return null;
    try {
      const sm: unknown = (this.ctx as unknown as Record<string, unknown>).sessionManager;
      const branch: unknown[] =
        typeof (sm as { getBranch?: () => unknown[] }).getBranch === "function"
          ? (sm as { getBranch: () => unknown[] }).getBranch()
          : typeof (sm as { getEntries?: () => unknown[] }).getEntries === "function"
            ? (sm as { getEntries: () => unknown[] }).getEntries()
            : [];
      let latest: Array<{ status?: string }> | null = null;
      for (const entry of branch as Array<Record<string, unknown>>) {
        if (entry.type !== "message") continue;
        const msg = entry.message as Record<string, unknown> | undefined;
        if (!msg || msg.role !== "toolResult") continue;
        const toolName = String((msg as Record<string, unknown>).toolName ?? "");
        if (!["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].includes(toolName)) continue;
        const d = (msg as Record<string, unknown>).details as Record<string, unknown> | undefined;
        if (d && Array.isArray(d.tasks)) latest = d.tasks as Array<{ status?: string }>;
      }
      if (!latest || latest.length === 0) return null;
      const visible = latest.filter((t) => (t as { status?: string }).status !== "deleted");
      if (visible.length === 0) return null;
      const done = visible.filter((t) => (t as { status?: string }).status === "completed").length;
      const total = visible.length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      const filled = Math.max(0, Math.min(8, Math.round((done / total) * 8)));
      return { pct, filled, label: `${pct}% (${done}/${total})` };
    } catch {
      return null;
    }
  }

  private buildWorkingLine(isLive: boolean): string {
    if (this.turnStartAt == null) return "";
    const dur = formatDurShort(Date.now() - this.turnStartAt);
    const liveDown = this.perTurnOutput + this.liveOutTokensEst;
    const bright = isLive && Date.now() % 1000 < 500;
    const dotChar = isLive ? (bright ? "●" : "○") : "●";
    const dot = themeFg(this.ctx, isLive ? (bright ? "success" : "dim") : "dim", dotChar);
    const label = themeFg(this.ctx, "muted", isLive ? "Working" : "Worked");
    const stats = themeFg(
      this.ctx,
      "muted",
      ` (${dur} • ↑ ${formatTokensShort(this.perTurnInput)} • ⚡ ${formatTokensShort(this.perTurnCache)} • ↓ ${formatTokensShort(liveDown)})`,
    );
    const prog = this.getTaskProgress();
    if (!prog) return `${dot} ${label}${stats}`;
    const bar = "█".repeat(prog.filled) + "░".repeat(8 - prog.filled);
    const barStr = themeFg(this.ctx, "muted", bar);
    const pctStr = themeFg(this.ctx, "dim", ` ${prog.label}`);
    return `${dot} ${label}${stats}  ${barStr}${pctStr}`;
  }

  private tick = (): void => {
    if (!this.active || this.turnStartAt == null || !this.ctx) return;
    const line = this.buildWorkingLine(true);
    try {
      (this.ctx.ui as unknown as { setWidget?: (id: string, c: unknown) => void }).setWidget?.("turn-bar", () => ({
        render: () => [line],
        invalidate() {},
      }));
    } catch {}
  };

  private beginAgentRun = (_e: unknown, ctx: ExtensionContext): void => {
    if (this.active) return;
    this.ctx = ctx;
    this.active = true;
    this.turnStartAt = Date.now();
    this.perTurnInput = 0;
    this.perTurnOutput = 0;
    this.perTurnCache = 0;
    this.liveOutChars = 0;
    this.liveOutTokensEst = 0;
    this.inputSeeded = false;

    this.thinking.resetForNewRun(ctx);

    try {
      const cu = (ctx as unknown as { getContextUsage?: () => { tokens?: number } }).getContextUsage?.();
      if (cu && typeof cu.tokens === "number" && cu.tokens > 0) {
        this.perTurnInput = cu.tokens;
        this.inputSeeded = true;
      }
    } catch {}

    try {
      (this.ctx.ui as unknown as { setWidget?: (id: string, v: undefined) => void }).setWidget?.("turn-bar", undefined);
    } catch {}
    try {
      (this.ctx.ui as unknown as { setWorkingVisible?: (v: boolean) => void }).setWorkingVisible?.(false);
    } catch {}
    try {
      this.ctx.ui.setWorkingIndicator(undefined);
    } catch {}
    try {
      (this.ctx.ui as unknown as { setWorkingMessage?: (m?: string) => void }).setWorkingMessage?.(undefined);
    } catch {}

    this.tick();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.thinking.isActive) {
        const tui = this.thinking.tui;
        if (tui) {
          try {
            tui.requestRender();
          } catch {}
        }
      }
      this.tick();
    }, 500);
  };

  private onMessageUpdate = (event: unknown): void => {
    if (!this.active || !this.ctx) return;
    const ev = event as { message?: unknown; assistantMessageEvent?: { type?: string; delta?: string } };
    const delta = ev.assistantMessageEvent?.delta;
    const type = ev.assistantMessageEvent?.type;

    this.thinking.trackMessageUpdate(type, delta, ev.message);

    if (
      typeof delta === "string" &&
      delta.length &&
      (type === "text_delta" || type === "toolcall_delta" || type === "thinking_delta")
    ) {
      this.liveOutChars += delta.length;
      this.liveOutTokensEst = Math.round(this.liveOutChars / 4);
      this.tick();
    }
  };

  private onMessageEnd = (event: unknown): void => {
    if (!this.active) return;
    const msg = (event as { message?: { role?: string; usage?: { input?: number; output?: number } } })?.message;
    if (msg?.role !== "assistant") return;

    if (msg.usage) {
      if (this.inputSeeded) {
        this.perTurnInput = msg.usage.input || this.perTurnInput;
        this.inputSeeded = false;
      } else {
        this.perTurnInput += msg.usage.input || 0;
      }
      this.perTurnOutput += msg.usage.output || 0;
      this.perTurnCache += (msg.usage as { cacheRead?: number }).cacheRead || 0;
      this.liveOutChars = 0;
      this.liveOutTokensEst = 0;
    }

    this.thinking.finalizeMessage(msg as unknown as Record<string, unknown>);
    this.tick();
  };

  private settleAgentRun = (): void => {
    if (!this.active) return;
    const line = this.buildWorkingLine(false);
    this.active = false;
    this.turnStartAt = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.ctx?.ui.setWorkingIndicator(undefined);
    } catch {}
    try {
      (this.ctx?.ui as unknown as { setWorkingVisible?: (v: boolean) => void }).setWorkingVisible?.(false);
    } catch {}
    try {
      (this.ctx?.ui as unknown as { setWorkingMessage?: (m?: string) => void }).setWorkingMessage?.(undefined);
    } catch {}
    try {
      (this.ctx?.ui as unknown as { setWidget?: (id: string, c: unknown) => void }).setWidget?.("turn-bar", () => ({
        render: () => [line],
        invalidate() {},
      }));
    } catch {}
  };

  private onSessionStart = (_e: unknown, ctx: ExtensionContext): void => {
    this.ctx = ctx;
    this.thinking.captureTui(ctx);
  };

  private onShutdown = (): void => {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.ctx?.ui.setWorkingIndicator(undefined);
    } catch {}
    try {
      (this.ctx?.ui as unknown as { setWidget?: (id: string, v: undefined) => void }).setWidget?.("turn-bar", undefined);
    } catch {}
  };
}
