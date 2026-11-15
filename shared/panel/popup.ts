// Floating menu shell for panels: one open at a time, kept in the viewport, keyboard navigation,
// optional filter box and Alt/Option tracking. Fill `list`, then call `show(x, y)`.

// ---------- menu shell ----------

export type Popup = {
  menu: HTMLElement;
  title: HTMLElement;
  list: HTMLElement;
  foot: HTMLElement;
  /** The filter box, once there are more than 8 items (created by ensureFilter). */
  filterInput: HTMLInputElement | null;
  close: () => void;
};

export type PopupOptions = {
  role?: 'menu' | 'dialog';
  /** Extra class on the menu element. */
  className?: string;
  /** Class prefix for the shell's own elements (default "popup": "<p>", "<p>-title", …). */
  classPrefix?: string;
  /** Track the Alt/Option key: called with the new state on every change (initial value from `altAtOpen`). */
  onAlt?: (down: boolean) => void;
  altAtOpen?: boolean;
  /** Selector of the focusable items arrow keys move through. */
  itemSelector: string;
  returnFocus?: HTMLElement | null;
  /** Extra key handling (runs first, for keydown and keyup); return true to stop. */
  onKey?: (e: KeyboardEvent) => boolean | void;
  onClose?: () => void;
};

let open: Popup | null = null;

export function closePopup() {
  open?.close();
}

export function isPopupOpen(): boolean {
  return open !== null;
}

/** Create an empty menu shell; call `show` after filling it. Only one is open at a time. */
export function createPopup(opts: PopupOptions): Popup & { show: (x: number, y: number) => void; items: () => HTMLElement[]; ensureFilter: (count: number, placeholder: string, onInput: (v: string) => void) => void } {
  closePopup();
  const p = opts.classPrefix ?? 'popup';
  let altDown = !!opts.altAtOpen;
  const menu = document.createElement('div');
  menu.className = `${p}${opts.className ? ` ${opts.className}` : ''}`;
  menu.setAttribute('role', opts.role ?? 'menu');
  menu.tabIndex = -1;
  const title = document.createElement('div');
  title.className = `${p}-title`;
  const list = document.createElement('div');
  list.className = `${p}-items`;
  const foot = document.createElement('div');
  foot.className = `${p}-foot`;
  menu.append(title, list, foot);

  const items = () => [...list.querySelectorAll<HTMLElement>(opts.itemSelector)].filter((n) => !(n as HTMLButtonElement).disabled);

  const popup = {
    menu, title, list, foot, filterInput: null as HTMLInputElement | null,
    /** Current Alt/Option state (with onAlt). */
    get altDown() { return altDown; },
    close,
    items,
    ensureFilter(count: number, placeholder: string, onInput: (v: string) => void) {
      if (count <= 8 || popup.filterInput) return;
      const f = document.createElement('input');
      f.className = `${p}-filter`;
      f.placeholder = placeholder;
      f.setAttribute('aria-label', placeholder);
      f.addEventListener('input', () => onInput(f.value));
      menu.insertBefore(f, list);
      popup.filterInput = f;
    },
    show(x: number, y: number) {
      menu.style.left = '0px';
      menu.style.top = '0px';
      menu.style.visibility = 'hidden';
      document.body.appendChild(menu);
      place(menu, x, y);
      menu.style.visibility = '';
      (popup.filterInput ?? items()[0] ?? menu).focus();
    },
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Alt' && opts.onAlt) {
      const down = e.type === 'keydown';
      if (down !== altDown) { altDown = down; opts.onAlt(down); }
    }
    if (opts.onKey?.(e)) return;
    if (e.type !== 'keydown') return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    const inText = e.target instanceof HTMLInputElement && e.target !== popup.filterInput;
    if (inText) return; // let text fields keep their keys
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!all.length) return;
      const n = e.key === 'ArrowDown' ? (i + 1) % all.length : i <= 0 ? all.length - 1 : i - 1;
      all[n].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? all[0] : all[all.length - 1])?.focus();
    } else if (e.key === 'Enter' && document.activeElement === popup.filterInput) {
      e.preventDefault();
      all[0]?.click();
    } else if (e.key === 'Tab' && opts.role !== 'dialog') {
      e.preventDefault();
      (popup.filterInput && document.activeElement !== popup.filterInput ? popup.filterInput : all[0])?.focus();
    }
  };
  const onDown = (e: PointerEvent) => { if (!menu.contains(e.target as Node)) close(); };
  const onBlur = () => close();

  function close() {
    if (open !== popup) return;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onBlur);
    menu.remove();
    opts.onClose?.();
    if (opts.returnFocus?.isConnected) opts.returnFocus.focus();
  }

  open = popup;
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  menu.addEventListener('contextmenu', (e) => e.preventDefault());
  return popup;
}

/** Keep the menu inside the viewport, flipping near the right and bottom edges. */
export function place(menu: HTMLElement, x: number, y: number) {
  const pad = 4;
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x + r.width + pad > vw ? x - r.width : x;
  let top = y + r.height + pad > vh ? y - r.height : y;
  left = Math.max(pad, Math.min(left, vw - r.width - pad));
  top = Math.max(pad, Math.min(top, vh - r.height - pad));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

/** Re-place an open menu after its content changed size. */
export function replace(menu: HTMLElement) {
  const r = menu.getBoundingClientRect();
  place(menu, r.left, r.top);
}

export function button(text: string, cls: string) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  if (text) b.textContent = text;
  return b;
}
export function note(text: string, classPrefix = 'popup') {
  const n = document.createElement('div');
  n.className = `${classPrefix}-note`;
  n.textContent = text;
  return n;
}
