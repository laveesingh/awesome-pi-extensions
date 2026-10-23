/**
 * Provider profiles: the per-provider setup recap needs, as data instead of
 * branches. Three sources, in precedence order:
 *
 *   1. `providers` in recap.json — the user's own overrides (doctor-written or
 *      hand-edited). Wins over everything.
 *   2. Curated defaults below — quirks proven live (codex rejects 'none',
 *      GLM-class models silently spend the budget thinking).
 *   3. Behavioral discovery at call time — unknown future quirks still adapt
 *      per process (see chat.ts); the doctor command persists discoveries here.
 *
 * Only effort is profiled. Auth, headers and routing stay in code: headers are
 * deterministic by provider family (sessionHeaders), and persisting "provider
 * X is broken" would rot when providers fix themselves server-side.
 */

export type EffortLevel = "off" | "low";

export interface ProviderProfile {
  /** "provider/*", "provider/id" — "*" matches any run, per segment. */
  match: string;
  effort: EffortLevel;
}

/** Curated from live failures. Over-applying "low" only costs a little extra
 *  thinking; under-applying fails recaps — so matches stay slightly broad. */
export const CURATED_PROFILES: ProviderProfile[] = [
  // codex-proxy gpt-6 family: effort 'none' is a 400 ("Supported values are:
  // 'low', 'medium', 'high', 'xhigh', 'max'").
  { match: "codex-proxy/*", effort: "low" },
  // Rakuten GLM thinking models accept 'off' but spend the token budget
  // thinking (791 chars against 180 tokens, zero text out on GLM-5.3).
  { match: "rakuten-ai/*", effort: "low" },
];

function globToRegExp(glob: string): RegExp {
  // One deliberately small glob: "*" per segment, everything else literal.
  const escaped = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function profileMatches(match: string, provider: string, id: string): boolean {
  const pattern = match.includes("/") ? match : `${match}/*`;
  return globToRegExp(pattern).test(`${provider}/${id}`);
}

export function isValidProfile(value: unknown): value is ProviderProfile {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.match === "string" && !!p.match.trim() && (p.effort === "off" || p.effort === "low");
}

/** First match wins: user overrides are passed before curated defaults. */
export function resolveProfile(
  profiles: ProviderProfile[],
  provider: string,
  id: string,
): ProviderProfile | null {
  for (const profile of profiles) {
    try {
      if (isValidProfile(profile) && profileMatches(profile.match, provider, id)) return profile;
    } catch {}
  }
  return null;
}
