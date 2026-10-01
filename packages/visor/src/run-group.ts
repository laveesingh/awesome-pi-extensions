import type { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { AuxiliaryRunChild, CommentaryRunChild, ToolRunChild, type RunChild } from "./run-child.js";
import { fitLine, timingParts, type RecordedTiming, type RunTheme, type ThemeSource } from "./run-style.js";
import type { GroupToolPresentation } from "./tool-display.js";

export interface RunMetadata extends RecordedTiming {
  index: number;
  live?: boolean;
  outcome?: "success" | "error" | "interrupted";
  keptOpen?: boolean;
}
export interface ChildRows { child: RunChild; start: number; height: number; width: number }
interface CachedChild { width: number; revision: number; theme: RunTheme; lines: string[] }

/** Rendering-only slice. Insertion, settlement policy and native clicks arrive later. */
export class RunGroup extends Container {
  readonly __visorRunGroup = true;
  readonly entries: RunChild[] = [];
  expanded: boolean;
  private metadata: RunMetadata;
  private cache = new WeakMap<RunChild, CachedChild>();
  private layout: ChildRows[] = [];
  constructor(metadata: RunMetadata, private readonly theme: ThemeSource, expanded = !!metadata.live) {
    super();
    this.metadata = { ...metadata };
    this.expanded = expanded;
  }
  setMetadata(metadata: Partial<RunMetadata>): void { Object.assign(this.metadata, metadata); }
  /** Layer 1 only: preserve individual child states, unlike the later Ctrl+O cascade. */
  setLayerExpanded(expanded: boolean): void { this.expanded = expanded; }
  addTool(component: ToolExecutionComponent, metadata?: GroupToolPresentation): ToolRunChild {
    const child = new ToolRunChild(component, metadata);
    this.entries.push(child);
    super.addChild(component);
    return child;
  }
  addCommentary(component: AssistantMessageComponent, timing?: RecordedTiming): CommentaryRunChild {
    const child = new CommentaryRunChild(component, this.theme, timing);
    this.entries.push(child);
    super.addChild(component);
    return child;
  }
  addRow(component: Component): AuxiliaryRunChild {
    const child = new AuxiliaryRunChild(component);
    this.entries.push(child);
    super.addChild(component);
    return child;
  }
  override removeChild(component: Component): void {
    const index = this.entries.findIndex((entry) => entry.component === component);
    if (index >= 0) {
      const child = this.entries.splice(index, 1)[0];
      if ("detach" in child) (child as RunChild & { detach(): void }).detach();
    }
    super.removeChild(component);
  }
  override clear(): void {
    for (const child of [...this.entries]) this.removeChild(child.component);
    super.clear();
  }
  override invalidate(): void {
    this.cache = new WeakMap();
    super.invalidate();
  }
  get counts(): { tools: number; notes: number; errors: number; completedTools: number } {
    return {
      tools: this.entries.filter((child) => child.kind === "tool").length,
      notes: this.entries.filter((child) => child.kind === "note").length,
      errors: this.entries.filter((child) => child.kind === "tool" && child.failed).length,
      completedTools: this.entries.filter((child) => child.kind === "tool" && child.settled && !child.stopped).length,
    };
  }
  get childRows(): readonly ChildRows[] { return this.layout; }
  private linesFor(child: RunChild, width: number, theme: RunTheme): string[] {
    const cached = this.cache.get(child);
    if (child.settled && cached?.width === width && cached.revision === child.revision && cached.theme === theme) {
      return cached.lines;
    }
    if (cached && cached.theme !== theme) child.invalidate();
    const lines = child.render(width);
    if (child.settled) this.cache.set(child, { width, revision: child.revision, theme, lines });
    return lines;
  }
  override render(width: number): string[] {
    this.layout = [];
    const counts = this.counts;
    if (!counts.tools) return []; // P1: never an empty or commentary-only frame.
    const t = this.theme();
    const w = Math.max(1, Math.floor(width));
    const innerWidth = Math.max(1, w - 4);
    const border = (left: string, right: string) => t.fg("borderMuted", left + "─".repeat(Math.max(0, w - 2)) + right);
    const frame = (line: string) => t.fg("borderMuted", "│") + " " + fitLine(line, innerWidth) + " " + t.fg("borderMuted", "│");
    const outcome = this.metadata.outcome === "interrupted" ? "interrupted"
      : counts.errors ? "error" : this.metadata.outcome ?? "success";
    const status = this.metadata.live ? "Working" : outcome === "interrupted" ? "Interrupted"
      : outcome === "error" ? "Worked · recovered" : "Worked";
    const color = this.metadata.live ? "warning" : outcome === "success" ? "success" : "error";
    const header = t.fg("accent", this.expanded ? "▾" : "▸") + " " + t.fg(color, "●") + " "
      + t.fg("text", t.bold(`Run ${this.metadata.index} · ${status}`));
    const duration = timingParts({ durationMs: this.metadata.durationMs }, true)[0];
    const timestamp = timingParts({ timestamp: this.metadata.timestamp })[0];
    const parts = [`${counts.tools} ${counts.tools === 1 ? "tool" : "tools"}`, `${counts.notes} ${counts.notes === 1 ? "note" : "notes"}`, ...(duration ? [duration] : []),
      `${counts.errors} ${counts.errors === 1 ? "error" : "errors"}` +
      (outcome === "interrupted" ? ` · stopped after ${counts.completedTools} ${counts.completedTools === 1 ? "tool" : "tools"}` : ""), ...(timestamp ? [timestamp] : [])];
    const kept = this.metadata.keptOpen || outcome !== "success" ? " · kept open" : "";
    const meta = t.fg("muted", parts.join(" • ") + kept + " (ctrl+o)");
    const lines = [border("┌", "┐"), ...wrapTextWithAnsi(header, innerWidth).map(frame)];
    // Meta keeps its two-cell indent on every wrapped row.
    lines.push(...wrapTextWithAnsi(meta, Math.max(1, innerWidth - 2)).map((line) => frame("  " + line)));
    if (this.expanded) {
      lines.push(border("├", "┤"));
      let previousKind: RunChild["kind"] | undefined;
      for (const child of this.entries) {
        const childLines = this.linesFor(child, innerWidth, t);
        if (!childLines.length) continue;
        if (previousKind && previousKind !== "row" && child.kind !== "row") lines.push(frame(""));
        this.layout.push({ child, start: lines.length, height: childLines.length, width: innerWidth });
        // Child renderers own wrapping/background. Never give them document width.
        lines.push(...childLines.map(frame));
        previousKind = child.kind;
      }
      lines.push(border("├", "┤"), frame(t.fg("muted", this.metadata.live ? "Run in progress" : "End of run · final response below")));
    }
    lines.push(border("└", "┘"));
    // Terminal widths smaller than the frame's four-cell budget can only clip.
    return w < 5 ? lines.map((line) => fitLine(line, w)) : lines;
  }
}
