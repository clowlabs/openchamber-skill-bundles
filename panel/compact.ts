// Rail panel: a compact hot-swap list of bundles.
import { mountBadge, mountBanner, mountSwitch } from '@openchamber/sdk/ui';
import * as core from '../src/core.js';
import type { Bundle } from '../src/core.js';
import { el, type Disposable } from './dom';
import {
  S,
  activeProjectDir,
  commit,
  effectiveHome,
  isBundleOnInScope,
  meta,
  pending,
  sameProjectDir,
  seedDefaults,
  toggleBundleInScope,
} from './io';
import { openProjectsMenu } from './projects';
import { openSendMenu } from './send';
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

function disabledCountOf(b: Bundle): number {
  const ov = S.state?.overrides;
  if (!ov) return 0;
  return b.skills.filter((id) => Object.hasOwn(ov, id) && ov[id] === 'off').length;
}

function rowScopeSuffix(b: Bundle, projDir: string | null): string {
  if (projDir != null) {
    const inProj = (b.projects ?? []).some((d) => sameProjectDir(d, projDir));
    const excludedHere = (b.excludedProjects ?? []).some((d) => sameProjectDir(d, projDir));
    const otherCount = (b.projects ?? []).filter((d) => !sameProjectDir(d, projDir)).length;
    if (b.enabled) return excludedHere && !inProj ? ' · off in this project' : ' · global';
    if (inProj) return otherCount ? ` · this project +${otherCount}` : ' · this project';
    if (otherCount > 0) return ` · ${otherCount} other project${otherCount > 1 ? 's' : ''}`;
    return '';
  }
  const n = b.projects?.length ?? 0;
  if (b.enabled) return n ? ` · global · +${n} project${n > 1 ? 's' : ''}` : ' · global';
  return n ? ` · +${n} project${n > 1 ? 's' : ''}` : '';
}

export function renderCompact(root: HTMLElement) {
  const docFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  const activeEl = docFocused ? (document.activeElement as HTMLElement | null) : null;
  const hadFocus = (docFocused && root.contains(activeEl)) || moveFocus;
  const onSwitch = !moveFocus && docFocused && !!activeEl?.closest('.sb-c-title .sb-c-switch');
  const onHeader = !moveFocus && docFocused && activeEl?.id === 'sb-c-open-title';
  const activeSkillBtn = !moveFocus && docFocused ? activeEl?.closest<HTMLElement>('.sb-c-disable-pill')?.dataset.id ?? null : null;
  const activeSkillRow = !moveFocus && docFocused && !activeSkillBtn ? activeEl?.closest<HTMLElement>('.sb-c-skill')?.dataset.id ?? null : null;
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
    return;
  }

  const projDir = activeProjectDir();
  const open = openId ? state.bundles.find((b) => b.id === openId) : undefined;
  if (open) return renderBundle(root, head, open, projDir, hadFocus, onSwitch, onHeader, activeSkillBtn, activeSkillRow);
  openId = null; // the open bundle was deleted elsewhere

  const projCfgPath = projDir ? core.projectConfigPath(projDir) : null;
  const projectOpencodeText = projCfgPath ? S.projectTexts[projCfgPath] : undefined;
  const c = countsFromState(state, S.allIds, S.opencodeText, {
    projectDir: projDir,
    home: effectiveHome(),
    projectOpencodeText,
  });
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
    const on = isBundleOnInScope(b, projDir);
    const row = el('div', `sb-c-row${on ? ' on' : ''}`);
    row.dataset.id = b.id;
    const disabledCount = disabledCountOf(b);
    const disabledPart = disabledCount > 0 ? ` · ${disabledCount} disabled` : '';
    const proj = rowScopeSuffix(b, projDir);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.setAttribute('aria-label', `${b.name}, ${on ? 'on' : 'off'}, ${skillCount(b.skills.length)}${disabledCount > 0 ? `, ${disabledCount} disabled` : ''}${proj}`);
    row.title = 'Show the skills in this bundle (Alt-click or right-click for projects & global)';
    row.tabIndex = b.id === stop ? 0 : -1;
    const text = el('div', 'sb-c-text');
    const name = el('span', 'sb-c-name');
    const chev = el('span', 'sb-c-chev', '›');
    chev.setAttribute('aria-hidden', 'true');
    name.append(el('span', 'sb-c-name-text', b.name), chev);
    text.appendChild(name);
    const m = el('span', 'sb-c-meta', `${skillCount(b.skills.length)}${disabledPart}`);
    if (proj) m.appendChild(el('span', 'sb-c-proj', proj));
    text.appendChild(m);
    row.appendChild(text);
    // The row is the one tab stop (Enter opens, Space toggles); the switch takes pointer clicks
    // only, so it is kept out of the tab order.
    row.appendChild(bundleSwitch(b, false, on));
    row.addEventListener('click', (e) => {
      if (e.altKey) {
        e.preventDefault();
        openProjectsMenu(b.id, e.clientX, e.clientY, row);
        return;
      }
      openBundle(root, b.id);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openProjectsMenu(b.id, e.clientX, e.clientY, row);
    });
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
      else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') || (e.altKey && e.key === 'Enter')) {
        e.preventDefault();
        const r = row.getBoundingClientRect();
        openProjectsMenu(b.id, r.left, r.bottom, row);
      }
      else if ((e.key === 'Enter' || e.key === 'ArrowRight') && !e.altKey) { e.preventDefault(); openBundle(root, b.id); }
      else if (e.key === ' ') { e.preventDefault(); focusId = b.id; toggleBundleInScope(b.id); }
    });
    rows.push(row);
    list.appendChild(row);
  }
  if (!rows.length) root.appendChild(el('div', 'sb-c-empty', 'No bundles. Create some in the editor.'));
  if (hadFocus) rows.find((r) => r.dataset.id === stop)?.focus();
}

/** One bundle's skills, with per-skill Disable pill and Alt/right-click send menu. */
function renderBundle(
  root: HTMLElement,
  head: HTMLElement,
  b: Bundle,
  projDir: string | null,
  hadFocus: boolean,
  onSwitch: boolean,
  onHeader: boolean,
  activeSkillBtn: string | null,
  activeSkillRow: string | null,
) {
  const bar = el('div', 'sb-c-back-bar');
  const back = el('button', 'sb-c-back', '‹ All bundles');
  back.type = 'button';
  back.setAttribute('aria-keyshortcuts', 'Escape');
  back.addEventListener('click', () => closeBundle(root));
  bar.appendChild(back);
  head.appendChild(bar);
  if (pending()) busyBadge(bar);

  const on = isBundleOnInScope(b, projDir);
  const title = el('div', 'sb-c-title');
  const text = el('div', 'sb-c-text');
  const h = el('h2', 'sb-c-title-name', b.name);
  h.id = 'sb-c-open-title';
  h.tabIndex = 0;
  h.setAttribute('role', 'button');
  h.setAttribute('aria-haspopup', 'dialog');
  h.title = 'Alt-click, right-click, or press Menu/Alt+Enter for projects & global';
  h.addEventListener('keydown', (e) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') || (e.altKey && e.key === 'Enter')) {
      e.preventDefault();
      const r = h.getBoundingClientRect();
      openProjectsMenu(b.id, r.left, r.bottom, h);
    }
  });
  text.appendChild(h);
  const disabledCount = disabledCountOf(b);
  const disabledPart = disabledCount > 0 ? ` · ${disabledCount} disabled` : '';
  const inProj = projDir != null && (b.projects ?? []).some((d) => sameProjectDir(d, projDir));
  const excludedHere = projDir != null && (b.excludedProjects ?? []).some((d) => sameProjectDir(d, projDir));
  const status = b.enabled ? (excludedHere && !inProj ? 'off in this project' : 'global') : inProj ? 'this project' : 'off';
  const otherCount = projDir != null
    ? (b.projects ?? []).filter((d) => !sameProjectDir(d, projDir)).length
    : (b.projects?.length ?? 0);
  const m = el('span', 'sb-c-meta', `${skillCount(b.skills.length)} · ${status}${disabledPart}`);
  if (otherCount > 0) {
    const label = projDir != null
      ? ` · +${otherCount} other project${otherCount > 1 ? 's' : ''}`
      : ` · +${otherCount} project${otherCount > 1 ? 's' : ''}`;
    m.appendChild(el('span', 'sb-c-proj', label));
  }
  text.appendChild(m);
  title.appendChild(text);
  // Here the switch is the only control for the bundle, so it stays in the tab order.
  const sw = bundleSwitch(b, true, on);
  title.appendChild(sw);
  title.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.sb-c-switch')) return;
    if (e.altKey) {
      e.preventDefault();
      openProjectsMenu(b.id, e.clientX, e.clientY, h);
    }
  });
  title.addEventListener('contextmenu', (e) => {
    if ((e.target as HTMLElement).closest('.sb-c-switch')) return;
    e.preventDefault();
    openProjectsMenu(b.id, e.clientX, e.clientY, h);
  });
  root.appendChild(title);

  const list = el('ul', 'sb-c-skills');
  list.setAttribute('aria-labelledby', h.id);
  for (const id of b.skills) {
    const isDisabled = Boolean(S.state && Object.hasOwn(S.state.overrides, id) && S.state.overrides[id] === 'off');
    const li = el('li', `sb-c-skill${isDisabled ? ' is-disabled' : ''}`);
    li.dataset.id = id;
    li.tabIndex = 0;

    const main = el('div', 'sb-c-skill-main');
    main.appendChild(el('span', 'sb-c-skill-id', id));
    const d = meta(id).description;
    if (d) main.appendChild(el('span', 'sb-c-skill-desc', d));
    li.appendChild(main);

    const pill = el('button', `sb-c-disable-pill${isDisabled ? ' is-disabled' : ''}`, isDisabled ? 'Disabled' : 'Disable');
    pill.type = 'button';
    pill.dataset.id = id;
    pill.setAttribute('aria-pressed', isDisabled ? 'true' : 'false');
    pill.setAttribute('aria-label', isDisabled ? `Re-enable ${id}` : `Disable ${id}`);
    pill.title = isDisabled ? `Re-enable ${id} (clear off override)` : `Disable ${id} everywhere`;
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      commit(
        (s) => core.setOverride(s, id, isDisabled ? null : 'off'),
        undefined,
        { label: isDisabled ? 'enable skill' : 'disable skill' },
      );
    });
    pill.addEventListener('mousedown', (e) => e.stopPropagation());
    pill.addEventListener('pointerdown', (e) => e.stopPropagation());
    pill.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    li.appendChild(pill);

    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.sb-c-disable-pill')) return;
      if (e.altKey) {
        e.preventDefault();
        openSendMenu(id, e.clientX, e.clientY, true, li, b.id);
      }
    });
    li.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.sb-c-disable-pill')) return;
      e.preventDefault();
      openSendMenu(id, e.clientX, e.clientY, e.altKey, li, b.id);
    });
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') || (e.altKey && e.key === 'Enter')) {
        e.preventDefault();
        const r = li.getBoundingClientRect();
        openSendMenu(id, r.left, r.bottom, e.altKey, li, b.id);
      }
    });

    list.appendChild(li);
  }
  if (!b.skills.length) list.appendChild(el('li', 'sb-c-empty', 'No skills in this bundle yet.'));
  root.appendChild(list);

  // On the document, so Escape still works after a click on plain text moves focus to body.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeBundle(root); }
  };
  document.addEventListener('keydown', onKey);
  escOff = () => document.removeEventListener('keydown', onKey);
  if (hadFocus) {
    if (activeSkillBtn) list.querySelector<HTMLElement>(`.sb-c-disable-pill[data-id="${CSS.escape(activeSkillBtn)}"]`)?.focus();
    else if (activeSkillRow) list.querySelector<HTMLElement>(`.sb-c-skill[data-id="${CSS.escape(activeSkillRow)}"]`)?.focus();
    else if (onHeader) h.focus();
    else (onSwitch ? sw.querySelector<HTMLElement>('button') ?? back : back).focus();
  }
}

function bundleSwitch(b: Bundle, focusable: boolean, checked: boolean) {
  const sw = el('span', 'sb-c-switch');
  sw.addEventListener('click', (e) => e.stopPropagation());
  sw.addEventListener('pointerdown', (e) => e.stopPropagation());
  sw.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
  sw.title = checked ? 'Turn this bundle off' : 'Turn this bundle on';
  mounts.push(mountSwitch(sw, {
    label: '',
    checked,
    onChange: (on) => { focusId = b.id; toggleBundleInScope(b.id, on); },
  }));
  const btn = sw.querySelector<HTMLElement>('button');
  if (focusable) {
    btn?.setAttribute('aria-labelledby', 'sb-c-open-title');
    sw.addEventListener('mousedown', (e) => e.stopPropagation());
  } else {
    for (const f of sw.querySelectorAll<HTMLElement>('button, input, [tabindex]')) {
      f.tabIndex = -1;
      f.setAttribute('aria-hidden', 'true');
    }
    // A click must not park focus on the hidden button: keep it on the row.
    sw.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
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
