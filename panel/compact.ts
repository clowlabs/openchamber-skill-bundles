// Rail panel: a compact hot-swap list of bundles. Full editing lives in the Page.
import { mountBadge, mountBanner, mountSwitch } from '@openchamber/sdk/ui';
import { el, type Disposable } from './dom';
import { S, pending, seedDefaults, toggleBundle } from './io';
import { countsFromState, renderMeterHeader } from '../status/counts';

let mounts: Disposable[] = [];
/** Bundle id whose row has keyboard focus, kept across re-renders. */
let focusId: string | null = null;

export function renderCompact(root: HTMLElement) {
  const hadFocus = root.contains(document.activeElement);
  mounts.forEach((m) => m.dispose());
  mounts = [];
  root.textContent = '';

  const head = el('div', 'sb-c-head');
  root.appendChild(head);
  const state = S.state;
  if (!S.loaded) return;
  if (!state) {
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

  const c = countsFromState(state, S.allIds, S.opencodeText);
  const { wrap, left } = renderMeterHeader(c);
  head.appendChild(wrap);
  if (pending()) busyBadge(left);

  const list = el('div', 'sb-c-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Bundles. Up/Down to move, Space or Enter to turn on or off.');
  root.appendChild(list);
  const rows: HTMLElement[] = [];
  const ids = state.bundles.map((b) => b.id);
  const stop = focusId && ids.includes(focusId) ? focusId : ids[0];

  for (const b of state.bundles) {
    const row = el('div', `sb-c-row${b.enabled ? ' on' : ''}`);
    row.dataset.id = b.id;
    row.setAttribute('aria-label', `${b.name}, ${b.skills.length} skills`);
    row.tabIndex = b.id === stop ? 0 : -1;
    const text = el('div', 'sb-c-text');
    text.appendChild(el('span', 'sb-c-name', b.name));
    const meta = el('span', 'sb-c-meta', `${b.skills.length} skill${b.skills.length === 1 ? '' : 's'}`);
    const n = b.projects?.length ?? 0;
    if (n) meta.appendChild(el('span', 'sb-c-proj', ` · +${n} project${n > 1 ? 's' : ''}`));
    text.appendChild(meta);
    row.appendChild(text);
    // The row is the one tab stop and handles Space/Enter; the switch only shows state and takes
    // pointer clicks, so it is kept out of the tab order.
    const sw = el('span', 'sb-c-switch');
    sw.addEventListener('click', (e) => e.stopPropagation());
    row.appendChild(sw);
    mounts.push(mountSwitch(sw, { label: '', checked: b.enabled, onChange: (on) => { focusId = b.id; toggleBundle(b.id, on); } }));
    for (const f of sw.querySelectorAll<HTMLElement>('button, input, [tabindex]')) {
      f.tabIndex = -1;
      f.setAttribute('aria-hidden', 'true');
    }
    row.setAttribute('role', 'switch');
    row.setAttribute('aria-checked', b.enabled ? 'true' : 'false');
    row.addEventListener('click', () => { focusId = b.id; toggleBundle(b.id); });
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
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); focusId = b.id; toggleBundle(b.id); }
    });
    rows.push(row);
    list.appendChild(row);
  }
  if (!rows.length) list.appendChild(el('div', 'sb-c-empty', 'No bundles. Create some in the editor.'));
  if (hadFocus) rows.find((r) => r.dataset.id === focusId)?.focus();
  root.appendChild(hint());
}

const hint = () => el('div', 'sb-c-hint', 'Edit bundles and skills: open Skill Bundles from Pages in the sidebar');

function busyBadge(at: HTMLElement) {
  const s = el('span', 'sb-c-busy');
  at.appendChild(s);
  mounts.push(mountBadge(s, { label: 'Saving…', tone: 'neutral' }));
}

/** While a save is queued: only the Saving… badge, so the row being clicked isn't replaced. */
export function renderCompactBusy() {
  const left = document.querySelector<HTMLElement>('.sb-c-head .skm-left');
  if (!left || left.querySelector('.sb-c-busy') || !pending()) return;
  busyBadge(left);
}
