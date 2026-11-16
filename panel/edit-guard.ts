// Defers external-sync DOM rebuilds while the user is actively editing a Page input/textarea
// or mid-pointer-press (e.g. clicking Save), keeping focusout armed across control transitions.

export type EditGuardDeps = {
  isEditing: () => boolean;
  isTargetDeleted: () => boolean;
  onDefer: () => void;
  onRender: () => void;
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

  const flushIfReady = () => {
    if (!pending) {
      detachFocusOut();
      return;
    }
    if (!deps.isEditing() || deps.isTargetDeleted()) {
      pending = false;
      clearTimer();
      detachFocusOut();
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

  const attachPointer = () => {
    if (pointerAttached || typeof document === 'undefined') return;
    pointerAttached = true;
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerEnd, true);
    document.addEventListener('mouseup', onPointerEnd, true);
    document.addEventListener('pointercancel', onPointerEnd, true);
    document.addEventListener('click', onPointerEnd, true);
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerup', onPointerEnd, true);
      window.addEventListener('mouseup', onPointerEnd, true);
      window.addEventListener('pointercancel', onPointerEnd, true);
    }
  };

  const detachPointer = () => {
    pointerActive = false;
    if (!pointerAttached) return;
    pointerAttached = false;
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerEnd, true);
      document.removeEventListener('mouseup', onPointerEnd, true);
      document.removeEventListener('pointercancel', onPointerEnd, true);
      document.removeEventListener('click', onPointerEnd, true);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('mouseup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
    }
  };

  attachPointer();

  return {
    onExternalSync() {
      if (!deps.isTargetDeleted() && (deps.isEditing() || pointerActive || flushTimer != null)) {
        deps.onDefer();
        pending = true;
        attachFocusOut();
        return;
      }
      pending = false;
      clearTimer();
      detachFocusOut();
      deps.onRender();
    },
    markRendered() {
      pending = false;
      clearTimer();
      detachFocusOut();
    },
    dispose() {
      pending = false;
      clearTimer();
      detachFocusOut();
      detachPointer();
    },
    isPending: () => pending,
  };
}
