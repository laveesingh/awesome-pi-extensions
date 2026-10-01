/**
 * Offline fullscreen renderer fixture. No network, credentials, or live tracker.
 * bash/read/edit and builtin:codemode execute real Pi implementations.
 * TaskCreate/web_enable are explicitly sandbox-only tools, not integrations.
 * Real log schema provenance: codemode {code}, TaskCreate {subject, description,
 * activeForm}, TaskUpdate {taskId, status, activeForm}, TaskList {},
 * google_search {query, instruction, thinking}, web_enable {} (2026-10-01).
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export default function fullscreenProvider(pi) {
  const root = resolve(process.env.VISOR_SMOKE_ROOT ?? "");
  if (!root.startsWith(resolve(tmpdir()) + "/") && !root.startsWith("/private/tmp/") && !root.startsWith("/tmp/")) {
    throw new Error("VISOR_SMOKE_ROOT must be an isolated temporary directory");
  }
  pi.on("session_start", async (_event, ctx) => {
    if (resolve(ctx.cwd) !== root) throw new Error("Fixture cwd must equal VISOR_SMOKE_ROOT");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "read.txt"), "read fixture one\nread fixture two\nread fixture three\n");
    await writeFile(join(root, "edit.txt"), "unchanged\nbefore fixture\nend\n");
  });
  pi.on("tool_call", async (event) => {
    await appendFile(join(root, "executions.jsonl"), JSON.stringify({ type: "call", name: event.toolName, input: event.input }) + "\n");
  });
  pi.on("tool_execution_end", async (event) => {
    await appendFile(join(root, "executions.jsonl"), JSON.stringify({ ...event, type: "result" }) + "\n");
  });

  pi.registerTool({
    name: "TaskCreate", label: "Sandbox TaskCreate", description: "Sandbox fixture only; does not create real tasks.",
    parameters: Type.Object({ subject: Type.String(), description: Type.String(), activeForm: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      return { content: [{ type: "text", text: `Sandbox task fixture\n${args.subject}\nNo live tracker was changed` }], details: undefined };
    },
  });
  pi.registerTool({
    name: "web_enable", label: "Sandbox web_enable", description: "Sandbox fixture only; does not connect to web services.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "Sandbox web fixture\nNo network request\nNo settings were changed" }], details: undefined };
    },
  });

  const calls = [
    { name: "bash", arguments: { command: "printf 'bash fixture one\\nbash fixture two\\nbash fixture three\\n'" } },
    { name: "read", arguments: { path: "read.txt" } },
    { name: "edit", arguments: { path: "edit.txt", edits: [{ oldText: "before fixture", newText: "after fixture" }] } },
    { name: "codemode", arguments: { code: 'text("codemode fixture one");\ntext("codemode fixture two");' } },
    { name: "TaskCreate", arguments: { subject: "Sandbox fixture", description: "No live tracker", activeForm: "Checking fixture" } },
    { name: "web_enable", arguments: {} },
  ];
  pi.registerProvider("visor-fixture", {
    baseUrl: "http://offline.invalid", apiKey: "sandbox-not-a-secret", api: "visor-fixture",
    models: [{ id: "offline", name: "Visor offline fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const output = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "pending", timestamp: Date.now() };
      void (async () => {
        try {
          const originalPayload = { runTools: context.messages.at(-1)?.role === "user" };
          const replacement = await options?.onPayload?.(originalPayload, model);
          const payload = replacement ?? originalPayload;
          await options?.onResponse?.({ status: 200, headers: { "x-visor-fixture": "offline" } }, model);
          stream.push({ type: "start", partial: output });
          if (payload.runTools) {
            for (const [index, call] of calls.entries()) {
              if (options?.signal?.aborted) throw new Error("Fixture aborted");
              const toolCall = { type: "toolCall", id: `fixture-${index}`, name: call.name, arguments: {} };
              output.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
              toolCall.arguments = call.arguments;
              stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: output });
              stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
            }
            output.stopReason = "toolUse";
          } else {
            const block = { type: "text", text: "" };
            output.content.push(block);
            stream.push({ type: "text_start", contentIndex: 0, partial: output });
            block.text = "VISOR_SMOKE_COMPLETE";
            stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: output });
            stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
            output.stopReason = "stop";
          }
          stream.push({ type: "done", reason: output.stopReason, message: output });
          stream.end();
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = String(error);
          stream.push({ type: "error", reason: output.stopReason, error: output });
          stream.end();
        }
      })();
      return stream;
    },
  });
}
