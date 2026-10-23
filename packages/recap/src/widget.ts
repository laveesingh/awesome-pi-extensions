/**
 * Recap lines in Claude Code's idiom: a `⎿`-led, muted, single-line summary
 * with the cost inline. Published with `notify(line, "info")`, which renders
 * through Pi's own showStatus path — the same dim transcript-tail line as
 * "Reloaded keybindings…" — so there is no widget to manage or dismiss.
 * showStatus updates the line in place while it is still the tail, and a
 * persisted row afterwards, exactly like Pi's own status texts.
 *
 * Theme methods are always invoked as methods (never extracted), so `this`
 * survives Pi's theme Proxy. See pi-visor's themeFg postmortem.
 */

export interface StatusTheme {
  fg(color: string, s: string): string;
  bold(s: string): string;
}

const MAX_ERROR_CHARS = 160;

const trunc = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

/**
 * Split model prose into display bullets. Only the count is capped (3); bullet
 * text is never truncated — the transcript wraps long rows on its own, and a
 * hard cap here was visibly chopping recaps mid-word. The prompt already asks
 * the model for short bullets, which is where brevity belongs.
 */
export function toBullets(text: string): string[] {
  const raw = text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:(?:[-*•]|\d+[.)])\s+)+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  const lines = raw.length > 0 ? raw : [text.trim()].filter(Boolean);
  return lines.slice(0, 3).map((l) => l.replace(/\s+/g, " "));
}

/** The recap line. Long lines wrap like any transcript row; bullets stay tight.
 *  modelId is the short model id (no provider prefix) for the same reason. */
export function recapLine(
  t: StatusTheme,
  bullets: string[],
  meta: { modelId: string; durationMs: number; costUsd: number },
): string {
  const s = Math.max(0, Math.round(meta.durationMs / 1000));
  const body = bullets.length > 0 ? bullets.join(" • ") : "done";
  return (
    t.fg("muted", "⎿ ") +
    t.fg("text", "Recap") +
    t.fg("muted", ` · ${body} · ${meta.modelId} · ${s}s · $${meta.costUsd.toFixed(4)}`)
  );
}

export function recapErrorLine(t: StatusTheme, message: string): string {
  // Errors stay bounded: provider failures can carry stack-trace-sized text.
  return (
    t.fg("muted", "⎿ ") +
    t.fg("text", "Recap") +
    t.fg("muted", ` · unavailable — ${trunc(message, MAX_ERROR_CHARS)} (see /recap model)`)
  );
}
