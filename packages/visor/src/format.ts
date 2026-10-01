import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadThemeModule } from "./pi-modules.js";

export function formatTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDurShort(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h${rm}m` : `${h}h`;
}

export function formatTime(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function formatDuration(start: number | undefined): string {
  if (!start) return "";
  const ms = Date.now() - start;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Word-wrap unstyled text. Used for the expanded thinking body. */
export function wrapPlain(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw;
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    while (line.length > width) {
      let cut = line.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^\s+/, "");
    }
    if (line) out.push(line);
  }
  return out;
}

export function themeFg(ctx: ExtensionContext | null, color: string, s: string): string {
  try {
    const fg = (ctx?.ui as unknown as { theme?: { fg?: (c: string, s: string) => string } } | undefined)?.theme?.fg;
    if (typeof fg === "function") return fg(color, s);
  } catch {}
  try {
    const mod = loadThemeModule() as { theme?: { fg?: (c: string, s: string) => string } } | null;
    if (mod?.theme?.fg) return mod.theme.fg(color, s);
  } catch {}
  return s;
}

export function truncateArg(value: unknown, max = 60): string {
  const s = String(value ?? "");
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function extractToolText(result: unknown): string {
  const r = result as Record<string, unknown>;
  const content = r.content as unknown[];
  if (!Array.isArray(content)) return "";
  // Codemode returns a status header followed by separate text output blocks.
  // Preserve every text block; images remain on Pi's own image-rendering path.
  return content
    .filter((block): block is { type: "text"; text: string } =>
      !!block && typeof block === "object" &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * One-line summary of a structured tool result.
 *
 * The golem tracker tools all return `JSON.stringify(payload, null, 2)`, so a
 * plain 3-line preview of one is always `{`, `"id": …`, `"title": …` — the raw
 * dump the collapsed view is supposed to avoid. This reads the payload instead
 * of the text. Generic on purpose: any tool returning JSON benefits, and there
 * is no per-tool table to keep in sync with the server.
 *
 * The object is preferred over the text because the golem bridge truncates its
 * text at 30_000 chars and appends "… output truncated by Golem" — a tracker
 * list routinely exceeds that, so the text is frequently invalid JSON while
 * `details.result` still holds the whole payload.
 *
 * Returns null when there is nothing structured to describe, in which case the
 * caller falls back to the ordinary line preview.
 */
export function compactResult(result: unknown, text: string): string | null {
  const trimmed = text.trim();
  // Only tools whose output IS a payload. bash/grep produce plain text and keep
  // their line preview, even though they also carry `details`.
  if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;

  const details = (result as { details?: Record<string, unknown> } | undefined)?.details;
  let value: unknown = details && typeof details === "object" && "result" in details ? details.result : undefined;
  if (value === undefined) {
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (value === null || value === undefined) return null;

  const scalar = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return v ? truncateArg(v, 48) : null;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return null;
  };

  /** Identity of one list member — an id if it has one, else a short title. */
  const identify = (v: unknown): string | null => {
    if (v === null || typeof v !== "object") return scalar(v);
    const o = v as Record<string, unknown>;
    // A human-readable label beats an opaque uuid: session rows carry both, and
    // four uuids do not fit on a line. Tickets are unaffected — display_id wins.
    return (
      scalar(o.display_id) ??
      scalar(o.id) ??
      scalar(o.ticket_id) ??
      scalar(o.label) ??
      scalar(o.name) ??
      scalar(o.session_id) ??
      (scalar(o.title) ? truncateArg(String(o.title), 24) : null)
    );
  };

  const describe = (v: unknown, depth = 0): string => {
    if (Array.isArray(v)) {
      if (v.length === 0) return "none";
      // Ids only. A full description per item wraps the footer onto a second
      // line, which defeats the point of collapsing.
      const heads = v.slice(0, 4).map(identify).filter((s): s is string => !!s);
      const more = v.length > heads.length && heads.length > 0 ? ", …" : "";
      const suffix = heads.length ? ` · ${heads.join(", ")}${more}` : "";
      return `${v.length} item${v.length === 1 ? "" : "s"}${suffix}`;
    }
    if (!v || typeof v !== "object") return scalar(v) ?? "";
    const obj = v as Record<string, unknown>;

    // True wrappers: `{ ticket: {...} }` holds the thing we care about.
    for (const key of ["ticket", "comment", "session", "result"]) {
      if (obj[key] && typeof obj[key] === "object" && depth < 2) return describe(obj[key], depth + 1);
    }

    // Identity first, then the fields worth seeing at a glance.
    const parts: string[] = [];
    const id = scalar(obj.display_id) ?? scalar(obj.id) ?? scalar(obj.ticket_id) ?? scalar(obj.session_id);
    if (id) parts.push(id);
    // The title is the elastic part. Give it a tight budget so the state and
    // kind after it survive the overall cap instead of being chopped off.
    const title = scalar(obj.title) ?? scalar(obj.name) ?? scalar(obj.label);
    if (title) parts.push(depth === 0 ? `“${truncateArg(title, 34)}”` : truncateArg(title, 24));
    for (const key of ["state", "kind", "role", "status", "assignee"]) {
      const s = scalar(obj[key]);
      if (s) parts.push(s);
    }
    if (parts.length > 0) return parts.join(" · ");

    // No identity of its own — it is a container. `ticket_get` returns the
    // ticket WITH a nested `comments` array, so this must come after identity
    // or it describes the comments instead of the ticket.
    for (const key of ["tickets", "sessions", "comments", "items"]) {
      if (Array.isArray(obj[key]) && depth < 2) return describe(obj[key], depth + 1);
    }

    const ok = scalar(obj.ok);
    if (ok) parts.push(`ok=${ok}`);
    const error = scalar(obj.error) ?? scalar(obj.message);
    if (error) parts.push(error);
    if (parts.length > 0) return parts.join(" · ");

    const keys = Object.keys(obj);
    return keys.length ? `${keys.length} field${keys.length === 1 ? "" : "s"}` : "empty";
  };

  const summary = describe(value);
  if (!summary) return null;
  // The summary shares the footer line with the timestamp and duration, so it
  // has to stay short or the two-line block wraps to three.
  return summary.length <= 64 ? summary : `${summary.slice(0, 63)}…`;
}

export function notifyOnce(
  ctx: ExtensionContext | null,
  seen: Set<string>,
  key: string,
  message: string,
  level: "info" | "warning" | "error" = "warning",
): void {
  if (seen.has(key)) return;
  seen.add(key);
  try {
    ctx?.ui.notify(message, level);
  } catch {}
  try {
    if (level === "error") console.error(message);
    else console.warn(message);
  } catch {}
}
