// Read-only native render geometry. Never calls render(), mapComponents or mouse handlers.
export function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}
export function cachedChildren(box) {
  if (box.children?.length) return box.children;
  const component = box.component;
  // MouseRegion delegates to its already-rendered child without an offset.
  if (component?.constructor?.name === "MouseRegion" && component.child) {
    return [{ component: component.child, rect: box.rect, clip: box.clip, children: [] }];
  }
  const padded = component?.constructor?.name === "Box";
  const px = padded ? component.paddingX : 0, py = padded ? component.paddingY : 0;
  if (!Number.isInteger(px) || !Number.isInteger(py) || px < 0 || py < 0) return [];
  const width = Math.max(1, box.rect.width - 2 * px), cache = component?.mouseLayout;
  if (cache?.width !== width || !Array.isArray(cache.children) || (box.lineOffset ?? 0) !== 0) return [];
  let y = box.rect.y + py;
  const result = [];
  for (const child of cache.children) {
    if (!Number.isInteger(child.height) || child.height < 0) return []; // unclear contract: no guessed geometry
    const rect = { x: box.rect.x + px, y, width, height: child.height };
    result.push({ component: child.component, rect, clip: intersect(box.clip, rect), children: [] });
    y += child.height;
  }
  return result;
}
export function visiblePoint(box, row = 0, column = 1) {
  const x = box.rect.x + column, y = box.rect.y + row;
  return x >= box.rect.x && x < box.rect.x + box.rect.width && y >= box.rect.y && y < box.rect.y + box.rect.height
    && x >= box.clip.x && x < box.clip.x + box.clip.width && y >= box.clip.y && y < box.clip.y + box.clip.height ? { x, y } : undefined;
}
export function firstMouseRegion(box, seen = new Set()) {
  if (!box?.component || seen.has(box.component)) return undefined;
  seen.add(box.component);
  if (box.component.constructor?.name === "MouseRegion" && typeof box.component.onMouse === "function") return box;
  // Native self-shell tools forward y-1 to this exact cached container.
  if (box.component.selfRenderHeight > 0 && box.component.hasRendererDefinition?.()
      && box.component.getRenderShell?.() === "self") {
    const rect = { ...box.rect, y: box.rect.y + 1, height: box.component.selfRenderHeight };
    return firstMouseRegion({ component: box.component.selfRenderContainer, rect,
      clip: intersect(box.clip, rect), children: [] }, seen);
  }
  for (const child of cachedChildren(box)) {
    const region = firstMouseRegion(child, seen);
    if (region) return region;
  }
  return undefined;
}
