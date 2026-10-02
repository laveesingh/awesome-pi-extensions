/** Offline verifier setup. Built-in bash/read/edit/codemode are real; web is sandbox-only. */
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appendFileSync } from "node:fs";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function verifyTurnGroups(pi) {
  const root = resolve(process.env.VISOR_VERIFY_ROOT ?? "");
  if (!root.startsWith("/tmp/") && !root.startsWith("/private/tmp/")) throw new Error("VISOR_VERIFY_ROOT must be a temp sandbox");
  const log = (event) => appendFileSync(join(root, "verification-events.jsonl"), JSON.stringify({ time: Date.now(), ...event }) + "\n");
  pi.on("session_start", async (_event, ctx) => {
    if (resolve(ctx.cwd) !== root) throw new Error("Verifier sandbox cwd mismatch");
    await mkdir(root, { recursive: true });
    for (const [path, text] of [["display.ts", 'export const duration = "before";\nexport const stable = true;\n'], ["format.ts", "format one\nformat two\nformat three\nformat four\n"]]) {
      try { await writeFile(join(root, path), text, { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    log({ type: "ready" });
  });
  for (const event of ["agent_start", "message_start", "message_end", "tool_execution_start", "tool_execution_end", "agent_settled"]) {
    pi.on(event, (data) => log({ type: event, role: data.message?.role, stopReason: data.message?.stopReason, toolName: data.toolName, isError: data.isError }));
  }
  pi.registerTool({ name: "google_search", label: "Sandbox web fixture", description: "Offline verification fixture; no network or real web integration",
    parameters: Type.Object({ query: Type.String() }), async execute() {
      return { content: [{ type: "text", text: "Sandbox source one\nSandbox source two\nNo network request was made" }], details: undefined };
    },
  });
  pi.registerCommand("vqueue", { description: "Queue a sandbox steering + follow-up during the next tool batch", handler: () => { queue = true; pi.sendUserMessage("live"); } });
  const runtimeId = Date.now().toString(36); // tool IDs must remain unique across fixture reloads
  let queue = false, queued = false, stage = 0, serial = 0, scenario = "multi", epoch = 0;
  pi.on("tool_execution_start", () => {
    if (!queue || queued) return;
    queued = true;
    pi.sendUserMessage("steered multi", { deliverAs: "steer" });
    pi.sendUserMessage("follow-up multi", { deliverAs: "followUp" });
  });
  const textOf = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  pi.registerProvider("visor-verify", { baseUrl: "http://offline.invalid", apiKey: "sandbox-not-a-secret", api: "visor-verify",
    models: [{ id: "offline", name: "Offline turn-group verification", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
    streamSimple(model, context, options) {
      if (context.messages.at(-1)?.role === "user") {
        scenario = textOf([...context.messages].reverse().find((m) => m.role === "user")); stage = 0; epoch++;
        if (!queue) queued = false;
      } else stage++;
      const stream = createAssistantMessageEventStream();
      const output = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "pending",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const emitText = (text, thinking = false) => {
        const index = output.content.length;
        const block = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
        output.content.push(block);
        stream.push({ type: thinking ? "thinking_start" : "text_start", contentIndex: index, partial: output });
        if (thinking) block.thinking = text; else block.text = text;
        stream.push({ type: thinking ? "thinking_delta" : "text_delta", contentIndex: index, delta: text, partial: output });
        stream.push({ type: thinking ? "thinking_end" : "text_end", contentIndex: index, content: text, partial: output });
      };
      const emitCall = (name, args) => {
        const index = output.content.length;
        const call = { type: "toolCall", id: `verify-${runtimeId}-${epoch}-${++serial}`, name, arguments: {} };
        output.content.push(call);
        stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        call.arguments = args;
        stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(args), partial: output });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: output });
      };
      void (async () => {
        try {
          await options?.onPayload?.({ scenario, stage }, model);
          await options?.onResponse?.({ status: 200, headers: { "x-visor-verification": "offline" } }, model);
          stream.push({ type: "start", partial: output });
          if (/none/.test(scenario)) { emitText("Direct fixture answer. No tool calls were needed."); output.stopReason = "stop"; }
          else if (/thought/.test(scenario)) {
            if (!stage) { emitText("Managed thought-only fixture reasoning. Its own controls must remain independent.", true); emitCall("bash", { command: "printf 'thought tool output\\n'" }); output.stopReason = "toolUse"; }
            else { emitText("Thought-only fixture finished. Final answer remains native outside."); output.stopReason = "stop"; }
          } else if (stage < 3) {
            if (stage === 0) {
              emitText("I’ll trace the fixture duration, then inspect the expanded render path.\nSettled durations should remain stable after inspection.");
              emitCall("bash", { command: (/live/.test(scenario) ? "sleep 12; " : "") + "printf 'fixture call one\\nfixture call two\\nfixture call three\\n'" });
              emitCall("read", { path: "display.ts" }); emitCall("read", { path: "format.ts" });
            } else if (stage === 1) {
              emitText("The render path should preserve frozen clocks and native diffs.\nI’ll inspect complete codemode output.\nThe sandbox web result stays isolated.");
              emitCall("codemode", { code: 'text("codemode output one");\ntext("codemode output two");' });
              emitCall("google_search", { query: "Sandbox Pi grouping source" });
            } else {
              emitText("The fixture is ready for its native edit diff.\nI’ll run the final controlled checks.\nNo production integration is claimed.");
              // Toggle whichever version is actually on disk, so repeated runs can edit safely.
              const { readFile } = await import("node:fs/promises");
              const current = await readFile(join(root, "display.ts"), "utf8");
              const oldText = current.includes('"before"') ? '"before"' : '"after"';
              emitCall("edit", { path: "display.ts", edits: [{ oldText, newText: oldText === '"before"' ? '"after"' : '"before"' }] });
              emitCall("bash", { command: /error/.test(scenario) ? "printf 'intentional fixture failure\\n'; exit 1" : "printf 'check one\\ncheck two\\n'" });
              emitCall("bash", { command: /long/.test(scenario) ? "for i in $(seq 1 140); do printf 'fixture output %03d: settled duration and expansion PASS\\n' \"$i\"; done" : "printf 'final check one\\nfinal check two\\n'" });
            }
            output.stopReason = "toolUse";
          } else {
            emitText(/error/.test(scenario) ? "The fixture includes one intentionally failed check. No successful validation is claimed." : "The offline fixture finished. Native edit diffs and complete output remain available inside the frame.");
            output.stopReason = "stop"; queue = false;
          }
          if (options?.signal?.aborted) throw new Error("Fixture interrupted");
          stream.push({ type: "done", reason: output.stopReason, message: output }); stream.end();
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error"; output.errorMessage = String(error);
          stream.push({ type: "error", reason: output.stopReason, error: output }); stream.end();
        }
      })();
      return stream;
    },
  });
}
