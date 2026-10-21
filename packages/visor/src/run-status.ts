import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatTokensShort } from "./format.js";
import { timingParts, type RunTheme } from "./run-style.js";

/** Per-run token totals, same meanings as the turn bar: uncached input, cache reads, output. */
export interface RunTokens { input: number; cache: number; output: number }

export interface RunStatus {
  index: number;
  /** Words after "Run N ·": Working, Worked, Worked · recovered or Interrupted. */
  label: string;
  dot: "warning" | "success" | "error";
  timestamp?: number;
  durationMs?: number;
  tools: number;
  running: number;
  notes: number;
  errors: number;
  /** Set only for an interrupted run. */
  stoppedAfter?: number;
  tokens?: RunTokens;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The two-row status block shared by the header, the footer and the collapsed box. Only the
 * arrow differs between them, so a long run's footer says what its scrolled-away header said.
 * Row 2 breaks between segments, never inside one, so no count is clipped or split.
 */
export function statusBlock(t: RunTheme, status: RunStatus, arrow: string, width: number): string[] {
  const w = Math.max(1, width);
  const left = t.fg("accent", arrow) + " " + t.fg(status.dot, "●") + " " + t.fg("text", t.bold(`Run ${status.index} · ${status.label}`));
  const time = timingParts({ timestamp: status.timestamp })[0];
  const first = !time ? wrapTextWithAnsi(left, w)
    : visibleWidth(left) + 2 + time.length <= w ? [left + " ".repeat(w - visibleWidth(left) - time.length) + t.fg("muted", time)]
    : wrapTextWithAnsi(left + "  " + t.fg("muted", time), w);

  const duration = timingParts({ durationMs: status.durationMs }, true)[0];
  const segments = [
    ...(duration ? [t.fg("muted", duration)] : []),
    t.fg("muted", plural(status.tools, "tool", "tools") + (status.running ? ` (${status.running} running)` : "")),
    t.fg("muted", plural(status.notes, "note", "notes")),
    ...(status.errors ? [t.fg("error", plural(status.errors, "error", "errors"))] : []),
    ...(status.stoppedAfter !== undefined ? [t.fg("muted", `stopped after ${plural(status.stoppedAfter, "tool", "tools")}`)] : []),
    ...(status.tokens ? [t.fg("muted", `↑ ${formatTokensShort(status.tokens.input)} ⚡ ${formatTokensShort(status.tokens.cache)} ↓ ${formatTokensShort(status.tokens.output)}`)] : []),
  ];
  const separator = t.fg("muted", " · ");
  const room = Math.max(1, w - 2);
  const rows: string[] = [];
  let row = "";
  for (const segment of segments) {
    const joined = row ? row + separator + segment : segment;
    if (!row || visibleWidth(joined) <= room) { row = joined; continue; }
    rows.push(row);
    row = segment;
  }
  if (row) rows.push(row);
  // A single segment wider than the row can only wrap; the indent stays on every row.
  return [...first, ...rows.flatMap((line) => wrapTextWithAnsi(line, room)).map((line) => "  " + line)];
}
