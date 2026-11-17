import * as core from '../src/core.js';
import type { Mode } from '../src/core.js';

export type Disposable = { dispose: () => void };

export const UNBUNDLED = core.UNBUNDLED_ID;
export const HAND_EDIT = 'Edit SKILL.md by hand first';
export const MODE_LABEL: Record<Mode, string> = { auto: 'Automatically', called: 'When called', off: 'Off' };
export const pluralNoun = (n: number, word: string, suffix = 's') => `${word}${n === 1 ? '' : suffix}`;
export const plural = (n: number, word: string, suffix = 's') => `${n} ${pluralNoun(n, word, suffix)}`;
export const SAVING_BADGE = { label: 'Saving…', tone: 'neutral' } as const;
export const noBundlesBanner = (onClick: () => void) => ({
  tone: 'info' as const,
  title: 'No bundles yet',
  body: 'skill-bundles.json does not exist. Nothing has been changed.',
  action: { label: 'Create from defaults', onClick },
});

export function $(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (!n) throw new Error(`Missing element #${id}`);
  return n;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export const isMenuKey = (e: KeyboardEvent, altEnter = false): boolean =>
  e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') || (altEnter && e.altKey && e.key === 'Enter');

export const isAltClick = (e: MouseEvent): boolean =>
  e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;

export function openAtAnchor(anchor: HTMLElement, open: (x: number, y: number) => void) {
  const r = anchor.getBoundingClientRect();
  open(r.left, r.bottom);
}

export function onAltOrContext(
  target: HTMLElement,
  open: (x: number, y: number, e: MouseEvent) => void,
  ignoreSelector?: string,
  contextIgnoreSelector = ignoreSelector,
): void {
  const ignored = (e: MouseEvent, sel?: string) =>
    Boolean(sel && (e.target as HTMLElement | null)?.closest(sel));
  target.addEventListener('click', (e) => {
    if (!isAltClick(e) || ignored(e, ignoreSelector)) return;
    e.preventDefault();
    open(e.clientX, e.clientY, e);
  });
  target.addEventListener('contextmenu', (e) => {
    if (ignored(e, contextIgnoreSelector)) return;
    e.preventDefault();
    open(e.clientX, e.clientY, e);
  });
}

export function rovingKey(e: KeyboardEvent, rows: readonly HTMLElement[], index: number): boolean {
  const target =
    e.key === 'ArrowDown' ? index + 1
    : e.key === 'ArrowUp' ? index - 1
    : e.key === 'Home' ? 0
    : e.key === 'End' ? rows.length - 1
    : null;
  if (target === null) return false;
  e.preventDefault();
  const r = rows[Math.max(0, Math.min(rows.length - 1, target))];
  if (!r) return true;
  for (const x of rows) x.tabIndex = -1;
  r.tabIndex = 0;
  r.focus();
  return true;
}
