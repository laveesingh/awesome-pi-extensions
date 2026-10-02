/**
 * Real Pi 0.99.1 native-handler recorder. It does not load visor or group the tree.
 * Only safe offline fixture messages/tools are logged. No terminal captures.
 */
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { InteractiveMode, AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export default function recordPiOrder(pi) {
  const root = resolve(process.env.VISOR_TRACE_ROOT ?? "");
  if (!root.startsWith("/tmp/") && !root.startsWith("/private/tmp/")) throw new Error("VISOR_TRACE_ROOT must be an isolated temp directory");
  const trace = join(root, "native-order.jsonl");
  const ids = new WeakMap();
  let serial = 0, seq = 0, mode, scene = "startup", setup = false, queued = false;
  const seed = process.env.VISOR_ORDER_SEED === "1";
  if (seed) {
    const evidence = JSON.parse(readFileSync(process.env.VISOR_NATURAL_MANIFEST, "utf8"));
    if (!evidence.probedAllThree || Object.values(evidence.removeChildCounts).some((count) => count !== 0)) throw new Error("Seed requires all three natural probes with no cleanup hit");
    const bytes = readFileSync(evidence.tracePath);
    if (createHash("sha256").update(bytes).digest("hex") !== evidence.traceSha256) throw new Error("Natural trace checksum mismatch");
  }
  const log = (data) => appendFileSync(trace, JSON.stringify({ seq: ++seq, time: Date.now(), scene, source: setup ? "FIXTURE SETUP" : "native", ...data }) + "\n");
  function safeMessage(message) {
    if (!message) return undefined;
    if (message.role === "system") return { role: "system", timestamp: message.timestamp };
    return { role: message.role, timestamp: message.timestamp, stopReason: message.stopReason,
      toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError,
      content: message.content, details: message.details, errorMessage: message.errorMessage };
  }
  function safeItem(item) {
    return item.role ? safeMessage(item) : { type: item.type, id: item.id, timestamp: item.timestamp, customType: item.customType, data: item.data };
  }
  function identify(component) {
    if (ids.has(component)) return ids.get(component);
    const id = "c" + (++serial);
    ids.set(component, id);
    const kind = component.constructor.name;
    let text;
    if (!["AssistantMessageComponent", "ToolExecutionComponent"].includes(kind)) {
      try { text = component.render(120).map(stripTerminalSequences).join("\n"); } catch {}
    }
    log({ op: "component", id, kind, toolName: component.toolName, toolCallId: component.toolCallId,
      args: component.args, text, message: safeMessage(component.lastMessage) });
    return id;
  }
  for (const [Class, methods] of [
    [AssistantMessageComponent, ["updateContent"]],
    [ToolExecutionComponent, ["updateArgs", "setExpanded", "setArgsComplete", "markExecutionStarted", "updateResult"]],
  ]) {
    for (const method of methods) {
      const original = Class.prototype[method];
      Class.prototype[method] = function (...args) {
        const id = identify(this);
        const values = method === "updateContent" ? [safeMessage(args[0]), args[1]] : args;
        log({ op: "component_call", id, method, args: values });
        return original.apply(this, args);
      };
    }
  }
  function patchArray(chat) {
    const array = chat.children;
    Object.defineProperty(array, "splice", { configurable: true, value: function (index, count, ...components) {
      log({ op: "splice", index, count, ids: components.map(identify), before: array.map(identify) });
      return Array.prototype.splice.call(array, index, count, ...components);
    } });
  }
  function attach(instance) {
    if (instance.__visorNativeOrderRecorder) return;
    instance.__visorNativeOrderRecorder = true;
    mode = instance;
    const chat = instance.chatContainer;
    for (const method of ["addChild", "removeChild"]) {
      const original = chat[method];
      chat[method] = function (component) {
        log({ op: method, id: identify(component), before: chat.children.map(identify) });
        return original.call(this, component);
      };
    }
    const clear = chat.clear;
    chat.clear = function () { log({ op: "clear", before: chat.children.map(identify) }); const result = clear.call(this); patchArray(chat); return result; };
    patchArray(chat);
    for (const method of ["addMessageToChat", "showStatus", "addCustomEntryToChat", "renderSessionItems"]) {
      const original = instance[method];
      instance[method] = function (...args) {
        const values = method === "addMessageToChat" ? [safeMessage(args[0]), args[1]]
          : method === "renderSessionItems" ? [args[0].map(safeItem), args[1]] : args;
        log({ op: "method", phase: "before", method, args: values });
        const result = original.apply(this, args);
        log({ op: "method", phase: "after", method, ...(method === "showStatus" ? { statusText: ids.get(instance.lastStatusText), statusSpacer: ids.get(instance.lastStatusSpacer), statusMessage: instance.lastStatusMessage } : {}) });
        return result;
      };
    }
    const handler = instance.handleEvent;
    instance.handleEvent = async function (event) {
      if (event.type === "compaction_start") scene = "compaction";
      const data = { type: event.type, message: safeMessage(event.message), toolCallId: event.toolCallId,
        toolName: event.toolName, args: event.args, isError: event.isError, parentToolCallId: event.parentToolCallId,
        entry: event.entry ? safeItem(event.entry) : undefined, aborted: event.aborted };
      log({ op: "event", phase: "before", event: data, streaming: instance.streamingComponent ? identify(instance.streamingComponent) : undefined, pending: [...instance.pendingTools.keys()] });
      if (seed && scene === "seed-cleanup" && event.type === "agent_end" && !instance.streamingComponent) {
        setup = true;
        const empty = new AssistantMessageComponent(undefined);
        log({ op: "fixture_setup", label: "MARKED EMPTY streamingComponent before REAL agent_end", id: identify(empty), naturalManifest: process.env.VISOR_NATURAL_MANIFEST });
        instance.streamingComponent = empty;
        chat.addChild(empty);
        setup = false;
      }
      await handler.call(this, event);
      log({ op: "event", phase: "after", event: data, children: chat.children.map(identify), pending: [...instance.pendingTools.keys()], streaming: instance.streamingComponent ? identify(instance.streamingComponent) : undefined });
    };
    log({ op: "attached", seam: "InteractiveMode.createExtensionUIContext", container: chat.constructor.name });
  }
  const contextFactory = InteractiveMode.prototype.createExtensionUIContext;
  InteractiveMode.prototype.createExtensionUIContext = function (...args) { const ui = contextFactory.apply(this, args); attach(this); return ui; };

  const cli = realpathSync(process.argv[1]);
  let packageRoot = dirname(cli);
  while (true) {
    try { if (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") break; } catch {}
    const parent = dirname(packageRoot);
    if (parent === packageRoot) throw new Error("Cannot resolve running Pi package root");
    packageRoot = parent;
  }
  const dist = join(packageRoot, "dist");
  const nativeSource = join(dist, "modes/interactive/interactive-mode.js");
  writeFileSync(join(root, "provenance.json"), JSON.stringify({ piVersion: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version,
    nodeVersion: process.version, pid: process.pid, actualCli: cli, packageRoot, actualCliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"), nativeHandlerSha256: createHash("sha256").update(InteractiveMode.prototype.handleEvent.toString()).digest("hex"), nativeSource,
    nativeSourceSha256: createHash("sha256").update(readFileSync(nativeSource)).digest("hex"),
    recorderSource: fileURLToPath(import.meta.url), recorderSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
    groupingLoaded: false, source: "Actual InteractiveMode.handleEvent + container methods; no authored operation list", seedEnabled: seed }, null, 2));

  pi.on("session_start", (_event, ctx) => { if (resolve(ctx.cwd) !== root) throw new Error("Recorder cwd mismatch"); log({ op: "session_ready" }); });
  pi.registerEntryRenderer("order-note", () => new Text("Fixture custom entry", 0, 0));
  let customAdded = false;
  pi.on("message_update", (event) => {
    if (scene === "queue" && !customAdded && event.assistantMessageEvent.type === "toolcall_delta") {
      customAdded = true;
      pi.appendEntry("order-note", { label: "fixture custom entry during tool-call stream" });
    }
  });
  pi.on("tool_execution_start", () => {
    if (scene !== "queue" || queued) return;
    queued = true;
    log({ op: "fixture_input", action: "send actual steering and follow-up during active tool execution" });
    pi.sendUserMessage("steer-case", { deliverAs: "steer" });
    pi.sendUserMessage("followup-case", { deliverAs: "followUp" });
  });
  pi.on("session_before_compact", (event) => ({ compaction: { summary: "Offline fixture compaction summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
  pi.registerTool({ name: "fixture_hold", label: "Fixture hold", description: "Sandbox wait; no system writes or services",
    parameters: Type.Object({ delay: Type.Number() }),
    async execute(_id, args, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "Sandbox pending output" }], details: undefined });
      await new Promise((done, reject) => {
        const timer = setTimeout(done, args.delay);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Sandbox wait aborted")); }, { once: true });
      });
      return { content: [{ type: "text", text: "Sandbox tool completed" }], details: undefined };
    },
  });
  let callSerial = 0;
  const textOf = (m) => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  pi.registerProvider("order-fixture", { baseUrl: "http://offline.invalid", apiKey: "sandbox-not-a-secret", api: "order-fixture",
    models: [{ id: "offline", name: "Offline native-order fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
    streamSimple(model, context, options) {
      const last = context.messages.at(-1);
      const user = [...context.messages].reverse().find((m) => m.role === "user");
      const input = textOf(user);
      scene = input.includes("abort-toolstream") ? "abort-toolstream" : input.includes("abort-text") ? "abort-text"
        : input.includes("provider-error") ? "provider-error" : input.includes("seed-cleanup") ? "seed-cleanup"
        : input.includes("no-tool") ? "no-tool" : "queue";
      const stream = createAssistantMessageEventStream();
      const output = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "pending",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        try {
          await options?.onPayload?.({ fixtureInput: input }, model);
          await options?.onResponse?.({ status: 200, headers: { "x-order-fixture": "offline" } }, model);
          stream.push({ type: "start", partial: output });
          const text = { type: "text", text: "" };
          output.content.push(text);
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          text.text = last?.role === "toolResult" || scene === "no-tool" || scene === "seed-cleanup" ? `Final fixture response: ${input}` : `Fixture commentary: ${input}`;
          stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: output });
          const toolUse = scene === "abort-toolstream" || (scene === "queue" && last?.role === "user");
          if (toolUse) {
            const call = { type: "toolCall", id: "order-call-" + (++callSerial), name: "fixture_hold", arguments: {} };
            output.content.push(call);
            stream.push({ type: "toolcall_start", contentIndex: 1, partial: output });
            call.arguments = { delay: input === "queue-case" ? 2000 : 500 };
            stream.push({ type: "toolcall_delta", contentIndex: 1, delta: JSON.stringify(call.arguments), partial: output });
            if (scene !== "abort-toolstream") stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: output });
          }
          if (["abort-text", "abort-toolstream", "provider-error"].includes(scene)) {
            log({ op: "provider_pause", input });
            await new Promise((done, reject) => {
              const timer = setTimeout(done, scene === "provider-error" ? 150 : 30000);
              options?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Native Esc abort")); }, { once: true });
            });
            throw new Error("Sandbox provider midstream error");
          }
          output.stopReason = toolUse ? "toolUse" : "stop";
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
