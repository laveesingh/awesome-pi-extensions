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

/** Row 1 depends on the arrow alone; the rows after it are the same wherever the block is drawn. */
export interface StatusParts { first(arrow: string): string[]; rest: string[] }

/** The unframed block, with row 1 left open on its arrow so header and footer share the rest. */
export function statusParts(t: RunTheme, status: RunStatus, width: number): StatusParts {
  const w = Math.max(1, width);
  const title = t.fg("text", t.bold(`Run ${status.index} · ${status.label}`));
  const dot = t.fg(status.dot, "●");
  const time = timingParts({ timestamp: status.timestamp })[0];
  const first = (arrow: string): string[] => {
    const left = t.fg("accent", arrow) + " " + dot + " " + title;
    return !time ? wrapTextWithAnsi(left, w)
      : visibleWidth(left) + 2 + time.length <= w ? [left + " ".repeat(w - visibleWidth(left) - time.length) + t.fg("muted", time)]
      : wrapTextWithAnsi(left + "  " + t.fg("muted", time), w);
  };

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
  return { first, rest: rows.flatMap((line) => wrapTextWithAnsi(line, room)).map((line) => "  " + line) };
}

/**
 * The two-row status block shared by the header, the footer and the collapsed box. Only the
 * arrow differs between them, so a long run's footer says what its scrolled-away header said.
 * Row 2 breaks between segments, never inside one, so no count is clipped or split.
 */
export function statusBlock(t: RunTheme, status: RunStatus, arrow: string, width: number): string[] {
  const parts = statusParts(t, status, width);
  return [...parts.first(arrow), ...parts.rest];
}
