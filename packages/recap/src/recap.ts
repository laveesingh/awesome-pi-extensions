/**
 * pi-recap orchestration. One rule governs everything: the recap model runs on
 * its own ModelRuntime and its text is only ever published to a transient TUI
 * widget. No session writes, no context builders, no queued messages — so a
 * recap provably cannot leak into the conversation it summarizes.
 */
import { appendFileSync } from "node:fs";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  addSpend,
  loadConfig,
  saveConfig,
  type RecapConfig,
  type RecapModelRef,
} from "./config.js";
import { buildRecapPrompt, digestLastTurn, shouldAutoRecap } from "./digest.js";
import { modelLabel, PiChatBackend, pickDefaultModel, type ChatBackend, type SessionCalls } from "./chat.js";
import { CURATED_PROFILES } from "./providers.js";
import {
  DOCTOR_MAX_TOKENS,
  DOCTOR_PROMPT,
  DOCTOR_TIMEOUT_MS,
  formatDoctorReport,
  runDoctor,
  summarizeDoctorReport,
} from "./doctor.js";
import { recapErrorLine, recapLine, toBullets, type StatusTheme } from "./widget.js";

const MAX_TOKENS = 250;
const CALL_TIMEOUT_MS = 25_000;
// Consecutive failures before auto-recap stands down. A recap that keeps
// failing (or timing out) must degrade itself, never nag or contend forever.
const MAX_CONSECUTIVE_FAILURES = 3;
// Breathing room after settle: back-to-back turns are common, and a recap
// fired the instant a run ends contends with the next turn for the same
// backend, then gets aborted anyway. Waiting a few seconds and re-checking
// idleness skips most doomed flights before they cost anything.
const DEFAULT_SETTLE_DELAY_MS = 4_000;

export class Recap {
  private ctx: ExtensionContext | null = null;
  private flight: { turn: number; ctrl: AbortController } | null = null;
  private turn = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly backend: ChatBackend = new PiChatBackend(),
    private readonly agentDir?: string,
    private readonly opts: { settleDelayMs?: number } = {},
  ) {}

  private get settleDelayMs(): number {
    const v = this.opts.settleDelayMs;
    return typeof v === "number" && v >= 0 ? v : DEFAULT_SETTLE_DELAY_MS;
  }

  install(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
      this.ctx = ctx;
      this.abortFlight();
    });
    pi.on("turn_start", () => {
      // User activity kills a pending or in-flight recap before agent_start
      // even fires, freeing the provider call at the earliest signal.
      this.abortFlight();
    });
    pi.on("agent_start", () => {
      // A new turn supersedes any in-flight recap. Published lines stay in
      // scrollback like Pi's own status texts; there is nothing to retract.
      this.abortFlight();
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

  private theme(): StatusTheme | null {
    try {
      const theme = (this.ctx?.ui as unknown as { theme?: StatusTheme } | undefined)?.theme;
      if (theme && typeof theme.fg === "function" && typeof theme.bold === "function") return theme;
    } catch {}
    return null;
  }

  /**
   * Publish through notify(info), which renders via Pi's own showStatus path
   * — the same dim transcript-tail line as "Reloaded keybindings…". Plain
   * transcript rows, never session entries, so context stays untouched.
   */
  private publish(line: string): void {
    const ctx = this.ctx;
    if (!ctx || ctx.mode !== "tui") return;
    try {
      ctx.ui.notify(line, "info");
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
    // Master switch, read fresh every time so restarts, reloads and hand
    // edits to recap.json all apply with no extra plumbing.
    if (!cfg.enabled) return;
    if (digest.empty) {
      if (forced) ctx.ui.notify("Nothing to recap yet.", "info");
      return;
    }
    if (!forced && (!cfg.auto || !shouldAutoRecap(digest))) return;

    // Auto path only: let back-to-back turns settle first. A delayed flight
    // that finds a new turn or a busy session quits silently — no call, no
    // contention, no widget. Manual /recap always runs now.
    if (!forced && this.settleDelayMs > 0) {
      await delay(this.settleDelayMs);
      if (this.turn !== turn) {
        debugLog(`settle turn=${turn} skip: superseded during delay`);
        return;
      }
      if (!isIdle(ctx)) {
        debugLog(`settle turn=${turn} skip: session busy after delay`);
        return;
      }
    }

    const theme = this.theme();
    if (!theme) return;
    const candidates = await this.candidateModels(cfg, toModelRef(ctx.model));
    if (candidates.length === 0) {
      if (this.turn !== turn) return;
      this.publish(recapErrorLine(theme, "No chat models available."));
      return;
    }
    if (this.turn !== turn) return;

    const ctrl = new AbortController();
    this.flight = { turn, ctrl };
    // Event-loop forensics (PI_DEBUG=1 only): a 500 ms sampler records drift
    // while the provider call is in flight. High drift + high CPU = something
    // sync is spinning; high drift + idle CPU = waiting on the provider (or
    // elsewhere); clean drift exonerates the loop and points at
    // agent/session-level stalling.
    const lag =
      process.env.PI_DEBUG === "1"
        ? startLagSampler((sample) => {
            const cpu = process.cpuUsage(sample.cpu);
            const cpuMs = (cpu.user + cpu.system) / 1000;
            debugLog(
              `settle turn=${turn} lag sample: drift=${sample.driftMs}ms cpu=${cpuMs.toFixed(1)}ms over ${sample.windowMs}ms`,
            );
          })
        : { stop: () => {} };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        ctrl.abort();
      } catch {}
    }, CALL_TIMEOUT_MS);
    const startedAt = Date.now();
    const prompt = buildRecapPrompt(digest);
    const session = sessionCallsOf(this.ctx);
    let sessionId: string | undefined;
    try {
      const id = ctx.sessionManager.getSessionId?.();
      if (typeof id === "string" && id) sessionId = id;
    } catch {}
    debugLog(`settle turn=${turn} sessionModel=${JSON.stringify(toModelRef(ctx.model))} candidates=${candidates.map(modelLabel).join(",")} via=${session ? "session" : "private"}`);
    // Failed attempts are unbilled provider rejections; the first model with
    // real text wins and its label goes on the line, so fallbacks are visible.
    // When everything fails the FIRST error surfaces: it belongs to the model
    // the user cares about (explicit or session), not a best-effort fallback.
    let firstError: { model: RecapModelRef; error: unknown } | null = null;
    try {
      for (const model of candidates) {
        if (this.turn !== turn || ctrl.signal.aborted) return;
        try {
          debugLog(`settle turn=${turn} calling ${modelLabel(model)}`);
          const result = await this.backend.complete(model, prompt, {
            maxTokens: MAX_TOKENS,
            signal: ctrl.signal,
            session,
            ...(sessionId ? { sessionId } : {}),
            profiles: [...cfg.providers, ...CURATED_PROFILES],
          });
          if (this.turn !== turn) return;
          debugLog(`settle turn=${turn} winner=${modelLabel(model)}`);
          this.consecutiveFailures = 0;
          const next = addSpend({ ...cfg, spendDay: cfg.spendDay, spendUsd: cfg.spendUsd }, result.costUsd);
          saveConfig(this.dir(), next);
          this.publish(
            recapLine(theme, toBullets(result.text), {
              modelId: model.id,
              durationMs: Date.now() - startedAt,
              costUsd: result.costUsd,
            }),
          );
          return;
        } catch (error) {
          debugLog(`settle turn=${turn} failed ${modelLabel(model)}: ${recapError(error)}`);
          if (!firstError) firstError = { model, error };
        }
      }
      if (this.turn !== turn) return;
      if (ctrl.signal.aborted && !timedOut) return;
      this.consecutiveFailures++;
      // Circuit breaker: repeated failures stand auto-recap down instead of
      // contending forever. Manual /recap keeps working; /recap auto on
      // re-arms. Never fires on a superseded or user-aborted flight.
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !forced) {
        const cfgNow = loadConfig(this.dir());
        saveConfig(this.dir(), { ...cfgNow, auto: false });
        debugLog(`settle turn=${turn} breaker: auto-recap off after ${this.consecutiveFailures} failures`);
        this.publish(
          recapErrorLine(theme, `auto-recap paused after ${this.consecutiveFailures} failures — /recap retries, /recap auto on re-arms`),
        );
        return;
      }
      const message = timedOut
        ? `Recap timed out after ${Math.round(CALL_TIMEOUT_MS / 1000)}s.`
        : firstError
          ? `${modelLabel(firstError.model)}: ${recapError(firstError.error)}`
          : "no model attempted";
      this.publish(recapErrorLine(theme, message));
    } finally {
      clearTimeout(timeout);
      lag.stop();
      if (this.flight?.turn === turn) this.flight = null;
    }
  }

  /**
   * Ordered candidates. An explicit choice stands alone — a deliberate pick
   * that fails should say so, not silently substitute. Otherwise the session
   * model goes first, then credentialed cheap models, then catalog cheap, so
   * one model's entitlement quirks cannot sink the recap.
   */
  private async candidateModels(
    cfg: RecapConfig,
    sessionModel: RecapModelRef | null,
  ): Promise<RecapModelRef[]> {
    if (cfg.model) return [cfg.model];
    const candidates: RecapModelRef[] = [];
    const seen = new Set<string>();
    const push = (m: RecapModelRef | null | undefined) => {
      if (!m) return;
      const key = modelLabel(m);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ provider: m.provider, id: m.id });
    };
    push(sessionModel);
    try {
      const pick = pickDefaultModel(await this.backend.listAvailableChatModels());
      push(pick ? { provider: pick.provider, id: pick.id } : null);
    } catch {}
    if (candidates.length === 0) {
      try {
        const pick = pickDefaultModel(await this.backend.listChatModels());
        push(pick ? { provider: pick.provider, id: pick.id } : null);
      } catch {}
    }
    return candidates;
  }

  private async onCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const [verb, rest] = splitArgs(args);
    switch (verb) {
      case "":
        if (!loadConfig(this.dir()).enabled) {
          ctx.ui.notify("Recap is disabled — /recap enable to turn it back on.", "info");
          return;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify("A run is in progress — the recap appears when it settles.", "info");
          return;
        }
        await this.onSettled(false, true);
        return;
      case "disable": {
        const cfg = loadConfig(this.dir());
        this.abortFlight();
        saveConfig(this.dir(), { ...cfg, enabled: false });
        ctx.ui.notify("Recap disabled. /recap enable to turn it back on.", "info");
        return;
      }
      case "enable": {
        const cfg = loadConfig(this.dir());
        saveConfig(this.dir(), { ...cfg, enabled: true });
        ctx.ui.notify("Recap enabled.", "info");
        return;
      }

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
        const session = toModelRef(ctx.model);
        const model = cfg.model ? modelLabel(cfg.model) : session ? `auto → ${modelLabel(session)}` : "auto";
        ctx.ui.notify(
          `Recap ${cfg.enabled ? "enabled" : "disabled"} · model: ${model} · auto-recap ${cfg.auto ? "on" : "off"} · today $${cfg.spendUsd.toFixed(4)}.`,
          "info",
        );
        return;
      }
      case "doctor":
        await this.onDoctor(ctx);
        return;
      default:
        ctx.ui.notify("Usage: /recap [model|model clear|auto on|off|doctor|status|disable|enable]", "info");
        return;
    }
  }

  /**
   * Walk every provider with chat models and persist what recap needs.
   * Credential-less providers cost nothing (reported, never probed); each
   * probed provider gets one penny-sized call, retried at low effort on the
   * same signals production uses. Refuses to run mid-turn so probes never
   * contend with the session they are meant to serve.
   */
  private async onDoctor(ctx: ExtensionContext): Promise<void> {
    if (!ctx.isIdle()) {
      ctx.ui.notify("A run is in progress — run /recap doctor when it settles.", "info");
      return;
    }
    const cfg = loadConfig(this.dir());
    const profiles = [...cfg.providers, ...CURATED_PROFILES];
    const session = sessionCallsOf(ctx);
    let catalog: Array<{ provider: string; id: string; name?: string }> = [];
    let available: Array<{ provider: string; id: string; name?: string }> = [];
    try {
      catalog = await this.backend.listChatModels();
    } catch (error) {
      ctx.ui.notify(`Doctor cannot list models: ${recapError(error)}`, "warning");
      return;
    }
    try {
      available = await this.backend.listAvailableChatModels();
    } catch {}
    const spent: { usd: number } = { usd: 0 };
    const probe = async (model: { provider: string; id: string }) => {
      const attempts: Array<{ caller: "session" | "private"; effort: string }> = [];
      const ctrl = new AbortController();
      const timeout = setTimeout(() => {
        try {
          ctrl.abort();
        } catch {}
      }, DOCTOR_TIMEOUT_MS);
      const startedAt = Date.now();
      try {
        const result = await this.backend.complete(model, DOCTOR_PROMPT, {
          maxTokens: DOCTOR_MAX_TOKENS,
          signal: ctrl.signal,
          session,
          profiles,
          onAttempt: (info) => attempts.push(info),
        });
        spent.usd += result.costUsd;
        return { attempts, text: result.text, costUsd: result.costUsd, latencyMs: Date.now() - startedAt };
      } finally {
        clearTimeout(timeout);
      }
    };
    let report;
    try {
      report = await runDoctor({
        catalog,
        available,
        probe,
        onProgress: (checked, total, provider) => {
          try {
            ctx.ui.notify(`Doctor: checking ${provider} (${checked}/${total})…`, "info");
          } catch {}
        },
      });
    } catch (error) {
      ctx.ui.notify(`Doctor failed: ${recapError(error)}`, "warning");
      return;
    }
    // Persist discoveries, but never overwrite a hand-written pin: on conflict
    // the user's entry wins and the disagreement is reported below.
    const discovered = new Map<string, { match: string; effort: "off" | "low" }>();
    for (const r of report.results) for (const p of r.profiles) discovered.set(p.match, p);
    const existing = new Set(cfg.providers.map((p) => p.match));
    const fresh = [...discovered.values()].filter((p) => !existing.has(p.match));
    const clashes = [...discovered.keys()].filter((m) => existing.has(m));
    if (fresh.length > 0) {
      saveConfig(this.dir(), { ...cfg, providers: [...cfg.providers, ...fresh] });
    }
    const next = addSpend(loadConfig(this.dir()), spent.usd);
    saveConfig(this.dir(), next);
    try {
      await ctx.ui.editor("Recap doctor", formatDoctorReport(report));
    } catch {}
    ctx.ui.notify(
      `${summarizeDoctorReport(report)} Probe spend $${spent.usd.toFixed(4)}.` +
        (clashes.length > 0 ? ` Kept your pin(s) for ${clashes.join(", ")} over doctor's finding.` : ""),
      "info",
    );
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
    // Availability first (providers with working credentials), full catalog
    // as fallback — a flat list of 1,600+ models is unscrollable. Cancelling
    // either step leaves the saved model untouched.
    const AUTO = "automatic (current session model)";
    let models;
    try {
      const available = await this.backend.listAvailableChatModels();
      models = available.length > 0 ? available : await this.backend.listChatModels();
    } catch (error) {
      ctx.ui.notify(`Could not list models: ${recapError(error)}`, "warning");
      return;
    }
    if (models.length === 0) {
      ctx.ui.notify("No chat models available.", "warning");
      return;
    }
    const providers = [...new Set(models.map((m) => m.provider))].sort();
    let providerChoice: string | undefined;
    try {
      providerChoice = await ctx.ui.select("Recap provider", [AUTO, ...providers]);
    } catch {
      return;
    }
    if (!providerChoice) return;
    if (providerChoice === AUTO) {
      saveConfig(this.dir(), { ...cfg, model: null });
      ctx.ui.notify("Recap model reset to automatic.", "info");
      return;
    }
    const inProvider = models.filter((m) => m.provider === providerChoice);
    if (inProvider.length === 0) return;
    const options = inProvider.map((m) => `${m.id}${m.name ? ` — ${m.name}` : ""}`);
    let modelChoice: string | undefined;
    try {
      modelChoice = await ctx.ui.select(`Recap model (${providerChoice})`, options);
    } catch {
      return;
    }
    if (!modelChoice) return;
    const picked = inProvider.find((m) => modelChoice === m.id || modelChoice.startsWith(`${m.id} — `));
    if (!picked) return;
    saveConfig(this.dir(), { ...cfg, model: { provider: picked.provider, id: picked.id } });
    ctx.ui.notify(`Recap model: ${modelLabel(picked)}.`, "info");
  }
}

/** Session models carry provider/id like catalog entries; anything else is ignored. */
function toModelRef(model: unknown): RecapModelRef | null {
  if (!model || typeof model !== "object") return null;
  const { provider, id } = model as { provider?: unknown; id?: unknown };
  if (typeof provider !== "string" || typeof id !== "string") return null;
  return { provider, id };
}

/**
 * The session's own model machinery, feature-detected: same runtime, live
 * tokens, session auth state and scoped routing. Null anywhere the context
 * does not offer it — the private runtime then covers the call.
 */
function sessionCallsOf(ctx: ExtensionContext | null): SessionCalls | null {
  try {
    const registry = (ctx as unknown as { modelRegistry?: unknown })?.modelRegistry as {
      complete?: unknown;
      find?: unknown;
    } | null;
    if (!registry || typeof registry.complete !== "function") return null;
    const complete = registry.complete as (model: unknown, context: unknown, options?: unknown) => Promise<unknown>;
    const calls: SessionCalls = {
      complete: (model, context, options) =>
        complete(model, context, options as Record<string, unknown> | undefined),
    };
    if (typeof registry.find === "function") {
      const find = registry.find as (provider: string, id: string) => unknown;
      calls.find = (provider, id) => find(provider, id);
    }
    return calls;
  } catch {
    return null;
  }
}

/** Debug trace. Enable with PI_DEBUG=1; read /tmp/pi-recap.log after a failed recap. */
function debugLog(message: string): void {
  if (process.env.PI_DEBUG !== "1") return;
  try {
    appendFileSync("/tmp/pi-recap.log", `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface LagSample {
  driftMs: number;
  windowMs: number;
  cpu: NodeJS.CpuUsage;
}

/**
 * Drift sampler for freeze forensics. Fires every 500 ms while a provider call
 * is in flight; callers correlate drift against CPU to separate loop
 * starvation (drift + CPU) from waiting (drift, no CPU) from health.
 */
function startLagSampler(onSample: (sample: LagSample) => void): { stop(): void } {
  let last = Date.now();
  let lastCpu = process.cpuUsage();
  const timer = setInterval(() => {
    const now = Date.now();
    const cpu = process.cpuUsage();
    onSample({ driftMs: Math.max(0, now - last - 500), windowMs: now - last, cpu: lastCpu });
    last = now;
    lastCpu = cpu;
  }, 500);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return {
    stop: () => clearInterval(timer),
  };
}

function isIdle(ctx: ExtensionContext): boolean {
  try {
    return ctx.isIdle();
  } catch {
    return true;
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
