// Defers external-sync DOM rebuilds while the user is actively editing a Page input/textarea
// or mid-pointer-press (e.g. clicking Save), keeping focusout armed across control transitions.

export type EditGuardDeps = {
  isEditing: () => boolean;
  isTargetDeleted: () => boolean;
  onDefer: () => void;
  onRender: () => void;
  enabled?: boolean;
};

export function createEditGuard(deps: EditGuardDeps) {
  let pending = false;
  let focusAttached = false;
  let pointerAttached = false;
  let pointerActive = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (flushTimer != null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const detachFocusOut = () => {
    if (!focusAttached || typeof document === 'undefined') return;
    focusAttached = false;
    document.removeEventListener('focusout', onFocusOut);
  };

  const attachFocusOut = () => {
    if (focusAttached || typeof document === 'undefined') return;
    focusAttached = true;
    document.addEventListener('focusout', onFocusOut);
  };

  const reset = () => {
    pending = false;
    clearTimer();
    detachFocusOut();
  };

  const flushIfReady = () => {
    if (!pending) {
      detachFocusOut();
      return;
    }
    if (!deps.isEditing() || deps.isTargetDeleted()) {
      reset();
      deps.onRender();
    }
  };

  const onFocusOut = () => {
    if (pointerActive) return;
    queueMicrotask(flushIfReady);
  };

  const onPointerDown = () => {
    pointerActive = true;
    clearTimer();
  };

  const onPointerEnd = () => {
    pointerActive = false;
    if (!pending) return;
    clearTimer();
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushIfReady();
    }, 0);
  };

  const pointerListeners = (): [EventTarget, string, EventListener][] => {
    const out: [EventTarget, string, EventListener][] = [];
    if (typeof document !== 'undefined') {
      for (const ev of ['pointerdown', 'mousedown']) out.push([document, ev, onPointerDown]);
      for (const ev of ['pointerup', 'mouseup', 'pointercancel', 'click']) out.push([document, ev, onPointerEnd]);
    }
    if (typeof window !== 'undefined') {
      for (const ev of ['pointerup', 'mouseup', 'pointercancel']) out.push([window, ev, onPointerEnd]);
    }
    return out;
  };

  const attachPointer = () => {
    if (pointerAttached || typeof document === 'undefined') return;
    pointerAttached = true;
    for (const [target, ev, fn] of pointerListeners()) target.addEventListener(ev, fn, true);
  };

  const detachPointer = () => {
    pointerActive = false;
    if (!pointerAttached) return;
    pointerAttached = false;
    for (const [target, ev, fn] of pointerListeners()) target.removeEventListener(ev, fn, true);
  };

  if (deps.enabled !== false) attachPointer();

  return {
    enable: attachPointer,
    onExternalSync() {
      if (!deps.isTargetDeleted() && (deps.isEditing() || pointerActive || flushTimer != null)) {
        deps.onDefer();
        pending = true;
        attachFocusOut();
        return;
      }
      reset();
      deps.onRender();
    },
    markRendered: reset,
    dispose() {
      reset();
      detachPointer();
    },
    isPending: () => pending,
  };
}
