/**
 * Widget lines. Pure functions over injected theme methods — and theme methods
 * are always invoked as methods (never extracted), so `this` survives Pi's
 * theme Proxy. See pi-visor's themeFg postmortem; do not reintroduce it here.
 *
 * Pi caps widgets at 10 lines; recaps stay at 6 or fewer.
 */

export interface WidgetTheme {
  fg(color: string, s: string): string;
  bold(s: string): string;
}

const MAX_BULLET_CHARS = 110;
const MAX_LINES = 6;

const trunc = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

/** Split model prose into short display bullets. */
export function toBullets(text: string): string[] {
  const raw = text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:(?:[-*•]|\d+[.)])\s+)+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  const lines = raw.length > 0 ? raw : [text.trim()].filter(Boolean);
  return lines.slice(0, 3).map((l) => `• ${trunc(l.replace(/\s+/g, " "), MAX_BULLET_CHARS)}`);
}

export function pendingLines(t: WidgetTheme, modelLabel: string): string[] {
  return [t.fg("muted", `○ Recapping with ${modelLabel}…`)];
}

export function doneLines(
  t: WidgetTheme,
  bullets: string[],
  meta: { modelLabel: string; durationMs: number; costUsd: number; todayUsd: number },
): string[] {
  const s = Math.max(0, Math.round(meta.durationMs / 1000));
  const head =
    `${t.fg("success", "●")} ${t.fg("text", t.bold("Recap"))}` +
    t.fg("muted", ` · ${meta.modelLabel} · ${s}s · $${meta.costUsd.toFixed(4)} (today $${meta.todayUsd.toFixed(4)})`);
  return [head, ...bullets.map((b) => t.fg("muted", b))].slice(0, MAX_LINES);
}

export function errorLines(t: WidgetTheme, message: string): string[] {
  return [
    `${t.fg("warning", "○")} ${t.fg("text", t.bold("Recap unavailable"))}` +
      t.fg("muted", ` — ${trunc(message, MAX_BULLET_CHARS)}`),
    t.fg("dim", "Use /recap to retry, /recap model to switch models."),
  ];
}
