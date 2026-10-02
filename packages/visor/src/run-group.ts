import type { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TuiMouseEvent, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

/** Bounded frame, native mouse routing and independent two-layer state. */
export class RunGroup extends Container {
  readonly __visorRunGroup = true;
  readonly entries: RunChild[] = [];
  expanded: boolean;
  private metadata: RunMetadata;
  private cache = new WeakMap<RunChild, CachedChild>();
  private layout: ChildRows[] = [];
  private layoutWidth = 0;
  private parentMouseRows = new Set<number>();
  private cascade?: boolean;
  private cascadeKinds = new WeakMap<RunChild, string>();
  private runActive: boolean;
  private settledOnce = false;
  touched = false;
  constructor(metadata: RunMetadata, private readonly theme: ThemeSource, expanded = !!metadata.live) {
    super();
    this.metadata = { ...metadata };
    this.expanded = expanded;
    this.runActive = !!metadata.live;
  }
  setMetadata(metadata: Partial<RunMetadata>): void {
    Object.assign(this.metadata, metadata);
    if (metadata.live) this.runActive = true;
  }
  markTouched(): void {
    if (!this.runActive) return;
    this.touched = true;
    this.metadata.keptOpen = true;
  }
  /** Native Ctrl+O: both layers, with D12's distinct thought-only meaning. */
  setExpanded(expanded: boolean): void {
    this.markTouched();
    this.expanded = expanded;
    this.cascade = expanded;
    for (const child of this.entries) this.applyCascade(child);
  }
  private applyCascade(child: RunChild): void {
    if (this.cascade === undefined) return;
    this.cascadeKinds.set(child, child.kind + (child instanceof CommentaryRunChild && child.thoughtLines.length ? ":thought" : ""));
    if (child instanceof ToolRunChild) child.setExpanded(this.cascade);
    else if (child instanceof CommentaryRunChild) {
      child.setGroupExpanded(this.cascade);
      if (child.kind === "row" && child.thoughtLines.length) {
        (child.component as unknown as { setExpanded?(value: boolean): void }).setExpanded?.(this.cascade);
      }
    }
  }
  /** Once, per frame: earlier closed frames are not relabeled by a later abort. */
  settle(): void {
    if (!this.runActive || this.settledOnce) return;
    this.settledOnce = true;
    this.runActive = false;
    this.metadata.live = false;
    if (this.touched || this.counts.errors || this.metadata.outcome === "error" || this.metadata.outcome === "interrupted") {
      this.metadata.keptOpen = true;
      return;
    }
    this.expanded = false;
  }
  /** Layer 1 only: preserve individual child states, unlike the later Ctrl+O cascade. */
  setLayerExpanded(expanded: boolean): void { this.expanded = expanded; }
  addTool(component: ToolExecutionComponent, metadata?: GroupToolPresentation): ToolRunChild {
    const child = new ToolRunChild(component, metadata);
    this.entries.push(child);
    super.addChild(component);
    this.applyCascade(child);
    return child;
  }
  addCommentary(component: AssistantMessageComponent, timing?: RecordedTiming): CommentaryRunChild {
    const child = new CommentaryRunChild(component, this.theme, timing);
    this.entries.push(child);
    super.addChild(component);
    this.applyCascade(child);
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
    const kind = child.kind + (child instanceof CommentaryRunChild && child.thoughtLines.length ? ":thought" : "");
    if (this.cascade !== undefined && this.cascadeKinds.get(child) !== kind) this.applyCascade(child);
    const cached = this.cache.get(child);
    if (child.settled && cached?.width === width && cached.revision === child.revision && cached.theme === theme) {
      return cached.lines;
    }
    if (cached && cached.theme !== theme) child.invalidate();
    const lines = child.render(width);
    if (child.settled) this.cache.set(child, { width, revision: child.revision, theme, lines });
    return lines;
  }
  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    const handled = () => ({ handled: true as const, render: true, target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height } });
    if (event.y < 0 || event.y >= event.height || event.x < 0 || event.x >= event.width) return undefined;
    if (this.layoutWidth !== event.width) this.render(event.width);
    const primary = event.type === "click" && event.button === "left";
    const row = this.expanded ? this.layout.find((entry) => event.y >= entry.start && event.y < entry.start + entry.height) : undefined;
    if (row) {
      if (event.x < 2 || event.x >= event.width - 2) return undefined;
      const local = { ...event, x: event.x - 2, y: event.y - row.start, width: row.width, height: row.height };
      if (row.child instanceof ToolRunChild) {
        const before = (row.child.component as unknown as { expanded: boolean }).expanded;
        const result = row.child.handleMouse(local);
        if (before !== (row.child.component as unknown as { expanded: boolean }).expanded) this.markTouched();
        return result;
      }
      if (row.child instanceof CommentaryRunChild && primary) {
        const thought = row.child.thoughtLayout(row.width).find((entry) => local.y >= entry.start && local.y < entry.start + entry.height);
        if (thought) { thought.component.setExpanded(!thought.component.expanded); this.markTouched(); return handled(); }
        if (row.child.kind === "note") { row.child.setGroupExpanded(!row.child.expanded); this.markTouched(); return handled(); }
      }
      return undefined; // auxiliary rows are not group/child toggle targets
    }
    if (!primary || !this.parentMouseRows.has(event.y)) return undefined;
    this.markTouched();
    this.setLayerExpanded(!this.expanded);
    return handled();
  }
  override render(width: number): string[] {
    this.layout = [];
    this.parentMouseRows.clear();
    this.layoutWidth = width;
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
    for (let row = 0; row < lines.length; row++) this.parentMouseRows.add(row);
    if (this.expanded) {
      this.parentMouseRows.add(lines.length);
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
      this.parentMouseRows.add(lines.length);
      this.parentMouseRows.add(lines.length + 1);
      lines.push(border("├", "┤"), frame(t.fg("muted", this.metadata.live ? "Run in progress" : "End of run · final response below")));
    }
    this.parentMouseRows.add(lines.length);
    lines.push(border("└", "┘"));
    // Terminal widths smaller than the frame's four-cell budget can only clip.
    return w < 5 ? lines.map((line) => fitLine(line, w)) : lines;
  }
}
