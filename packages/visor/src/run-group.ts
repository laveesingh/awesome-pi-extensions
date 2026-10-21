import type { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AuxiliaryRunChild, CommentaryRunChild, ToolRunChild, type RunChild } from "./run-child.js";
import { statusParts, type RunStatus, type RunTokens } from "./run-status.js";
import { fitLine, type RecordedTiming, type RunTheme, type ThemeSource } from "./run-style.js";
import type { GroupToolPresentation } from "./tool-display.js";

export interface RunMetadata extends RecordedTiming {
  index: number;
  live?: boolean;
  outcome?: "success" | "error" | "interrupted";
  /** Summed over this run's assistant messages; absent until the run has usage. */
  tokens?: RunTokens;
}
export interface ChildRows { child: RunChild; start: number; height: number; width: number }
interface CachedChild {
  width: number; revision: number; theme: RunTheme; lines: string[];
  frameWidth?: number; framedLines?: string[];
}

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
  /** Framed status block per arrow. Settled runs only; the key holds everything the block reads. */
  private blocks = new Map<string, { key: string; theme: RunTheme; lines: string[] }>();
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
      this.cache.delete(child);
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
    this.blocks.clear();
    super.invalidate();
  }
  get counts(): { tools: number; notes: number; errors: number; completedTools: number } {
    const counts = { tools: 0, notes: 0, errors: 0, completedTools: 0 };
    for (const child of this.entries) {
      if (child.kind === "note") counts.notes++;
      else if (child.kind === "tool") {
        counts.tools++;
        if (child.failed) counts.errors++;
        if (child.settled && !child.stopped) counts.completedTools++;
      }
    }
    return counts;
  }
  get childRows(): readonly ChildRows[] { return this.layout; }
  private linesFor(child: RunChild, width: number, theme: RunTheme, frameWidth: number, frame: (line: string) => string): string[] {
    const kind = child.kind + (child instanceof CommentaryRunChild && child.thoughtLines.length ? ":thought" : "");
    if (this.cascade !== undefined && this.cascadeKinds.get(child) !== kind) this.applyCascade(child);
    let cached = this.cache.get(child);
    if (!(child.settled && cached?.width === width && cached.revision === child.revision && cached.theme === theme)) {
      if (cached && cached.theme !== theme) child.invalidate();
      const lines = child.render(width);
      // Native renderers can invalidate while rendering: record the revision afterward.
      cached = { width, revision: child.revision, theme, lines };
      if (child.settled) this.cache.set(child, cached);
    }
    if (child.settled && cached.frameWidth === frameWidth && cached.framedLines) return cached.framedLines;
    const framedLines = cached.lines.map(frame);
    if (child.settled) { cached.frameWidth = frameWidth; cached.framedLines = framedLines; }
    return framedLines; // live/partial and auxiliary output is never cached
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
    const running = this.metadata.live ? this.entries.filter((child) => child.kind === "tool" && !child.settled && !child.stopped).length : 0;
    const color = this.metadata.live ? "warning" : outcome === "success" ? "success" : "error";
    const state: RunStatus = {
      index: this.metadata.index, label: status, dot: color, timestamp: this.metadata.timestamp, durationMs: this.metadata.durationMs,
      tools: counts.tools, running, notes: counts.notes, errors: counts.errors,
      stoppedAfter: outcome === "interrupted" ? counts.completedTools : undefined, tokens: this.metadata.tokens,
    };
    // A settled run's block is reused until something it reads changes; live runs always rebuild.
    const settled = !this.metadata.live;
    const tokens = state.tokens;
    const key = settled ? [state.index, status, color, state.timestamp, state.durationMs, state.tools, state.running, state.notes, state.errors,
      state.stoppedAfter, tokens?.input, tokens?.cache, tokens?.output, innerWidth].join("|") : "";
    let parts: ReturnType<typeof statusParts> | undefined; // row 2 is built once per render and shared by header and footer
    const block = (arrow: string): string[] => {
      const cached = settled ? this.blocks.get(arrow) : undefined;
      if (cached && cached.key === key && cached.theme === t) return cached.lines;
      parts ??= statusParts(t, state, innerWidth);
      const lines = [...parts.first(arrow), ...parts.rest].map(frame);
      if (settled) this.blocks.set(arrow, { key, theme: t, lines });
      return lines;
    };
    const lines = [border("┌", "┐"), ...block(this.expanded ? "▾" : "▸")];
    for (let row = 0; row < lines.length; row++) this.parentMouseRows.add(row);
    if (this.expanded) {
      this.parentMouseRows.add(lines.length);
      lines.push(border("├", "┤"));
      let previousKind: RunChild["kind"] | undefined;
      for (const child of this.entries) {
        const childLines = this.linesFor(child, innerWidth, t, w, frame);
        if (!childLines.length) continue;
        if (previousKind && previousKind !== "row" && child.kind !== "row") lines.push(frame(""));
        this.layout.push({ child, start: lines.length, height: childLines.length, width: innerWidth });
        // Child renderers own wrapping/background; linesFor reuses only settled frames.
        lines.push(...childLines);
        previousKind = child.kind;
      }
      this.parentMouseRows.add(lines.length);
      const footer = block("▴");
      for (let row = 0; row < footer.length; row++) this.parentMouseRows.add(lines.length + 1 + row);
      lines.push(border("├", "┤"), ...footer);
    }
    this.parentMouseRows.add(lines.length);
    lines.push(border("└", "┘"));
    // Terminal widths smaller than the frame's four-cell budget can only clip.
    return w < 5 ? lines.map((line) => fitLine(line, w)) : lines;
  }
}
