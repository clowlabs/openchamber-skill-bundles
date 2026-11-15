// Pill drag & drop between bundles, on the shared drag controller.
import { createDrag, type DragController } from '../shared/panel/drag';

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

let ctl: DragController;

export function initDrag(cb: DragCallbacks) {
  ctl = createDrag({
    zoneSelector: '.sb-group',
    zoneKey: 'bundle',
    dropClass: 'drop',
    ghostClass: 'sb-ghost',
    draggingClass: 'dragging',
    ...cb,
  });
}

export const isDragging = () => ctl?.isDragging() ?? false;
export const deferRender = () => ctl.deferRender();
export const endDrag = (commitDrop: boolean, altKey = false) => ctl?.end(commitDrop, altKey);
export const onPillDown = (e: PointerEvent, id: string, from: string) => ctl.onPointerDown(e, id, from);
