import { InteractiveMode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { RunGroup } from "./run-group.js";
import { CommentaryRunChild, ToolRunChild } from "./run-child.js";
import type { RecordedTiming, ThemeSource } from "./run-style.js";

export interface TranscriptContainer {
  children: Component[];
  addChild(component: Component): void;
  removeChild(component: Component): void;
  clear(): void;
  render(width: number): string[];
}
export interface TranscriptMessage {
  role: string;
  timestamp?: number;
  stopReason?: string;
  toolCallId?: string;
  content?: string | Array<{ type: string; id?: string; text?: string }>;
}
interface ToolTime { assistant?: number; result?: number; resultSeen?: boolean; stopped?: boolean }
export interface FrameRecord {
  group: RunGroup;
  first?: number;
  last?: number;
  startWall?: number;
  live: boolean;
  acceptsRows: boolean;
  hasFirst: boolean;
}
const valid = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
const name = (component: object) => component.constructor.name;
const asAssistant = (c: Component) => c as unknown as import("@earendil-works/pi-coding-agent").AssistantMessageComponent;
const asTool = (c: Component) => c as unknown as import("@earendil-works/pi-coding-agent").ToolExecutionComponent;
const key = Symbol.for("pi.visor.run-integration.instance.v1");

type Mutable = Record<string | symbol, any>;
function replace(target: Mutable, property: string | symbol, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  Object.defineProperty(target, property, { value, configurable: true, writable: true });
  return () => { if (descriptor) Object.defineProperty(target, property, descriptor); else delete target[property]; };
}

/** Pure membership seam, also used by replay against an ordinary fake Container. */
export class TranscriptGrouping {
  readonly frames: FrameRecord[] = [];
  readonly cycleFrames = new Set<FrameRecord>();
  active = true;
  live = false;
  rebuilding = 0;
  message?: TranscriptMessage;
  current?: FrameRecord;
  provisional?: Component;
  private pendingRows: Component[] = [];
  private owners = new WeakMap<object, FrameRecord>();
  private notes = new WeakMap<object, { view: CommentaryRunChild; start?: number }>();
  private tools = new Map<string, { component: Component; view: ToolRunChild; frame: FrameRecord }>();
  private times = new Map<string, ToolTime>();
  private original: Pick<TranscriptContainer, "addChild" | "removeChild" | "clear" | "render">;
  private undo: Array<() => void> = [];
  private arrayUndo?: () => void;
  private componentUndo: Array<() => void> = [];
  private toolUndo = new WeakMap<object, () => void>();
  private warned = false;
  constructor(readonly chat: TranscriptContainer, private readonly theme: ThemeSource,
    private readonly notice: (message: string) => void, private readonly now = Date.now) {
    this.original = { addChild: chat.addChild, removeChild: chat.removeChild, clear: chat.clear, render: chat.render };
  }
  install(): boolean {
    try {
      if (!Array.isArray(this.chat.children) || Object.values(this.original).some((method) => typeof method !== "function")) throw new Error("chat container contract unavailable");
      this.undo.push(replace(this.chat as unknown as Mutable, "addChild", (component: Component) => this.guard(() => this.add(component), () => { if (!this.chat.children.includes(component)) this.original.addChild.call(this.chat, component); })));
      this.undo.push(replace(this.chat as unknown as Mutable, "removeChild", (component: Component) => this.remove(component)));
      this.undo.push(replace(this.chat as unknown as Mutable, "clear", () => this.reset()));
      this.undo.push(replace(this.chat as unknown as Mutable, "render", (width: number) => {
        this.refreshLive();
        return this.original.render.call(this.chat, width);
      }));
      this.patchSplice();
      return true;
    } catch (error) { this.fail(error); return false; }
  }
  private guard(action: () => void, fallback: () => void): void {
    if (!this.active) { fallback(); return; }
    try { action(); }
    catch (error) { this.fail(error); fallback(); }
  }
  private patchSplice(): void {
    this.arrayUndo?.();
    const array = this.chat.children;
    this.arrayUndo = replace(array as unknown as Mutable, "splice", (index: number, count: number, ...items: Component[]) => {
      const removed = Array.prototype.splice.call(array, index, count, ...items) as Component[];
      if (this.provisional && !this.current) this.pendingRows.push(...items);
      return removed;
    });
  }
  private rawRemove(component: Component): void {
    const index = this.chat.children.indexOf(component);
    if (index >= 0) Array.prototype.splice.call(this.chat.children, index, 1);
  }
  private add(component: Component): void {
    const kind = name(component);
    if (kind === "UserMessageComponent" || kind === "SkillInvocationMessageComponent") {
      this.boundary();
      this.original.addChild.call(this.chat, component);
      return;
    }
    if (kind === "AssistantMessageComponent") {
      const m = (component as unknown as { lastMessage?: TranscriptMessage }).lastMessage ?? this.message;
      const calls = Array.isArray(m?.content) && m.content.some((block) => block.type === "toolCall");
      if (calls || m?.stopReason === "toolUse") {
        this.provisional = component;
        this.moveProvisional();
      } else {
        this.original.addChild.call(this.chat, component);
        if (this.live && !this.rebuilding) {
          this.provisional = component;
          this.notes.set(component, { view: undefined as never, start: this.now() });
          if (this.current) this.current.acceptsRows = true;
        } else if (this.current) this.current.acceptsRows = false;
      }
      return;
    }
    if (kind === "ToolExecutionComponent") {
      const frame = this.moveProvisional() ?? this.ensureFrame();
      if (this.live && !this.rebuilding && !frame.live) {
        frame.live = true;
        frame.startWall = frame.first;
        frame.group.setMetadata({ live: true });
        this.cycleFrames.add(frame);
      }
      const id = String((component as unknown as { toolCallId: string }).toolCallId);
      const time = this.times.get(id);
      const view = frame.group.addTool(asTool(component), this.rebuilding ? { timing: this.derived(time), stopped: time?.stopped } : undefined);
      this.owners.set(component, frame);
      this.tools.set(id, { component, view, frame });
      if (this.rebuilding) view.setExpanded(false);
      this.observeTool(component, id);
      return;
    }
    if (this.current?.acceptsRows) {
      this.current.group.addRow(component);
      this.owners.set(component, this.current);
    } else {
      this.original.addChild.call(this.chat, component);
      if (this.provisional && !this.current) this.pendingRows.push(component);
    }
  }
  private derived(time?: ToolTime): RecordedTiming {
    // E8 rev10: message times do not persist actual execution start/end, and
    // parallel batches persist results at batch end. Never infer tool duration.
    return { timestamp: time?.result };
  }
  private observeTool(component: Component, id: string): void {
    const target = component as unknown as Mutable;
    const original = target.updateResult;
    const restore = replace(target, "updateResult", (...args: unknown[]) => {
      const result = original.apply(component, args);
      if (args[1] !== true) {
        const tool = this.tools.get(id);
        const time = this.times.get(id);
        if (tool && this.rebuilding && time?.resultSeen) this.observeTime(tool.frame, time.result);
      }
      return result;
    });
    this.componentUndo.push(restore);
    this.toolUndo.set(component, restore);
  }
  private ensureFrame(): FrameRecord {
    if (this.current) return this.current;
    const group = new RunGroup({ index: this.frames.length + 1, live: this.live && !this.rebuilding }, this.theme);
    const frame: FrameRecord = { group, startWall: this.live && !this.rebuilding ? (this.provisional && this.notes.get(this.provisional)?.start) || this.now() : undefined, live: this.live && !this.rebuilding, acceptsRows: true, hasFirst: false };
    this.frames.push(frame);
    if (frame.live) this.cycleFrames.add(frame);
    this.current = frame;
    this.original.addChild.call(this.chat, group);
    return frame;
  }
  private moveProvisional(): FrameRecord | undefined {
    const component = this.provisional;
    if (!component) return this.current;
    const owned = this.owners.get(component);
    if (owned) return owned;
    const items = this.current ? [component] : this.chat.children.filter((child) => child === component || this.pendingRows.includes(child));
    if (!items.includes(component)) items.push(component);
    const insertion = Math.min(...items.map((child) => this.chat.children.indexOf(child)).filter((index) => index >= 0), this.chat.children.length);
    const wasNew = !this.current;
    const frame = this.ensureFrame();
    if (wasNew) { this.rawRemove(frame.group); Array.prototype.splice.call(this.chat.children, insertion, 0, frame.group); }
    for (const item of items) {
      this.rawRemove(item);
      if (item === component) {
        const m = (item as unknown as { lastMessage?: TranscriptMessage }).lastMessage ?? this.message;
        const previous = this.notes.get(item);
        const view = frame.group.addCommentary(asAssistant(item), { timestamp: valid(m?.timestamp) });
        this.notes.set(item, { view, start: previous?.start ?? (frame.live ? this.now() : undefined) });
        this.observeTime(frame, valid(m?.timestamp));
        if (m?.stopReason === "aborted") frame.group.setMetadata({ outcome: "interrupted" });
      } else frame.group.addRow(item);
      this.owners.set(item, frame);
    }
    this.pendingRows = [];
    return frame;
  }
  private observeTime(frame: FrameRecord, timestamp: number | undefined): void {
    if (!frame.hasFirst) { frame.first = timestamp; frame.hasFirst = true; }
    frame.last = timestamp;
    if (!frame.live) frame.group.setMetadata({ timestamp: frame.first,
      durationMs: frame.first !== undefined && frame.last !== undefined && frame.last >= frame.first ? frame.last - frame.first : undefined });
    else frame.group.setMetadata({ timestamp: frame.first });
  }
  begin(): void { if (this.active) { this.live = true; this.cycleFrames.clear(); } }
  boundary(): void {
    if (this.current) {
      const wasLive = this.current.live;
      this.current.live = false;
      this.current.acceptsRows = false;
      this.current.group.setMetadata({ live: false, ...(wasLive ? { durationMs: this.elapsed(this.current) } : {}) });
    }
    this.current = undefined;
    this.provisional = undefined;
    this.pendingRows = [];
  }
  beforeMessage(message: TranscriptMessage): void {
    if (!this.active) return;
    this.message = message;
    if (message.role === "user") this.boundary();
    this.indexTime(message);
    if (message.role === "toolResult" && message.toolCallId) {
      const tool = this.tools.get(message.toolCallId);
      if (tool) this.observeTime(tool.frame, valid(message.timestamp));
    }
  }
  private indexTime(message: TranscriptMessage): void {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const call of message.content) if (call.type === "toolCall" && call.id) {
        const time = this.times.get(call.id) ?? {};
        time.assistant = valid(message.timestamp);
        time.stopped = message.stopReason === "aborted";
        this.times.set(call.id, time);
      }
    }
    if (message.role === "toolResult" && message.toolCallId) {
      const time = this.times.get(message.toolCallId) ?? {};
      time.result = valid(message.timestamp);
      time.resultSeen = true;
      this.times.set(message.toolCallId, time);
    }
  }
  endAssistant(component: Component | undefined, message: TranscriptMessage): void {
    if (!this.active || !component) return;
    if (message.stopReason === "toolUse") { this.provisional = component; this.moveProvisional(); }
    const note = this.notes.get(component);
    if (note?.view) note.view.setMetadata({ timestamp: valid(message.timestamp), durationMs: note.start === undefined ? undefined : Math.max(0, this.now() - note.start) });
    else if (this.current) this.current.acceptsRows = false;
    this.provisional = undefined;
    this.pendingRows = [];
  }
  stopPending(components: Iterable<Component>): void {
    if (!this.active || !this.live || !this.current) return;
    // D12: an abort belongs only to the currently open user-boundary frame.
    this.current.group.setMetadata({ outcome: "interrupted" });
    for (const component of components) {
      const frame = this.owners.get(component);
      if (!frame || frame !== this.current) continue;
      const entry = frame.group.entries.find((child) => child.component === component);
      if (entry instanceof ToolRunChild) entry.setMetadata({ stopped: true });
      frame.group.setMetadata({ outcome: "interrupted" });
    }
  }
  finish(): void {
    if (!this.active) return;
    this.refreshLive();
    for (const frame of this.cycleFrames) {
      frame.live = false;
      frame.group.setMetadata({ live: false });
      frame.group.settle();
    }
    this.live = false;
    // Each frame evaluates its own touched/error/interruption state exactly once.
  }
  private elapsed(frame: FrameRecord): number | undefined {
    return frame.startWall === undefined ? undefined : Math.max(0, this.now() - frame.startWall);
  }
  private refreshLive(): void {
    for (const frame of this.frames) if (frame.live) frame.group.setMetadata({ durationMs: this.elapsed(frame) });
  }
  remove(component: Component): void {
    const restore = this.toolUndo.get(component);
    if (restore) {
      restore(); this.toolUndo.delete(component);
      const index = this.componentUndo.indexOf(restore);
      if (index >= 0) this.componentUndo.splice(index, 1);
    }
    this.notes.delete(component);
    const id = (component as unknown as { toolCallId?: string }).toolCallId;
    if (id) this.tools.delete(id);
    const frame = this.owners.get(component);
    if (frame) { frame.group.removeChild(component); this.owners.delete(component); }
    else this.original.removeChild.call(this.chat, component);
    if (this.provisional === component) this.provisional = undefined;
  }
  nativeChildren(): Component[] {
    return this.chat.children.flatMap((child) => child instanceof RunGroup ? child.children : [child]);
  }
  groupedNativeChildren(): Component[] { return this.frames.flatMap((frame) => frame.group.children); }
  logicalTail(): TranscriptContainer | RunGroup { return this.current?.acceptsRows ? this.current.group : this.chat; }
  insertRow(group: RunGroup, index: number, component: Component): void {
    const child = group.addRow(component);
    group.entries.pop(); group.children.pop();
    group.entries.splice(index, 0, child); group.children.splice(index, 0, component);
    const frame = this.frames.find((record) => record.group === group)!;
    this.owners.set(component, frame);
  }
  /** Translate native custom-entry indices through the same logical child seam. */
  spliceBefore(anchor: Component | undefined, components: Component[]): void {
    const frame = anchor && this.owners.get(anchor);
    const group = frame?.group ?? (this.current?.acceptsRows ? this.current.group : undefined);
    if (group) {
      let index = anchor ? group.children.indexOf(anchor) : -1;
      if (index < 0) index = group.children.length;
      for (const component of components) this.insertRow(group, index++, component);
    } else {
      let index = anchor ? this.chat.children.indexOf(anchor) : -1;
      if (index < 0) index = this.chat.children.length;
      this.chat.children.splice(index, 0, ...components);
    }
  }
  prepareRebuild(items: TranscriptMessage[]): void {
    for (const item of items) this.indexTime(item);
    this.message = undefined;
  }
  private reset(): void {
    for (const undo of this.componentUndo.splice(0).reverse()) undo();
    for (const frame of this.frames) frame.group.clear();
    this.frames.length = 0; this.cycleFrames.clear(); this.times.clear(); this.tools.clear();
    this.owners = new WeakMap(); this.notes = new WeakMap(); this.toolUndo = new WeakMap();
    this.current = undefined; this.provisional = undefined; this.pendingRows = [];
    this.original.clear.call(this.chat); this.patchSplice();
  }
  private fail(error: unknown): void {
    this.dispose();
    if (!this.warned) { this.warned = true; this.notice(`pi-visor: run grouping unavailable — ${error instanceof Error ? error.message : String(error)}; transcript stays flat`); }
  }
  dispose(): void {
    if (!this.active) return;
    this.active = false;
    const children = Array.isArray(this.chat.children) ? this.chat.children : [];
    const flat = children.flatMap((child) => child instanceof RunGroup ? [...child.children] : [child]);
    for (const undo of this.componentUndo.splice(0).reverse()) undo();
    for (const frame of this.frames) frame.group.clear();
    this.arrayUndo?.();
    if (this.frames.length) Array.prototype.splice.call(children, 0, children.length, ...flat);
    this.frames.length = 0; this.cycleFrames.clear(); this.tools.clear();
    this.current = undefined; this.provisional = undefined;
    this.owners = new WeakMap(); this.notes = new WeakMap();
    for (const undo of this.undo.splice(0).reverse()) undo();
  }
}

const captureKey = Symbol.for("pi.visor.run-integration.capture.v1");
interface CaptureRegistry { owner?: RunGrouping; original: (...args: any[]) => any; captures: Map<Mutable, Mutable> }

/** Capture the actual InteractiveMode, before initial history render, via its UI binding seam. */
export class RunGrouping {
  private modes = new Map<Mutable, { controller: TranscriptGrouping; undo: Array<() => void> }>();
  private registry?: CaptureRegistry;
  private disabled = new WeakSet<object>();
  private warned = false;
  install(pi: ExtensionAPI): void {
    const proto = InteractiveMode.prototype as unknown as Mutable;
    const registry = proto[captureKey] as CaptureRegistry | undefined;
    if (registry) {
      registry.owner?.dispose();
      this.registry = registry; registry.owner = this;
      // /reload reuses UI context and does not invoke its factory again.
      // Hand off the retained live instance before beforeSessionStart rebuild.
      for (const [mode, ui] of registry.captures) this.capture(mode, ui);
    }
    else if (typeof proto.createExtensionUIContext === "function") {
      const state: CaptureRegistry = { owner: this, original: proto.createExtensionUIContext, captures: new Map() };
      proto[captureKey] = state;
      proto.createExtensionUIContext = function (this: Mutable, ...args: unknown[]) {
        const ui = state.original.apply(this, args);
        state.captures.set(this, ui);
        state.owner?.capture(this, ui);
        return ui;
      };
      this.registry = state;
    }
    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode === "tui" && !this.modes.size) this.warn(ctx);
    });
    pi.on("session_shutdown", (event) => {
      this.dispose();
      if (event.reason !== "reload") this.registry?.captures.clear();
    });
  }
  private warn(ctx: ExtensionContext): void {
    if (this.warned) return;
    this.warned = true;
    ctx.ui.notify("pi-visor: run grouping unavailable; transcript stays flat", "warning");
  }
  capture(mode: Mutable, ui: Mutable): void {
    this.registry?.captures.set(mode, ui);
    if (this.modes.has(mode) || this.disabled.has(mode)) return;
    const undo: Array<() => void> = [];
    if (!mode.chatContainer) {
      this.disabled.add(mode);
      if (!this.warned) { this.warned = true; ui.notify("pi-visor: run grouping unavailable — chat container missing; transcript stays flat", "warning"); }
      return;
    }
    const controller = new TranscriptGrouping(mode.chatContainer, () => ui.theme, (message) => {
      this.disabled.add(mode); this.warned = true; ui.notify(message, "warning");
    });
    try {
      for (const method of ["handleEvent", "addMessageToChat", "renderSessionItems", "addCustomEntryToChat", "showStatus"]) {
        if (typeof mode[method] !== "function") throw new Error(`Pi ${method} seam unavailable`);
      }
      if (!controller.install()) return;
      undo.push(replace(mode, key, controller));
      const handle = mode.handleEvent;
      undo.push(replace(mode, "handleEvent", async (event: Mutable) => {
        if (event.type === "agent_start") controller.begin();
        if (event.message) controller.beforeMessage(event.message);
        const ending = event.type === "message_end" && event.message?.role === "assistant" ? mode.streamingComponent : undefined;
        if (ending && event.message.stopReason === "aborted") controller.stopPending(mode.pendingTools.values());
        await handle.call(mode, event);
        if (ending) controller.endAssistant(ending, event.message);
        if (event.type === "agent_settled") controller.finish();
      }));
      const addMessage = mode.addMessageToChat;
      undo.push(replace(mode, "addMessageToChat", (message: TranscriptMessage, ...args: unknown[]) => {
        const previous = controller.message;
        controller.beforeMessage(message);
        try { return addMessage.call(mode, message, ...args); }
        finally { controller.message = previous; }
      }));
      const rebuild = mode.renderSessionItems;
      undo.push(replace(mode, "renderSessionItems", (items: TranscriptMessage[], ...args: unknown[]) => {
        controller.rebuilding++;
        // Index timestamps without inventing operation order: the native loop still renders.
        controller.prepareRebuild(items);
        try { return rebuild.call(mode, items, ...args); }
        finally { controller.rebuilding--; }
      }));
      const thinking = mode.updateThinkingBlockVisibility;
      if (typeof thinking === "function") undo.push(replace(mode, "updateThinkingBlockVisibility", (...args: unknown[]) => {
        const originalChat = mode.chatContainer;
        mode.chatContainer = { children: controller.nativeChildren() };
        try { return thinking.apply(mode, args); }
        finally { mode.chatContainer = originalChat; }
      }));
      const paddingDescriptor = Object.getOwnPropertyDescriptor(mode, "outputPad");
      if (paddingDescriptor && "value" in paddingDescriptor) {
        let padding = mode.outputPad;
        Object.defineProperty(mode, "outputPad", { configurable: true, get: () => padding, set: (value: number) => {
          if (value === padding) return;
          padding = value;
          // The original settings callback already updates direct native siblings;
          // bridge only nested originals and retain D10's fixed group shell.
          for (const child of controller.groupedNativeChildren()) {
            if (["AssistantMessageComponent", "CustomMessageComponent", "UserMessageComponent"].includes(name(child))) {
              (child as unknown as { setOutputPad(value: number): void }).setOutputPad(value);
            }
          }
        } });
        undo.push(() => Object.defineProperty(mode, "outputPad", { ...paddingDescriptor, value: padding }));
      }
      const session = mode.session;
      if (session && typeof session.abort === "function") {
        const abort = session.abort;
        undo.push(replace(session, "abort", (...args: unknown[]) => {
          controller.stopPending(mode.pendingTools.values());
          return abort.apply(session, args);
        }));
      }
      const status = mode.showStatus;
      undo.push(replace(mode, "showStatus", (...args: unknown[]) => {
        const tail = controller.logicalTail();
        if (!(tail instanceof RunGroup)) return status.apply(mode, args);
        const originalChat = mode.chatContainer;
        mode.chatContainer = { children: tail.children, addChild: (component: Component) => controller.insertRow(tail, tail.children.length, component), removeChild: (component: Component) => controller.remove(component) };
        try { return status.apply(mode, args); }
        finally { mode.chatContainer = originalChat; }
      }));
      const custom = mode.addCustomEntryToChat;
      undo.push(replace(mode, "addCustomEntryToChat", (...args: unknown[]) => {
        const tail = controller.logicalTail();
        if (!(tail instanceof RunGroup)) return custom.apply(mode, args);
        const originalChat = mode.chatContainer;
        const array = [...tail.children];
        array.splice = (index: number, count: number, ...components: Component[]) => {
          for (const component of components) controller.insertRow(tail, index++, component);
          return [];
        };
        mode.chatContainer = { children: array, addChild: (component: Component) => controller.insertRow(tail, tail.children.length, component) };
        try { return custom.apply(mode, args); }
        finally { mode.chatContainer = originalChat; }
      }));
      this.modes.set(mode, { controller, undo });
    } catch (error) {
      this.disabled.add(mode);
      controller.dispose();
      for (const restore of undo.reverse()) restore();
      if (!this.warned) { this.warned = true; ui.notify(`pi-visor: run grouping unavailable — ${String(error)}; transcript stays flat`, "warning"); }
    }
  }
  dispose(): void {
    for (const { controller, undo } of this.modes.values()) {
      controller.dispose();
      for (const restore of undo.reverse()) restore();
    }
    this.modes.clear();
    if (this.registry?.owner === this) this.registry.owner = undefined;
  }
}

export function groupingForMode(mode: object): TranscriptGrouping | undefined { return (mode as Mutable)[key]; }
