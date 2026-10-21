/**
 * The last turn, reduced to what a recap model needs. Deliberately lossy:
 * tool names and argument snippets, never outputs; the final reply, never the
 * thinking. Everything is length-capped so the recap prompt stays tiny.
 *
 * No Pi imports at runtime (types only) so this stays unit-testable.
 */

export interface DigestToolCall {
  name: string;
  args: string;
}

export interface TurnDigest {
  /** The user's prompt that started the turn (truncated). Empty when unknown. */
  userPrompt: string;
  /** Tool calls in order, with argument snippets. */
  toolCalls: DigestToolCall[];
  /** Settled tool results seen in the turn. */
  toolResults: number;
  /** Final assistant reply text (truncated). Empty for tool-only turns. */
  finalText: string;
  /** Wall-clock span of the turn, when timestamps are available. */
  durationMs?: number;
  /** The run ended because it was aborted. */
  aborted: boolean;
  /** Nothing recap-worthy happened (no prompt, no tools, no reply). */
  empty: boolean;
}

const MAX_PROMPT_CHARS = 800;
const MAX_FINAL_CHARS = 1200;
const MAX_ARG_CHARS = 120;
const MAX_PROMPT_TOTAL = 3000;

const trunc = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

type Block = { type?: unknown; text?: unknown; name?: unknown; args?: unknown };
type Message = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
};
type Entry = { type?: unknown; message?: unknown };

function asEntry(value: unknown): Entry | null {
  if (!value || typeof value !== "object") return null;
  return value as Entry;
}

function asMessage(value: unknown): Message | null {
  if (!value || typeof value !== "object") return null;
  return value as Message;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function argSnippet(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return trunc(args, MAX_ARG_CHARS);
  if (typeof args !== "object") return trunc(String(args), MAX_ARG_CHARS);
  const o = args as Record<string, unknown>;
  // The fields that usually say what a call did, in preference order.
  for (const key of ["command", "path", "file", "pattern", "query", "prompt", "text", "subject", "url"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return trunc(v.trim(), MAX_ARG_CHARS);
  }
  try {
    return trunc(JSON.stringify(o), MAX_ARG_CHARS);
  } catch {
    return "";
  }
}

/** Entries of the last turn: everything after the final user message. */
function lastTurnEntries(entries: unknown[]): Entry[] {
  const rows = entries.map(asEntry).filter((e): e is Entry => e !== null);
  let start = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const msg = asMessage(rows[i]?.message);
    if (rows[i]?.type === "message" && msg?.role === "user") {
      start = i;
      break;
    }
  }
  return rows.slice(start);
}

export function digestLastTurn(entries: unknown[], aborted: boolean): TurnDigest {
  const turn = lastTurnEntries(entries);
  let userPrompt = "";
  const toolCalls: DigestToolCall[] = [];
  let toolResults = 0;
  let finalText = "";
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  for (const entry of turn) {
    if (entry?.type !== "message") continue;
    const msg = asMessage(entry.message);
    if (!msg) continue;
    if (typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)) {
      firstTs = firstTs === undefined ? msg.timestamp : Math.min(firstTs, msg.timestamp);
      lastTs = lastTs === undefined ? msg.timestamp : Math.max(lastTs, msg.timestamp);
    }
    if (msg.role === "user" && !userPrompt) {
      userPrompt = trunc(textOf(msg.content).trim(), MAX_PROMPT_CHARS);
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const raw of msg.content as unknown[]) {
        const block = (raw && typeof raw === "object" ? raw : null) as Block | null;
        if (block?.type === "toolCall") {
          const name = typeof block.name === "string" && block.name ? block.name : "tool";
          toolCalls.push({ name, args: argSnippet(block.args) });
        }
      }
      const reply = textOf(msg.content).trim();
      if (reply) finalText = trunc(reply, MAX_FINAL_CHARS);
    } else if (msg.role === "toolResult") {
      toolResults++;
    }
  }

  const empty = !userPrompt && toolCalls.length === 0 && !finalText;
  const digest: TurnDigest = { userPrompt, toolCalls, toolResults, finalText, aborted, empty };
  if (firstTs !== undefined && lastTs !== undefined && lastTs >= firstTs) {
    digest.durationMs = lastTs - firstTs;
  }
  return digest;
}

/** Worth spending a model call on without being asked? */
export function shouldAutoRecap(digest: TurnDigest): boolean {
  if (digest.empty) return false;
  if (digest.toolCalls.length > 0) return true;
  return digest.finalText.length > 200;
}

const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
};

/** The recap prompt. Capped so the call stays cheap even on wild turns. */
export function buildRecapPrompt(digest: TurnDigest): string {
  const lines = [
    "Summarize this coding-agent turn in at most 3 short bullets: what was asked, what was done (tools used), and the outcome. No preamble, no code blocks, plain text, each bullet under 100 characters.",
  ];
  if (digest.userPrompt) lines.push(`Asked: ${digest.userPrompt}`);
  if (digest.toolCalls.length > 0) {
    const calls = digest.toolCalls
      .slice(0, 12)
      .map((c) => (c.args ? `${c.name} ${c.args}` : c.name))
      .join("; ");
    const more = digest.toolCalls.length > 12 ? ` (+${digest.toolCalls.length - 12} more)` : "";
    lines.push(`Tools (${digest.toolCalls.length}, ${digest.toolResults} results): ${calls}${more}`);
  }
  if (digest.finalText) lines.push(`Final reply: ${digest.finalText}`);
  if (digest.aborted) lines.push("Note: the run was interrupted before finishing.");
  if (digest.durationMs !== undefined) lines.push(`Turn took ${fmtDur(digest.durationMs)}.`);
  return trunc(lines.join("\n"), MAX_PROMPT_TOTAL);
}
