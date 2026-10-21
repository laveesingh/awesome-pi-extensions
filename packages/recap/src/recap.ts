/**
 * pi-recap orchestration. One rule governs everything: the recap model runs on
 * its own ModelRuntime and its text is only ever published to a transient TUI
 * widget. No session writes, no context builders, no queued messages — so a
 * recap provably cannot leak into the conversation it summarizes.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  addSpend,
  loadConfig,
  saveConfig,
  type RecapConfig,
  type RecapModelRef,
} from "./config.js";
import { buildRecapPrompt, digestLastTurn, shouldAutoRecap } from "./digest.js";
import { modelLabel, PiChatBackend, pickDefaultModel, type ChatBackend } from "./chat.js";
import { doneLines, errorLines, pendingLines, toBullets, type WidgetTheme } from "./widget.js";

const WIDGET_KEY = "recap";
const MAX_TOKENS = 180;
const CALL_TIMEOUT_MS = 45_000;

export class Recap {
  private ctx: ExtensionContext | null = null;
  private flight: { turn: number; ctrl: AbortController } | null = null;
  private turn = 0;

  constructor(
    private readonly backend: ChatBackend = new PiChatBackend(),
    private readonly agentDir?: string,
  ) {}

  install(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
      this.ctx = ctx;
      this.abortFlight();
    });
    pi.on("agent_start", () => {
      // A new turn supersedes any in-flight recap and invalidates the old one.
      this.abortFlight();
      this.clearWidget();
    });
    pi.on("agent_settled", (event) => {
      void this.onSettled(!!(event as { aborted?: boolean })?.aborted, false);
    });
    pi.on("session_shutdown", () => {
      this.abortFlight();
      this.ctx = null;
    });
    pi.registerCommand("recap", {
      description: "Show an ephemeral AI recap of the last run (never added to context).",
      handler: async (args, ctx) => {
        this.ctx = ctx;
        await this.onCommand((args ?? "").trim(), ctx);
      },
    });
  }

  private dir(): string {
    try {
      return this.agentDir ?? getAgentDir();
    } catch {
      return this.agentDir ?? "";
    }
  }

  private theme(): WidgetTheme | null {
    try {
      const theme = (this.ctx?.ui as unknown as { theme?: WidgetTheme } | undefined)?.theme;
      if (theme && typeof theme.fg === "function" && typeof theme.bold === "function") return theme;
    } catch {}
    return null;
  }

  private setLines(lines: string[]): void {
    const ctx = this.ctx;
    if (!ctx || ctx.mode !== "tui") return;
    try {
      ctx.ui.setWidget?.(WIDGET_KEY, () => ({ render: () => lines, invalidate() {} }), {
        placement: "belowEditor",
      });
    } catch {}
  }

  private clearWidget(): void {
    try {
      (this.ctx?.ui as unknown as { setWidget?: (key: string, content: undefined) => void })?.setWidget?.(
        WIDGET_KEY,
        undefined,
      );
    } catch {}
  }

  private abortFlight(): void {
    this.turn++;
    try {
      this.flight?.ctrl.abort();
    } catch {}
    this.flight = null;
  }

  private async onSettled(aborted: boolean, forced: boolean): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.mode !== "tui") return;
    const turn = ++this.turn;
    this.abortFlight();
    // abortFlight bumps turn; reclaim this flight's number.
    this.turn = turn;

    let branch: unknown[] = [];
    try {
      branch = (ctx.sessionManager.getBranch() as unknown as unknown[]) ?? [];
    } catch {
      return;
    }
    const digest = digestLastTurn(branch, aborted);
    const cfg = loadConfig(this.dir());
    if (digest.empty) {
      if (forced) ctx.ui.notify("Nothing to recap yet.", "info");
      return;
    }
    if (!forced && (!cfg.auto || !shouldAutoRecap(digest))) return;

    const theme = this.theme();
    if (!theme) return;
    const model = await this.resolveModel(cfg, ctx, theme);
    if (!model || this.turn !== turn) return;

    const label = modelLabel(model);
    this.setLines(pendingLines(theme, label));

    const ctrl = new AbortController();
    this.flight = { turn, ctrl };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        ctrl.abort();
      } catch {}
    }, CALL_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const result = await this.backend.complete(model, buildRecapPrompt(digest), {
        maxTokens: MAX_TOKENS,
        signal: ctrl.signal,
      });
      if (this.turn !== turn) return;
      const next = addSpend({ ...cfg, spendDay: cfg.spendDay, spendUsd: cfg.spendUsd }, result.costUsd);
      saveConfig(this.dir(), next);
      this.setLines(
        doneLines(theme, toBullets(result.text), {
          modelLabel: label,
          durationMs: Date.now() - startedAt,
          costUsd: result.costUsd,
          todayUsd: next.spendUsd,
        }),
      );
    } catch (error) {
      if (this.turn !== turn) return;
      if (ctrl.signal.aborted && !timedOut) return;
      const message =
        timedOut ? `Recap timed out after ${Math.round(CALL_TIMEOUT_MS / 1000)}s.` : recapError(error);
      this.setLines(errorLines(theme, message));
    } finally {
      clearTimeout(timeout);
      if (this.flight?.turn === turn) this.flight = null;
    }
  }

  /** Configured model, else the cheapest fast chat model with a pulse. */
  private async resolveModel(
    cfg: RecapConfig,
    ctx: ExtensionContext,
    theme: WidgetTheme,
  ): Promise<RecapModelRef | null> {
    void theme;
    if (cfg.model) return cfg.model;
    try {
      const models = await this.backend.listChatModels();
      const pick = pickDefaultModel(models);
      if (!pick) {
        this.setLines(errorLines(theme, "No chat models available."));
        return null;
      }
      return { provider: pick.provider, id: pick.id };
    } catch (error) {
      this.setLines(errorLines(theme, `Could not reach any model: ${recapError(error)}`));
      void ctx;
      return null;
    }
  }

  private async onCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const [verb, rest] = splitArgs(args);
    switch (verb) {
      case "":
        if (!ctx.isIdle()) {
          ctx.ui.notify("A run is in progress — the recap appears when it settles.", "info");
          return;
        }
        await this.onSettled(false, true);
        return;
      case "hide":
        this.abortFlight();
        this.clearWidget();
        return;
      case "auto": {
        const cfg = loadConfig(this.dir());
        if (rest !== "on" && rest !== "off") {
          ctx.ui.notify(`Auto-recap is ${cfg.auto ? "on" : "off"}. Use /recap auto on|off.`, "info");
          return;
        }
        saveConfig(this.dir(), { ...cfg, auto: rest === "on" });
        ctx.ui.notify(`Auto-recap ${rest}.`, "info");
        return;
      }
      case "model":
        await this.onModelCommand(rest, ctx);
        return;
      case "status": {
        const cfg = loadConfig(this.dir());
        ctx.ui.notify(
          `Recap model: ${cfg.model ? modelLabel(cfg.model) : "auto"} · auto-recap ${cfg.auto ? "on" : "off"} · today $${cfg.spendUsd.toFixed(4)}.`,
          "info",
        );
        return;
      }
      default:
        ctx.ui.notify("Usage: /recap [hide|model|model clear|auto on|off|status]", "info");
        return;
    }
  }

  private async onModelCommand(rest: string, ctx: ExtensionContext): Promise<void> {
    const cfg = loadConfig(this.dir());
    if (rest === "clear") {
      saveConfig(this.dir(), { ...cfg, model: null });
      ctx.ui.notify("Recap model reset to automatic.", "info");
      return;
    }
    if (rest) {
      ctx.ui.notify("Usage: /recap model (pick from the list) or /recap model clear.", "info");
      return;
    }
    let models;
    try {
      models = await this.backend.listChatModels();
    } catch (error) {
      ctx.ui.notify(`Could not list models: ${recapError(error)}`, "warning");
      return;
    }
    if (models.length === 0) {
      ctx.ui.notify("No chat models available.", "warning");
      return;
    }
    const options = ["automatic (cheapest fast model)", ...models.map((m) => `${m.provider}/${m.id}${m.name ? ` — ${m.name}` : ""}`)];
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select("Recap model", options);
    } catch {
      return;
    }
    if (!choice || choice.startsWith("automatic")) {
      saveConfig(this.dir(), { ...cfg, model: null });
      ctx.ui.notify("Recap model reset to automatic.", "info");
      return;
    }
    const picked = models[options.indexOf(choice) - 1];
    if (!picked) return;
    saveConfig(this.dir(), { ...cfg, model: { provider: picked.provider, id: picked.id } });
    ctx.ui.notify(`Recap model: ${modelLabel(picked)}.`, "info");
  }
}

function splitArgs(args: string): [string, string] {
  const i = args.search(/\s/);
  if (i < 0) return [args.toLowerCase(), ""];
  return [args.slice(0, i).toLowerCase(), args.slice(i).trim()];
}

function recapError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 140 ? `${message.slice(0, 139)}…` : message;
}
