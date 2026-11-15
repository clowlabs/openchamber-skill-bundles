// Pill drag & drop between bundles (pointer events; touch needs a long-press or a sideways move).

export type DragCallbacks = {
  /** Skills that must not be dragged (they can still be clicked). */
  canDrag: (id: string) => boolean;
  /** A real drop on another bundle. */
  onDrop: (id: string, from: string, to: string, altKey: boolean) => void;
  /** Pointer went down and up without dragging. */
  onClick: (id: string) => void;
  /** Runs once the drag ends, if a render was deferred during it. */
  onEnd: () => void;
};

type Drag = {
  id: string; from: string; pill: HTMLElement; pointerId: number; touch: boolean;
  x: number; y: number; timer: number | null;
  ghost: HTMLElement | null; over: HTMLElement | null;
};

let cb: DragCallbacks;
let drag: Drag | null = null;
let deferred = false;

export function initDrag(callbacks: DragCallbacks) {
  cb = callbacks;
}

export const isDragging = () => drag != null;

/** Called by render while a drag is active; the render runs at drag end instead. */
export function deferRender() {
  deferred = true;
}

function groupAt(x: number, y: number): HTMLElement | null {
  const n = document.elementFromPoint(x, y);
  return (n?.closest('.sb-group') as HTMLElement | null) ?? null;
}

// Broken skills can be clicked to select, never dragged (long-press timer and move both land here).
function startGhost(d: Drag, x: number, y: number) {
  if (!cb.canDrag(d.id)) return;
  d.ghost = d.pill.cloneNode(true) as HTMLElement;
  d.ghost.classList.add('sb-ghost');
  document.body.appendChild(d.ghost);
  d.pill.classList.add('dragging');
  moveGhost(d, x, y);
}
function moveGhost(d: Drag, x: number, y: number) {
  if (!d.ghost) return;
  d.ghost.style.left = `${x + 8}px`;
  d.ghost.style.top = `${y + 8}px`;
  const g = groupAt(x, y);
  const target = g && g.dataset.bundle !== d.from ? g : null;
  if (target !== d.over) {
    d.over?.classList.remove('drop');
    target?.classList.add('drop');
    d.over = target;
  }
}

export function endDrag(commitDrop: boolean, altKey = false) {
  const d = drag;
  if (!d) return;
  drag = null;
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerup', onUp);
  document.removeEventListener('pointercancel', onCancel);
  d.pill.removeEventListener('lostpointercapture', onCancel);
  if (d.timer != null) clearTimeout(d.timer);
  d.over?.classList.remove('drop');
  d.ghost?.remove();
  d.pill.classList.remove('dragging');
  try { if (d.pill.hasPointerCapture(d.pointerId)) d.pill.releasePointerCapture(d.pointerId); } catch {}
  const to = d.over?.dataset.bundle;
  if (commitDrop && d.ghost && to && to !== d.from) cb.onDrop(d.id, d.from, to, altKey);
  else if (commitDrop && !d.ghost) cb.onClick(d.id);
  if (deferred) { deferred = false; cb.onEnd(); }
}

export function onPillDown(e: PointerEvent, id: string, from: string) {
  if (drag || e.button !== 0) return;
  const pill = e.currentTarget as HTMLElement;
  const touch = e.pointerType !== 'mouse';
  const d: Drag = { id, from, pill, pointerId: e.pointerId, touch, x: e.clientX, y: e.clientY, timer: null, ghost: null, over: null };
  if (touch) d.timer = window.setTimeout(() => { d.timer = null; if (drag === d) startGhost(d, d.x, d.y); }, 250);
  drag = d;
  try { pill.setPointerCapture(e.pointerId); } catch {}
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onCancel);
  pill.addEventListener('lostpointercapture', onCancel);
}
function onMove(e: PointerEvent) {
  const d = drag;
  if (!d || e.pointerId !== d.pointerId) return;
  if (d.ghost) { moveGhost(d, e.clientX, e.clientY); return; }
  const dx = Math.abs(e.clientX - d.x), dy = Math.abs(e.clientY - d.y);
  if (d.touch) {
    if (dx > 10 && dx > dy) startGhost(d, e.clientX, e.clientY);
    else if (dy > 10) endDrag(false);
  } else if (Math.hypot(dx, dy) >= 5) {
    startGhost(d, e.clientX, e.clientY);
  }
}
function onUp(e: PointerEvent) {
  if (drag && e.pointerId === drag.pointerId) endDrag(true, e.altKey);
}
function onCancel(e: PointerEvent) {
  if (drag && e.pointerId === drag.pointerId) endDrag(false);
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag) endDrag(false); });
// Once a touch drag is live, keep the page from scrolling under it.
document.addEventListener('touchmove', (e) => { if (drag?.ghost && e.cancelable) e.preventDefault(); }, { passive: false });
