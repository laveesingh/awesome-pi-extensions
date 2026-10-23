/**
 * Out-of-context chat. A single lazily-created ModelRuntime reuses Pi's
 * providers and stored credentials but shares nothing with the session: no
 * entries, no context builders, no accounting. The recap call can therefore
 * never leak into — or be billed to — the conversation.
 */
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RecapModelRef } from "./config.js";
import { resolveProfile, type ProviderProfile } from "./providers.js";

export interface ChatModel extends RecapModelRef {
  name?: string;
}

export interface ChatResult {
  text: string;
  costUsd: number;
}

export interface AttemptInfo {
  caller: "session" | "private";
  effort: string;
  /** Outcome, reported after the attempt settles. Absent on old recorders. */
  ok?: boolean;
  /** Provider message when ok is false. */
  error?: string;
}

export interface CompleteOpts {
  maxTokens: number;
  signal?: AbortSignal;
  session?: SessionCalls | null;
  /** Pi session id, for gateway-required session headers (opencode family). */
  sessionId?: string;
  /** Observed per attempt; used by the doctor to learn what worked. */
  onAttempt?: (info: AttemptInfo) => void;
  /** Provider profiles, config overrides first. Defaults to curated only. */
  profiles?: ProviderProfile[];
}

export interface ChatBackend {
  listChatModels(): Promise<ChatModel[]>;
  /** Chat models whose provider has working credentials. Falls back to [] on error. */
  listAvailableChatModels(): Promise<ChatModel[]>;
  complete(model: RecapModelRef, prompt: string, opts: CompleteOpts): Promise<ChatResult>;
}

/**
 * The session's own model machinery (ctx.modelRegistry): same runtime, live
 * tokens, session auth state and scoped routing. Feature-detected — older or
 * thinner contexts may not offer it, in which case the private runtime below
 * is the only caller.
 */
export interface SessionCalls {
  complete(model: unknown, context: unknown, options?: Record<string, unknown>): Promise<unknown>;
  find?(provider: string, id: string): unknown;
}

type Runtime = {
  getModels(providerId?: string): Array<{ provider: string; id: string; name?: string } & Record<string, unknown>>;
  getAvailableOfType(type: string, provider?: string, options?: { signal?: AbortSignal }): Promise<
    Array<{ provider: string; id: string; name?: string } & Record<string, unknown>>
  >;
  completeSimple(
    model: unknown,
    context: unknown,
    options?: { maxTokens?: number; reasoning?: string; signal?: AbortSignal },
  ): Promise<unknown>;
};

let sharedRuntime: Runtime | null = null;
/** Test seam: drop the cached runtime so tests never share production state. */
export function resetChatRuntime(): void {
  sharedRuntime = null;
}

async function runtime(): Promise<Runtime> {
  if (!sharedRuntime) {
    // No allowModelNetwork: no catalog refresh, local files only. Created once
    // per process and reused, so the one-time provider setup never repeats.
    sharedRuntime = (await ModelRuntime.create({
      authPath: `${getAgentDir()}/auth.json`,
    })) as unknown as Runtime;
  }
  return sharedRuntime;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => (b.text as string).trim())
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function costOf(result: unknown): number {
  const cost = (result as { usage?: { cost?: { total?: unknown } } })?.usage?.cost?.total;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0;
}

function sanitize(
  models: Array<{ provider: unknown; id: unknown; name?: unknown } & Record<string, unknown>>,
): ChatModel[] {
  return (Array.isArray(models) ? models : [])
    .filter((m) => m && typeof m.provider === "string" && typeof m.id === "string")
    .map((m) => ({
      provider: m.provider as string,
      id: m.id as string,
      ...(typeof m.name === "string" ? { name: m.name } : {}),
    }));
}

/** Cheapest fast default: prefer mini/nano/haiku/flash-class ids, else first. */
export function pickDefaultModel(models: ChatModel[]): ChatModel | null {
  if (models.length === 0) return null;
  const cheap = models.find((m) => /mini|nano|haiku|flash|lite|light|small/i.test(`${m.provider}/${m.id} ${m.name ?? ""}`));
  if (cheap && !/pro|ultra|max|opus/i.test(`${cheap.provider}/${cheap.id}`)) return cheap;
  return models[0];
}

export function modelLabel(model: RecapModelRef): string {
  return `${model.provider}/${model.id}`;
}

export type CompleteFn = (
  model: unknown,
  context: unknown,
  options: { maxTokens?: number; reasoning?: string; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<unknown>;

/**
 * Gateway-required session headers. The opencode providers reject direct calls
 * without them (MissingSessionID 400) — the agent path attaches them via
 * mergeProviderAttributionHeaders, so recaps must too. OpenRouter/nVidia/
 * Cloudflare attribution headers are courtesy-only (and telemetry-gated, which
 * needs a settings manager extensions don't get), so they stay out.
 */
export function sessionHeaders(model: unknown, sessionId: string | undefined): Record<string, string> | undefined {
  if (!sessionId) return undefined;
  const m = (model && typeof model === "object" ? model : {}) as { provider?: unknown; baseUrl?: unknown };
  const baseHost = typeof m.baseUrl === "string" ? safeHost(m.baseUrl) : "";
  if (m.provider !== "opencode" && m.provider !== "opencode-go" && baseHost !== "opencode.ai") {
    return undefined;
  }
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

const defaultRun: CompleteFn = async (model, context, options) => {
  const rt = await runtime();
  return rt.completeSimple(model, context, options);
};

/**
 * Models known this process to reject effort 'off' (e.g. the codex gpt-6
 * family, whose minimum is 'low'). Repeat recaps skip the doomed call.
 */
const needsEffort = new Set<string>();

/**
 * The model needs a real effort level instead of 'off': either the provider
 * rejects the level outright ("'none' is not supported…"), or it silently
 * spends the whole token budget thinking — empty text with stopReason length
 * or thinking blocks present (seen on GLM-5.3: 791 chars of thinking against
 * a 180-token budget, zero text out).
 */
export function needsEffortFallback(result: unknown, textEmpty: boolean): boolean {
  if (!textEmpty) return false;
  if (isReasoningRejected(result)) return true;
  const r = result as { stopReason?: unknown; content?: Array<{ type?: unknown; thinking?: unknown }> } | null;
  if (!r || typeof r !== "object") return false;
  if (r.stopReason === "length") return true;
  return (
    Array.isArray(r.content) &&
    r.content.some((b) => b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.length > 0)
  );
}

/**
 * A provider error complaining about the reasoning effort level — either by
 * name (reasoning/effort/thinking) or by rejecting the 'none' level we send
 * for `reasoning: "off"` ("'none' is not supported…").
 */
export function isReasoningRejected(result: unknown): boolean {
  const r = result as { stopReason?: unknown; errorMessage?: unknown } | null;
  if (!r || r.stopReason !== "error" || typeof r.errorMessage !== "string") return false;
  const msg = r.errorMessage;
  if (/reasoning|effort|thinking/i.test(msg)) return true;
  return /(['"]none['"]|\boff\b)/i.test(msg) && /not supported|unsupported|not allowed|invalid/i.test(msg);
}

function providerError(result: unknown): string | null {
  const message = (result as { errorMessage?: unknown })?.errorMessage;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

/** Resolve through the session registry without throwing on a foreign shape. */
function safeFind(session: SessionCalls, model: RecapModelRef): unknown {
  try {
    if (typeof session.find === "function") return session.find(model.provider, model.id);
  } catch {}
  return undefined;
}

export class PiChatBackend implements ChatBackend {
  constructor(
    private readonly run: CompleteFn = defaultRun,
    private readonly profiles: ProviderProfile[] = [],
  ) {}

  async listChatModels(): Promise<ChatModel[]> {
    const rt = await runtime();
    return sanitize(rt.getModels());
  }

  async listAvailableChatModels(): Promise<ChatModel[]> {
    try {
      const rt = await runtime();
      const available = await rt.getAvailableOfType("chat");
      if (Array.isArray(available)) return sanitize(available);
    } catch {}
    return [];
  }

  protected async resolveModelRef(model: RecapModelRef): Promise<unknown> {
    const rt = await runtime();
    const resolved = rt.getModels().find((m) => m.provider === model.provider && m.id === model.id);
    if (!resolved) throw new Error(`Unknown chat model "${modelLabel(model)}". Pick one with /recap model.`);
    return resolved;
  }

  async complete(model: RecapModelRef, prompt: string, opts: CompleteOpts): Promise<ChatResult> {
    const context = { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] };
    const session = opts.session && typeof opts.session.complete === "function" ? opts.session : null;
    // Session machinery first (same credentials the run itself used, live
    // tokens, scoped routing); the private runtime covers whatever it cannot.
    // Resolution stays per-caller so overrides and virtual models survive.
    // On a session-path failure the private runtime still gets one shot — it
    // can only help (different auth material) — and the session error is what
    // surfaces when both fail, since it came from the authoritative machinery.
    if (session) {
      const resolved = safeFind(session, model);
      if (resolved !== undefined) {
        try {
          return await this.completeVia(
            "session",
            (m, c, o) => session.complete(m, c, o as Record<string, unknown>),
            model,
            resolved,
            context,
            opts,
          );
        } catch (error) {
          if (opts.signal?.aborted) throw error;
          try {
            const fallback = await this.resolveModelRef(model);
            return await this.completeVia("private", this.run, model, fallback, context, opts);
          } catch {
            throw error;
          }
        }
      }
    }
    const resolved = await this.resolveModelRef(model);
    return this.completeVia("private", this.run, model, resolved, context, opts);
  }

  private async completeVia(
    callerName: "session" | "private",
    caller: CompleteFn,
    model: RecapModelRef,
    resolved: unknown,
    context: unknown,
    opts: CompleteOpts,
  ): Promise<ChatResult> {
    const key = modelLabel(model);
    const profiles = opts.profiles ?? this.profiles;
    const headers = sessionHeaders(resolved, opts.sessionId);
    const options = (reasoning?: string) => ({
      maxTokens: opts.maxTokens,
      ...(reasoning !== undefined ? { reasoning } : {}),
      signal: opts.signal,
      ...(headers ? { headers } : {}),
    });
    const attempt = async (effort: string): Promise<unknown> => {
      const report = opts.onAttempt;
      if (!report) return caller(resolved, context, options(effort));
      try {
        const result = await caller(resolved, context, options(effort));
        const usable = !!textOf(result).trim();
        report({
          caller: callerName,
          effort,
          ok: usable,
          ...(usable ? {} : { error: providerError(result) ?? "empty reply" }),
        });
        return result;
      } catch (error) {
        report({
          caller: callerName,
          effort,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
    // Static profiles first (no doomed discovery call), then the memoized
    // behavioral fallback, then 'off'. Reasoning models (e.g. the codex gpt-6
    // family) reject effort 'none' with a 400, and omitting the level
    // defaults back to 'none' there — so the fallback is an explicit minimum
    // effort, not omission. Others (seen on GLM-5.3) accept 'off' but
    // silently spend the token budget thinking.
    const profile = resolveProfile(profiles, model.provider, model.id);
    const effort = profile?.effort ?? (needsEffort.has(key) ? "low" : "off");
    let result = await attempt(effort);
    if (effort === "off" && !opts.signal?.aborted && needsEffortFallback(result, !textOf(result).trim())) {
      needsEffort.add(key);
      result = await attempt("low");
    }
    const text = textOf(result).trim();
    if (!text) {
      // Surface the provider's message when there is one: "empty reply"
      // alone once hid a 400 about the reasoning effort level.
      throw new Error(providerError(result) ?? `Model "${key}" returned an empty reply.`);
    }
    return { text, costUsd: costOf(result) };
  }
}
