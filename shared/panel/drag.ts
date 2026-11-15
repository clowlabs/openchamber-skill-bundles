// Generic drag controller: small items dropped on zones. Pointer events; touch needs a
// long-press or a sideways move, so vertical scrolling keeps working.

export type DragOptions = {
  /** Selector of drop zones (closest ancestor under the pointer). */
  zoneSelector: string;
  /** Zone id: data attribute name on the zone element, e.g. "zone" for data-zone. */
  zoneKey: string;
  /** Class on the zone under the pointer. */
  dropClass?: string;
  /** Class on the floating clone. */
  ghostClass?: string;
  /** Class on the original item while dragging. */
  draggingClass?: string;
  /** Long-press time for touch, ms. */
  longPressMs?: number;
  /** Items that must not be dragged (they can still be clicked). */
  canDrag: (id: string) => boolean;
  /** A drop on another zone. */
  onDrop: (id: string, from: string, to: string, altKey: boolean) => void;
  /** Pointer went down and up without dragging. */
  onClick: (id: string) => void;
  /** Runs once the drag ends, if a render was deferred during it. */
  onEnd: () => void;
};

type Drag = {
  id: string; from: string; item: HTMLElement; pointerId: number; touch: boolean;
  x: number; y: number; timer: ReturnType<typeof setTimeout> | null;
  ghost: HTMLElement | null; over: HTMLElement | null;
};

export type DragController = {
  /** Wire to the item's pointerdown. `from` is the zone it starts in. */
  onPointerDown: (e: PointerEvent, id: string, from: string) => void;
  end: (commitDrop: boolean, altKey?: boolean) => void;
  isDragging: () => boolean;
  /** Ask for a render once the drag ends (instead of re-rendering under it). */
  deferRender: () => void;
  dispose: () => void;
};

export function createDrag(o: DragOptions): DragController {
  const dropClass = o.dropClass ?? 'drop';
  const ghostClass = o.ghostClass ?? 'drag-ghost';
  const draggingClass = o.draggingClass ?? 'dragging';
  const longPress = o.longPressMs ?? 250;
  let drag: Drag | null = null;
  let deferred = false;

  const zoneAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y)?.closest(o.zoneSelector) as HTMLElement | null) ?? null;
  const zoneId = (el: HTMLElement | null) => el?.dataset[o.zoneKey];

  function startGhost(d: Drag, x: number, y: number) {
    if (!o.canDrag(d.id)) return;
    d.ghost = d.item.cloneNode(true) as HTMLElement;
    d.ghost.classList.add(ghostClass);
    document.body.appendChild(d.ghost);
    d.item.classList.add(draggingClass);
    moveGhost(d, x, y);
  }
  function moveGhost(d: Drag, x: number, y: number) {
    if (!d.ghost) return;
    d.ghost.style.left = `${x + 8}px`;
    d.ghost.style.top = `${y + 8}px`;
    const z = zoneAt(x, y);
    const target = z && zoneId(z) !== d.from ? z : null;
    if (target !== d.over) {
      d.over?.classList.remove(dropClass);
      target?.classList.add(dropClass);
      d.over = target;
    }
  }

  function end(commitDrop: boolean, altKey = false) {
    const d = drag;
    if (!d) return;
    drag = null;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    d.item.removeEventListener('lostpointercapture', onCancel);
    if (d.timer != null) clearTimeout(d.timer);
    d.over?.classList.remove(dropClass);
    d.ghost?.remove();
    d.item.classList.remove(draggingClass);
    try { if (d.item.hasPointerCapture(d.pointerId)) d.item.releasePointerCapture(d.pointerId); } catch {}
    const to = zoneId(d.over);
    if (commitDrop && d.ghost && to && to !== d.from) o.onDrop(d.id, d.from, to, altKey);
    else if (commitDrop && !d.ghost) o.onClick(d.id);
    if (deferred) { deferred = false; o.onEnd(); }
  }

  function onPointerDown(e: PointerEvent, id: string, from: string) {
    if (drag || e.button !== 0) return;
    const item = e.currentTarget as HTMLElement;
    const touch = e.pointerType !== 'mouse';
    const d: Drag = { id, from, item, pointerId: e.pointerId, touch, x: e.clientX, y: e.clientY, timer: null, ghost: null, over: null };
    if (touch) d.timer = setTimeout(() => { d.timer = null; if (drag === d) startGhost(d, d.x, d.y); }, longPress);
    drag = d;
    try { item.setPointerCapture(e.pointerId); } catch {}
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    item.addEventListener('lostpointercapture', onCancel);
  }
  function onMove(e: PointerEvent) {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.ghost) { moveGhost(d, e.clientX, e.clientY); return; }
    const dx = Math.abs(e.clientX - d.x), dy = Math.abs(e.clientY - d.y);
    if (d.touch) {
      if (dx > 10 && dx > dy) startGhost(d, e.clientX, e.clientY);
      else if (dy > 10) end(false);
    } else if (Math.hypot(dx, dy) >= 5) {
      startGhost(d, e.clientX, e.clientY);
    }
  }
  function onUp(e: PointerEvent) {
    if (drag && e.pointerId === drag.pointerId) end(true, e.altKey);
  }
  function onCancel(e: PointerEvent) {
    if (drag && e.pointerId === drag.pointerId) end(false);
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && drag) end(false); };
  // Once a touch drag is live, keep the page from scrolling under it.
  const onTouchMove = (e: TouchEvent) => { if (drag?.ghost && e.cancelable) e.preventDefault(); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('touchmove', onTouchMove, { passive: false });

  return {
    onPointerDown,
    end,
    isDragging: () => drag != null,
    deferRender: () => { deferred = true; },
    dispose() {
      end(false);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('touchmove', onTouchMove);
    },
  };
}
