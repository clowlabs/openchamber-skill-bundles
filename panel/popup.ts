// Shared floating-menu shell and the OpenChamber project list, used by send.ts and projects.ts.
import { HostRequestError, type HostClient } from '@openchamber/sdk';
import * as core from '../src/core.js';

export type Project = { id: string; name: string; directory: string };

// ---------- project list (one subscription for every menu) ----------

let host: HostClient;
export let projects: Project[] = [];
export let projectsState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
export let projectsError = '';
let subscribed = false;
const listeners = new Set<() => void>();

export function initPopup(h: HostClient) {
  host = h;
}

export const codeOf = (e: unknown) => (e instanceof HostRequestError ? e.code : '');

/** Start listing projects (once); `onChange` runs on each snapshot. Returns an unsubscribe. */
export function watchProjects(onChange: () => void): () => void {
  listeners.add(onChange);
  const notify = () => listeners.forEach((l) => l());
  if (!subscribed) {
    subscribed = true;
    projectsState = 'loading';
    const apply = (snap: { state: string; projects: Project[] }) => {
      projects = snap.projects.filter((p) => !core.isChatsDir(p.directory)).sort((a, b) => a.name.localeCompare(b.name));
      projectsState = snap.state === 'error' ? 'error' : snap.state === 'ready' ? 'ready' : 'loading';
      if (snap.state === 'error') projectsError = 'OpenChamber could not list projects.';
      notify();
    };
    const fail = (e: unknown) => {
      subscribed = false;
      projectsState = 'error';
      projectsError = codeOf(e) === 'NOT_GRANTED'
        ? 'Needs the “sessions” permission. Re-approve Skill Bundles in Settings → Extensions.'
        : `Could not list projects: ${e instanceof Error ? e.message : String(e)}`;
      notify();
    };
    host.listProjects().then(apply, fail);
    host.onProjects(apply).catch((e) => {
      subscribed = false;
      console.warn('skill-bundles: onProjects failed', e);
    });
  }
  return () => listeners.delete(onChange);
}

let knownHome: () => string | undefined = () => undefined;
/** main passes io's derived home so display and storage agree. */
export function setHomeSource(fn: () => string | undefined) {
  knownHome = fn;
}
function homeOf(dir: string) {
  return knownHome() ?? /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/.exec(dir)?.[1];
}
export const shortDir = (dir: string) => core.shortenDir(dir, homeOf(dir));

/** The status line to show instead of an empty project list, or null. */
export function projectsNote(shownCount: number, filter: string): string | null {
  if (projectsState === 'error') return projectsError;
  if (shownCount) return null;
  return projectsState === 'loading' ? 'Loading projects…' : filter ? 'No matching projects' : 'No projects in OpenChamber';
}

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

type PopupOptions = {
  role?: 'menu' | 'dialog';
  className?: string;
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

/** Create an empty menu shell; call `show` after filling it. Only one is open at a time. */
export function createPopup(opts: PopupOptions): Popup & { show: (x: number, y: number) => void; items: () => HTMLElement[]; ensureFilter: (count: number, placeholder: string, onInput: (v: string) => void) => void } {
  closePopup();
  const menu = document.createElement('div');
  menu.className = `sb-ctx${opts.className ? ` ${opts.className}` : ''}`;
  menu.setAttribute('role', opts.role ?? 'menu');
  menu.tabIndex = -1;
  const title = document.createElement('div');
  title.className = 'sb-ctx-title';
  const list = document.createElement('div');
  list.className = 'sb-ctx-items';
  const foot = document.createElement('div');
  foot.className = 'sb-ctx-foot';
  menu.append(title, list, foot);

  const items = () => [...list.querySelectorAll<HTMLElement>(opts.itemSelector)].filter((n) => !(n as HTMLButtonElement).disabled);

  const popup = {
    menu, title, list, foot, filterInput: null as HTMLInputElement | null,
    close,
    items,
    ensureFilter(count: number, placeholder: string, onInput: (v: string) => void) {
      if (count <= 8 || popup.filterInput) return;
      const f = document.createElement('input');
      f.className = 'sb-ctx-filter';
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
export function note(text: string) {
  const n = document.createElement('div');
  n.className = 'sb-ctx-note';
  n.textContent = text;
  return n;
}
