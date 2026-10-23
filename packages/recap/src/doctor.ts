/**
 * `recap doctor`: walk every provider with chat models, probe each with a
 * penny-sized call, and report what recap can actually use. Credential-less
 * providers are reported without spending a cent; failures carry the
 * provider's verbatim error. Discoveries that change behavior (effort level)
 * come back as config profiles for the caller to persist.
 *
 * Pure orchestration over injected data + probe — no Pi imports, no network
 * of its own. Fully unit-testable.
 */
import { pickDefaultModel, type AttemptInfo, type ChatModel } from "./chat.js";
import type { ProviderProfile } from "./providers.js";

export const DOCTOR_PROMPT = "Reply with exactly: doctor-ok";
export const DOCTOR_MAX_TOKENS = 12;
export const DOCTOR_TIMEOUT_MS = 20_000;

export type DoctorStatus = "ok" | "adjusted" | "no-credentials" | "no-chat-models" | "broken";

export interface DoctorProviderResult {
  provider: string;
  models: number;
  status: DoctorStatus;
  /** Human line for the report: latency, cost, model used, or the error. */
  detail: string;
  latencyMs?: number;
  costUsd?: number;
  /** Non-default setup this provider needs; empty when defaults suffice. */
  profiles: ProviderProfile[];
}

export interface DoctorReport {
  at: string;
  results: DoctorProviderResult[];
}

export interface DoctorProbe {
  attempts: AttemptInfo[];
  text: string;
  costUsd: number;
  latencyMs: number;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function truncReason(reason: string): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length <= 90 ? oneLine : `${oneLine.slice(0, 89)}…`;
}

/** Group models by provider, providers sorted alphabetically. */
export function groupByProvider(models: ChatModel[]): Array<{ provider: string; models: ChatModel[] }> {
  const groups = new Map<string, ChatModel[]>();
  for (const m of models) {
    const list = groups.get(m.provider) ?? [];
    list.push(m);
    groups.set(m.provider, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, list]) => ({ provider, models: list }));
}

export interface DoctorDeps {
  /** Every known chat model (full catalog). */
  catalog: ChatModel[];
  /** Chat models whose provider has working credentials. */
  available: ChatModel[];
  /**
   * One penny-sized call. Must resolve `{ attempts, text, costUsd, latencyMs }`
   * on success and THROW with a readable message on failure. Attempts record
   * each effort level tried, innermost (provider-level) first.
   */
  probe: (model: ChatModel) => Promise<DoctorProbe>;
  onProgress?: (checked: number, total: number, provider: string) => void;
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const credentialed = new Set(deps.available.map((m) => m.provider));
  const groups = groupByProvider(deps.catalog);
  const results: DoctorProviderResult[] = [];
  let checked = 0;
  for (const { provider, models } of groups) {
    checked++;
    deps.onProgress?.(checked, groups.length, provider);
    if (models.length === 0) {
      results.push({ provider, models: 0, status: "no-chat-models", detail: "no chat models", profiles: [] });
      continue;
    }
    if (!credentialed.has(provider)) {
      results.push({
        provider,
        models: models.length,
        status: "no-credentials",
        detail: "no credentials configured — skipped with zero spend",
        profiles: [],
      });
      continue;
    }
    const representative = pickDefaultModel(models) ?? models[0];
    try {
      const probe = await deps.probe(representative);
      const usedLow = probe.attempts.some((a) => a.effort !== "off");
      const profiles: ProviderProfile[] = usedLow ? [{ match: `${provider}/*`, effort: "low" }] : [];
      const firstFailure = probe.attempts.find((a) => a.ok === false);
      const why = firstFailure?.error ? truncReason(firstFailure.error) : "off did not answer";
      results.push({
        provider,
        models: models.length,
        status: usedLow ? "adjusted" : "ok",
        detail:
          `${representative.id} answered in ${fmtMs(probe.latencyMs)} for ${fmtUsd(probe.costUsd)}` +
          (usedLow ? ` — needed low (${why}) — recorded` : ""),
        latencyMs: probe.latencyMs,
        costUsd: probe.costUsd,
        profiles,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        provider,
        models: models.length,
        status: "broken",
        detail: message.length > 160 ? `${message.slice(0, 159)}…` : message,
        profiles: [],
      });
    }
  }
  return { at: new Date().toISOString(), results };
}

const STATUS_MARK: Record<DoctorStatus, string> = {
  ok: "ok",
  adjusted: "adjusted",
  "no-credentials": "no credentials",
  "no-chat-models": "skipped",
  broken: "BROKEN",
};

/**
 * Only providers with credentials get report lines — credential-less ones are
 * noise (they were never probed). They are counted, not hidden silently.
 */
export function visibleResults(report: DoctorReport): DoctorReport["results"] {
  return report.results.filter((r) => r.status !== "no-credentials");
}

export function skippedCount(report: DoctorReport): number {
  return report.results.filter((r) => r.status === "no-credentials").length;
}

/** Multi-line report for the editor viewer. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`Recap doctor — ${report.at}`, ""];
  for (const r of visibleResults(report)) {
    lines.push(`${r.provider} (${r.models} model${r.models === 1 ? "" : "s"}): ${STATUS_MARK[r.status]} — ${r.detail}`);
  }
  const skipped = skippedCount(report);
  if (skipped > 0) lines.push(`(${skipped} provider${skipped === 1 ? "" : "s"} without credentials skipped)`);
  const counts = new Map<DoctorStatus, number>();
  for (const r of visibleResults(report)) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const totalCost = report.results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  lines.push(
    "",
    `Summary: ${visibleResults(report).length} providers checked, ` +
      [...counts.entries()].map(([s, n]) => `${n} ${STATUS_MARK[s]}`).join(", ") +
      `. Probe spend ${fmtUsd(totalCost)}.`,
  );
  return lines.join("\n");
}

/** One-line summary for notify. */
export function summarizeDoctorReport(report: DoctorReport): string {
  const visible = visibleResults(report);
  const broken = visible.filter((r) => r.status === "broken").length;
  const adjusted = visible.filter((r) => r.status === "adjusted").length;
  const ok = visible.filter((r) => r.status === "ok").length;
  const skipped = skippedCount(report);
  return (
    `Doctor: ${ok} ok` +
    (adjusted ? `, ${adjusted} adjusted (saved)` : "") +
    (broken ? `, ${broken} broken — see report` : "") +
    (skipped ? `, ${skipped} skipped (no credentials)` : "") +
    "."
  );
}
