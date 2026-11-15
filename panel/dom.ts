import * as core from '../src/core.js';
import type { Mode } from '../src/core.js';

export type Disposable = { dispose: () => void };

export const UNBUNDLED = core.UNBUNDLED_ID;
export const HAND_EDIT = 'Edit SKILL.md by hand first';
export const MODE_LABEL: Record<Mode, string> = { auto: 'Automatically', called: 'When called', off: 'Off' };

export const $ = (id: string) => document.getElementById(id)!;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
