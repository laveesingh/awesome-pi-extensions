import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDurShort, formatTime } from "./format.js";

export type RunTheme = Pick<Theme, "fg" | "bg" | "bold">;
export type ThemeSource = () => RunTheme;
export interface RecordedTiming { timestamp?: number; durationMs?: number }

/** Only validated supplied times are painted; unavailable values have no separator. */
export function timingParts(timing: RecordedTiming, shortDuration = false): string[] {
  const parts: string[] = [];
  if (typeof timing.timestamp === "number" && Number.isFinite(timing.timestamp) && timing.timestamp > 0) {
    parts.push(formatTime(timing.timestamp));
  }
  if (typeof timing.durationMs === "number" && Number.isFinite(timing.durationMs) && timing.durationMs >= 0) {
    parts.push(shortDuration ? formatDurShort(timing.durationMs)
      : timing.durationMs < 1000 ? `${timing.durationMs}ms` : `${(timing.durationMs / 1000).toFixed(2)}s`);
  }
  return parts;
}

export function fitLine(line: string, width: number): string {
  const w = Math.max(0, width);
  const fit = truncateToWidth(line, w, "…");
  return fit + " ".repeat(Math.max(0, w - visibleWidth(fit)));
}

export function wrapped(line: string, width: number): string[] {
  return wrapTextWithAnsi(line, Math.max(1, width));
}
