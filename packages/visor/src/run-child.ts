import type { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripAnsi } from "./format.js";
import { timingParts, type RecordedTiming, type ThemeSource } from "./run-style.js";
import { ownsTool, setGroupedToolPresentation, type GroupToolPresentation } from "./tool-display.js";
import type { ThoughtLine } from "./thinking.js";

export interface RunChild {
  readonly component: Component;
  readonly kind: "tool" | "note" | "row";
  readonly revision: number;
  readonly settled: boolean;
  readonly failed: boolean;
  readonly stopped: boolean;
  render(width: number): string[];
  invalidate(): void;
}

/** Observe real component updates, including native renderer asynchronous invalidation. */
class RevisionObserver {
  revision = 0;
  private undo: Array<() => void> = [];
  protected observe(component: object, names: string[]): void {
    const target = component as Record<string, unknown>;
    for (const name of names) {
      const original = target[name];
      if (typeof original !== "function") continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      const self = this;
      target[name] = function (this: object, ...args: unknown[]) {
        try { return original.apply(this, args); }
        finally { self.revision++; }
      };
      this.undo.push(() => {
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete target[name];
      });
    }
  }
  protected restore(): void {
    for (const undo of this.undo.reverse()) undo();
    this.undo = [];
  }
}

type ToolInternals = {
  toolName: string;
  result?: { isError?: boolean };
  isPartial: boolean;
  contentBox: { paddingY: number; invalidate(): void };
};

/** Group-only shell adapter; the native tool renderer and expand methods stay in charge. */
export class ToolRunChild extends RevisionObserver implements RunChild {
  readonly kind = "tool";
  readonly presentation: GroupToolPresentation;
  private readonly native: ToolInternals;
  private readonly oldPadding: number;
  private readonly owned: boolean;
  constructor(readonly component: ToolExecutionComponent, metadata: GroupToolPresentation = {}) {
    super();
    this.native = component as unknown as ToolInternals;
    this.owned = ownsTool(this.native.toolName);
    this.oldPadding = this.native.contentBox.paddingY;
    this.presentation = { ...metadata };
    if (this.owned) {
      this.native.contentBox.paddingY = 0; // D10: keep native paddingX=1 and background.
      setGroupedToolPresentation(component, this.presentation);
      component.invalidate();
    }
    this.observe(component, ["updateDisplay", "updateArgs", "setArgsComplete", "markExecutionStarted", "updateResult", "setExpanded", "invalidate"]);
  }
  get settled(): boolean { return this.native.result !== undefined && !this.native.isPartial; }
  get failed(): boolean { return !!this.native.result?.isError && !this.stopped; }
  get stopped(): boolean { return !!this.presentation.stopped; }
  setMetadata(metadata: GroupToolPresentation): void {
    Object.assign(this.presentation, metadata);
    this.component.invalidate();
  }
  setExpanded(expanded: boolean): void { this.component.setExpanded(expanded); }
  render(width: number): string[] {
    const lines = this.component.render(width);
    // Pi prepends a Spacer(1). RunGroup owns the one inter-child gap instead.
    return this.owned && lines.length && !stripAnsi(lines[0]).trim() ? lines.slice(1) : lines;
  }
  invalidate(): void { this.component.invalidate(); }
  detach(): void {
    this.restore();
    if (this.owned) {
      this.native.contentBox.paddingY = this.oldPadding;
      setGroupedToolPresentation(this.component);
      this.component.invalidate();
    }
  }
}

type AssistantInternals = {
  lastMessage?: { timestamp?: number; content: Array<{ type: string; text?: string }> };
  isStreaming: boolean;
  contentContainer: { children: Array<Component & { __visorThoughtLine?: boolean }> };
};

/** A wrapper state, not AssistantMessageComponent.setExpanded (which means thinking). */
export class CommentaryRunChild extends RevisionObserver implements RunChild {
  readonly kind = "note";
  readonly failed = false;
  readonly stopped = false;
  expanded = false;
  private metadata: RecordedTiming;
  private readonly native: AssistantInternals;
  constructor(readonly component: AssistantMessageComponent, private readonly theme: ThemeSource, timing: RecordedTiming = {}) {
    super();
    this.native = component as unknown as AssistantInternals;
    this.metadata = { ...timing };
    this.observe(component, ["updateContent", "invalidate"]);
  }
  get settled(): boolean { return !this.native.isStreaming; }
  setMetadata(timing: RecordedTiming): void { this.metadata = { ...timing }; this.revision++; }
  setGroupExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.revision++;
  }
  get thoughtLines(): ThoughtLine[] {
    return this.native.contentContainer.children.filter((child) => child.__visorThoughtLine === true) as ThoughtLine[];
  }
  /** Slice 3 uses these row ranges to retain the thought line's own click meaning. */
  thoughtLayout(width: number): Array<{ component: ThoughtLine; start: number; height: number }> {
    if (!this.expanded) return [];
    let start = wrapTextWithAnsi(this.footer(), width).length + 1;
    return this.thoughtLines.map((component) => {
      const height = component.render(width).length;
      const row = { component, start, height };
      start += height;
      return row;
    });
  }
  private text(): string {
    return (this.native.lastMessage?.content ?? []).filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text!).join("\n");
  }
  private footer(): string {
    const text = this.text();
    const count = text.split("\n").filter((line) => line.trim()).length;
    const parts = timingParts({ timestamp: this.metadata.timestamp ?? this.native.lastMessage?.timestamp, durationMs: this.metadata.durationMs }, true);
    return this.theme().fg("muted", `↳ ${count} line${count === 1 ? "" : "s"}${parts.map((part) => ` • ${part}`).join("")} (ctrl+o)`);
  }
  render(width: number): string[] {
    const t = this.theme();
    const text = this.text();
    const header = t.fg("text", t.bold("Commentary") + (text ? ` ${text.split("\n")[0]}` : ""));
    const lines = [truncateToWidth(header, width, "…"), ...wrapTextWithAnsi(this.footer(), width)];
    if (this.expanded) {
      lines.push(...this.thoughtLines.flatMap((line) => line.render(width)));
      lines.push(...wrapTextWithAnsi(t.fg("muted", text), width));
    }
    return lines;
  }
  invalidate(): void { this.component.invalidate(); }
  detach(): void { this.restore(); }
}

/** Status/custom rows participate in ordering, never tool/note counts or expansion. */
export class AuxiliaryRunChild extends RevisionObserver implements RunChild {
  readonly kind = "row";
  // Custom/status rows have no settlement lifecycle; never cache unknown state.
  readonly settled = false;
  readonly failed = false;
  readonly stopped = false;
  constructor(readonly component: Component) { super(); this.observe(component, ["invalidate"]); }
  render(width: number): string[] { return this.component.render(width); }
  invalidate(): void { this.component.invalidate(); }
  detach(): void { this.restore(); }
}
