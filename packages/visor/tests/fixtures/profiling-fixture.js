// Committed synthetic workload. Never reads a user session, prompt, or tool result.
export const sizes = [100, 1000, 5000];
export const widths = [80, 120];
export const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export function payload(count) {
  if (!sizes.includes(count)) throw new Error("Unsupported synthetic fixture size");
  return Array.from({ length: count }, (_, i) =>
    `\x1b[48;2;20;30;40m\x1b[38;2;80;90;100mfixture ${String(i).padStart(4, "0")} 界 é ${"payload ".repeat(6)}\x1b[0m`).join("\n");
}
/** Complete Pi Terminal contract; no real input, cursor, title, or progress side effects. */
export function mockTerminal(width, onWrite) {
  return { columns: width, rows: 40, kittyProtocolActive: false,
    write: onWrite, start() {}, stop() {}, async drainInput() {},
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
}
export function transcript(count) {
  const assistant = (content, stopReason, timestamp) => ({ role: "assistant", content, stopReason,
    api: "fixture-offline", provider: "fixture-offline", model: "offline", usage: zeroUsage, timestamp });
  return [
    { role: "user", content: "Synthetic profiling fixture. No command will execute.", timestamp: 1700000000000 },
    assistant([{ type: "thinking", thinking: "Synthetic grouped thought: preserve independent expansion." },
      { type: "text", text: "Synthetic commentary note.\nIts body is independent of the nested thought." },
      { type: "toolCall", id: "profile-settled", name: "bash", arguments: { command: "synthetic fixture (not executed)" } }], "toolUse", 1700000000100),
    { role: "toolResult", toolCallId: "profile-settled", toolName: "bash", content: [{ type: "text", text: payload(count) }],
      isError: false, timestamp: 1700000000200 },
    assistant([{ type: "thinking", thinking: "Synthetic standalone thought." },
      { type: "text", text: "Synthetic final prose outside group targets." }], "stop", 1700000000300),
  ];
}
