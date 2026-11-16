// Rail panel: a compact hot-swap list of bundles. Full editing lives in the Page.
import { mountBadge, mountBanner, mountSwitch } from '@openchamber/sdk/ui';
import type { Bundle } from '../src/core.js';
import { el, type Disposable } from './dom';
import { S, meta, pending, seedDefaults, toggleBundle } from './io';
import { countsFromState, renderMeterHeader } from '../status/counts';

let mounts: Disposable[] = [];
/** Bundle id whose row has keyboard focus, kept across re-renders. */
let focusId: string | null = null;
/** Bundle whose skill list is open; null shows the bundle list. */
let openId: string | null = null;
/** Move focus after the next render (opening or leaving a bundle). */
let moveFocus = false;
/** Document-level Escape handler while a bundle is open. */
let escOff: (() => void) | null = null;

const skillCount = (n: number) => `${n} skill${n === 1 ? '' : 's'}`;

export function renderCompact(root: HTMLElement) {
  const hadFocus = root.contains(document.activeElement) || moveFocus;
  const onSwitch = !moveFocus && !!document.activeElement?.closest('.sb-c-title .sb-c-switch');
  moveFocus = false;
  mounts.forEach((m) => m.dispose());
  mounts = [];
  escOff?.();
  escOff = null;
  root.textContent = '';

  const head = el('div', 'sb-c-head');
  root.appendChild(head);
  const state = S.state;
  if (!S.loaded) return;
  if (!state) {
    openId = null;
    const b = el('div');
    root.appendChild(b);
    mounts.push(mountBanner(b, {
      tone: 'info', title: 'No bundles yet',
      body: 'skill-bundles.json does not exist. Nothing has been changed.',
      action: { label: 'Create from defaults', onClick: seedDefaults },
    }));
    root.appendChild(hint());
    return;
  }

  const open = openId ? state.bundles.find((b) => b.id === openId) : undefined;
  if (open) return renderBundle(root, head, open, hadFocus, onSwitch);
  openId = null; // the open bundle was deleted elsewhere

  const c = countsFromState(state, S.allIds, S.opencodeText);
  const { wrap, left } = renderMeterHeader(c);
  head.appendChild(wrap);
  if (pending()) busyBadge(left);

  const list = el('div', 'sb-c-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Bundles. Up/Down to move, Enter to see its skills, Space to turn on or off.');
  root.appendChild(list);
  const rows: HTMLElement[] = [];
  const ids = state.bundles.map((b) => b.id);
  const stop = focusId && ids.includes(focusId) ? focusId : ids[0];

  for (const b of state.bundles) {
    const row = el('div', `sb-c-row${b.enabled ? ' on' : ''}`);
    row.dataset.id = b.id;
    const n = b.projects?.length ?? 0;
    const proj = n ? ` · +${n} project${n > 1 ? 's' : ''}` : '';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.setAttribute('aria-label', `${b.name}, ${b.enabled ? 'on' : 'off'}, ${skillCount(b.skills.length)}${proj}`);
    row.title = 'Show the skills in this bundle';
    row.tabIndex = b.id === stop ? 0 : -1;
    const text = el('div', 'sb-c-text');
    const name = el('span', 'sb-c-name');
    const chev = el('span', 'sb-c-chev', '›');
    chev.setAttribute('aria-hidden', 'true');
    name.append(el('span', 'sb-c-name-text', b.name), chev);
    text.appendChild(name);
    const m = el('span', 'sb-c-meta', skillCount(b.skills.length));
    if (proj) m.appendChild(el('span', 'sb-c-proj', proj));
    text.appendChild(m);
    row.appendChild(text);
    // The row is the one tab stop (Enter opens, Space toggles); the switch takes pointer clicks
    // only, so it is kept out of the tab order.
    row.appendChild(bundleSwitch(b, false));
    row.addEventListener('click', () => openBundle(root, b.id));
    row.addEventListener('focus', () => { focusId = b.id; });
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      const i = rows.indexOf(row);
      const go = (j: number) => {
        const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
        rows.forEach((x) => (x.tabIndex = -1));
        r.tabIndex = 0;
        r.focus();
      };
      if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1); }
      else if (e.key === 'Home') { e.preventDefault(); go(0); }
      else if (e.key === 'End') { e.preventDefault(); go(rows.length - 1); }
      else if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); openBundle(root, b.id); }
      else if (e.key === ' ') { e.preventDefault(); focusId = b.id; toggleBundle(b.id); }
    });
    rows.push(row);
    list.appendChild(row);
  }
  if (!rows.length) root.appendChild(el('div', 'sb-c-empty', 'No bundles. Create some in the editor.'));
  if (hadFocus) rows.find((r) => r.dataset.id === stop)?.focus();
  root.appendChild(hint());
}

/** One bundle's skills: name and description only; settings live in the Page. */
function renderBundle(root: HTMLElement, head: HTMLElement, b: Bundle, hadFocus: boolean, onSwitch: boolean) {
  const bar = el('div', 'sb-c-back-bar');
  const back = el('button', 'sb-c-back', '‹ All bundles');
  back.type = 'button';
  back.setAttribute('aria-keyshortcuts', 'Escape');
  back.addEventListener('click', () => closeBundle(root));
  bar.appendChild(back);
  head.appendChild(bar);
  if (pending()) busyBadge(bar);

  const title = el('div', 'sb-c-title');
  const text = el('div', 'sb-c-text');
  const h = el('h2', 'sb-c-title-name', b.name);
  h.id = 'sb-c-open-title';
  text.appendChild(h);
  const n = b.projects?.length ?? 0;
  const m = el('span', 'sb-c-meta', `${skillCount(b.skills.length)} · ${b.enabled ? 'live' : 'off'}`);
  if (n) m.appendChild(el('span', 'sb-c-proj', ` · +${n} project${n > 1 ? 's' : ''}`));
  text.appendChild(m);
  title.appendChild(text);
  // Here the switch is the only control for the bundle, so it stays in the tab order.
  const sw = bundleSwitch(b, true);
  title.appendChild(sw);
  root.appendChild(title);

  const list = el('ul', 'sb-c-skills');
  list.setAttribute('aria-labelledby', h.id);
  for (const id of b.skills) {
    const li = el('li', 'sb-c-skill');
    li.appendChild(el('span', 'sb-c-skill-id', id));
    const d = meta(id).description;
    if (d) li.appendChild(el('span', 'sb-c-skill-desc', d));
    list.appendChild(li);
  }
  if (!b.skills.length) list.appendChild(el('li', 'sb-c-empty', 'No skills in this bundle yet.'));
  root.appendChild(list);
  root.appendChild(hint('Edit this bundle: open Skill Bundles from Pages in the sidebar'));

  // On the document, so Escape still works after a click on plain text moves focus to body.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeBundle(root); }
  };
  document.addEventListener('keydown', onKey);
  escOff = () => document.removeEventListener('keydown', onKey);
  if (hadFocus) (onSwitch ? sw.querySelector<HTMLElement>('button') ?? back : back).focus();
}

function bundleSwitch(b: Bundle, focusable: boolean) {
  const sw = el('span', 'sb-c-switch');
  sw.addEventListener('click', (e) => e.stopPropagation());
  sw.title = b.enabled ? 'Turn this bundle off' : 'Turn this bundle on';
  mounts.push(mountSwitch(sw, { label: '', checked: b.enabled, onChange: (on) => { focusId = b.id; toggleBundle(b.id, on); } }));
  const btn = sw.querySelector<HTMLElement>('button');
  if (focusable) btn?.setAttribute('aria-labelledby', 'sb-c-open-title');
  else {
    for (const f of sw.querySelectorAll<HTMLElement>('button, input, [tabindex]')) {
      f.tabIndex = -1;
      f.setAttribute('aria-hidden', 'true');
    }
    // A click must not park focus on the hidden button: keep it on the row.
    sw.addEventListener('mousedown', (e) => {
      e.preventDefault();
      (sw.closest('.sb-c-row') as HTMLElement | null)?.focus();
    });
  }
  return sw;
}

function openBundle(root: HTMLElement, id: string) {
  focusId = id;
  openId = id;
  moveFocus = true;
  renderCompact(root);
}

function closeBundle(root: HTMLElement) {
  openId = null;
  moveFocus = true;
  renderCompact(root);
}

const hint = (text = 'Edit bundles and skills: open Skill Bundles from Pages in the sidebar') => el('div', 'sb-c-hint', text);

function busyBadge(at: HTMLElement) {
  const s = el('span', 'sb-c-busy');
  at.appendChild(s);
  mounts.push(mountBadge(s, { label: 'Saving…', tone: 'neutral' }));
}

/** While a save is queued: only the Saving… badge, so the row being clicked isn't replaced. */
export function renderCompactBusy() {
  const left = document.querySelector<HTMLElement>('.sb-c-head .skm-left, .sb-c-head .sb-c-back-bar');
  if (!left || left.querySelector('.sb-c-busy') || !pending()) return;
  busyBadge(left);
}
