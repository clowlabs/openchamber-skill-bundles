// Rail panel: a compact hot-swap list of bundles.
import { mountBadge, mountBanner, mountSwitch } from '@openchamber/sdk/ui';
import * as core from '../src/core.js';
import type { Bundle } from '../src/core.js';
import { el, isAltClick, isMenuKey, onAltOrContext, openAtAnchor, rovingKey, type Disposable } from './dom';
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
import { countsFromState } from '../status/counts';
import { statsLine } from './stats';

let mounts: Disposable[] = [];
/** Bundle id whose row has keyboard focus, kept across re-renders. */
let focusId: string | null = null;
/** Bundle whose skill list is open; null shows the bundle list. */
let openId: string | null = null;
/** Move focus after the next render (opening or leaving a bundle). */
let moveFocus = false;
/** Document-level Escape handler while a bundle is open. */
let escOff: (() => void) | null = null;

type CompactFocus = {
  hadFocus: boolean;
  onSwitch: boolean;
  onHeader: boolean;
  skillBtn: string | null;
  skillRow: string | null;
};

const skillCount = (n: number) => `${n} skill${n === 1 ? '' : 's'}`;

function isSkillDisabled(id: string): boolean {
  const ov = S.state?.overrides;
  return Boolean(ov && Object.hasOwn(ov, id) && ov[id] === 'off');
}

const disabledCountOf = (b: Bundle): number => b.skills.filter(isSkillDisabled).length;

function describeBundleScope(b: Bundle, projDir: string | null) {
  const on = isBundleOnInScope(b, projDir);
  const projects = b.projects ?? [];
  let inProj = false;
  let otherCount = 0;
  if (projDir != null) {
    for (const d of projects) {
      if (sameProjectDir(d, projDir)) inProj = true;
      else otherCount++;
    }
  } else {
    otherCount = projects.length;
  }
  const excludedHere = projDir != null && (b.excludedProjects ?? []).some((d) => sameProjectDir(d, projDir));
  let rowSuffix: string;
  if (projDir != null) {
    if (b.enabled) rowSuffix = excludedHere && !inProj ? ' · off in this project' : ' · global';
    else if (inProj) rowSuffix = otherCount ? ` · this project +${otherCount}` : ' · this project';
    else if (otherCount > 0) rowSuffix = ` · ${otherCount} other project${otherCount > 1 ? 's' : ''}`;
    else rowSuffix = '';
  } else if (b.enabled) {
    rowSuffix = otherCount ? ` · global · +${otherCount} project${otherCount > 1 ? 's' : ''}` : ' · global';
  } else {
    rowSuffix = otherCount ? ` · +${otherCount} project${otherCount > 1 ? 's' : ''}` : '';
  }
  const openStatus = b.enabled ? (excludedHere && !inProj ? 'off in this project' : 'global') : inProj ? 'this project' : 'off';
  return { on, inProj, excludedHere, otherCount, rowSuffix, openStatus };
}

function captureFocus(root: HTMLElement): CompactFocus {
  const docFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  const activeEl = docFocused ? (document.activeElement as HTMLElement | null) : null;
  const hadFocus = (docFocused && root.contains(activeEl)) || moveFocus;
  const keep = !moveFocus && docFocused;
  const skillBtn = keep ? activeEl?.closest<HTMLElement>('.sb-c-disable-pill')?.dataset.id ?? null : null;
  const skillRow = keep && !skillBtn ? activeEl?.closest<HTMLElement>('.sb-c-skill')?.dataset.id ?? null : null;
  const onSwitch = keep && !!activeEl?.closest('.sb-c-title .sb-c-switch');
  const onHeader = keep && activeEl?.id === 'sb-c-open-title';
  moveFocus = false;
  return { hadFocus, onSwitch, onHeader, skillBtn, skillRow };
}

function restoreBundleFocus(
  focus: CompactFocus,
  els: { list: HTMLElement; header: HTMLElement; sw: HTMLElement; back: HTMLElement },
) {
  if (!focus.hadFocus) return;
  if (focus.skillBtn) els.list.querySelector<HTMLElement>(`.sb-c-disable-pill[data-id="${CSS.escape(focus.skillBtn)}"]`)?.focus();
  else if (focus.skillRow) els.list.querySelector<HTMLElement>(`.sb-c-skill[data-id="${CSS.escape(focus.skillRow)}"]`)?.focus();
  else if (focus.onHeader) els.header.focus();
  else (focus.onSwitch ? els.sw.querySelector<HTMLElement>('button') ?? els.back : els.back).focus();
}

export function renderCompact(root: HTMLElement) {
  const focus = captureFocus(root);
  mounts.forEach((m) => m.dispose());
  mounts = [];
  escOff?.();
  escOff = null;
  root.textContent = '';

  const head = el('div', 'sb-c-head');
  root.appendChild(head);
  const state = S.state;
  if (!S.loaded) return;
  const projDir = activeProjectDir();
  const open = openId ? state?.bundles.find((b) => b.id === openId) : undefined;
  const back = renderHeader(root, head, projDir, Boolean(open));
  if (open && back) return renderBundle(root, open, projDir, focus, back);
  openId = null; // the open bundle was deleted elsewhere

  if (!state) {
    const b = el('div');
    root.appendChild(b);
    mounts.push(mountBanner(b, {
      tone: 'info', title: 'No bundles yet',
      body: 'skill-bundles.json does not exist. Nothing has been changed.',
      action: { label: 'Create from defaults', onClick: seedDefaults },
    }));
    return;
  }

  const list = el('div', 'sb-c-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Bundles. Up/Down to move, Enter to see its skills, Space to turn on or off.');
  root.appendChild(list);
  const rows: HTMLElement[] = [];
  const ids = state.bundles.map((b) => b.id);
  const stop = focusId && ids.includes(focusId) ? focusId : ids[0];

  for (const b of state.bundles) {
    const scope = describeBundleScope(b, projDir);
    const row = el('div', `sb-c-row${scope.on ? ' on' : ''}`);
    row.dataset.id = b.id;
    const disabledCount = disabledCountOf(b);
    const disabledPart = disabledCount > 0 ? ` · ${disabledCount} disabled` : '';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.setAttribute('aria-label', `${b.name}, ${scope.on ? 'on' : 'off'}, ${skillCount(b.skills.length)}${disabledCount > 0 ? `, ${disabledCount} disabled` : ''}${scope.rowSuffix}`);
    row.title = 'Show the skills in this bundle (Alt-click or right-click for projects & global)';
    row.tabIndex = b.id === stop ? 0 : -1;
    const text = el('div', 'sb-c-text');
    const name = el('span', 'sb-c-name');
    const chev = el('span', 'sb-c-chev', '›');
    chev.setAttribute('aria-hidden', 'true');
    name.append(el('span', 'sb-c-name-text', b.name), chev);
    text.appendChild(name);
    const m = el('span', 'sb-c-meta', `${skillCount(b.skills.length)}${disabledPart}`);
    if (scope.rowSuffix) m.appendChild(el('span', 'sb-c-proj', scope.rowSuffix));
    text.appendChild(m);
    row.appendChild(text);
    // The row is the one tab stop (Enter opens, Space toggles); the switch takes pointer clicks
    // only, so it is kept out of the tab order.
    row.appendChild(bundleSwitch(b, false, scope.on));
    onAltOrContext(row, (x, y) => openProjectsMenu(b.id, x, y, row), '.sb-c-switch');
    row.addEventListener('click', (e) => {
      if (isAltClick(e) || (e.target as HTMLElement | null)?.closest('.sb-c-switch')) return;
      openBundle(root, b.id);
    });
    row.addEventListener('focus', () => { focusId = b.id; });
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (rovingKey(e, rows, rows.indexOf(row))) return;
      if (isMenuKey(e, true)) {
        e.preventDefault();
        openAtAnchor(row, (x, y) => openProjectsMenu(b.id, x, y, row));
      } else if ((e.key === 'Enter' || e.key === 'ArrowRight') && !e.altKey) {
        e.preventDefault();
        openBundle(root, b.id);
      } else if (e.key === ' ') {
        e.preventDefault();
        focusId = b.id;
        toggleBundleInScope(b.id);
      }
    });
    rows.push(row);
    list.appendChild(row);
  }
  if (!rows.length) root.appendChild(el('div', 'sb-c-empty', 'No bundles. Create some in the editor.'));
  if (focus.hadFocus) rows.find((r) => r.dataset.id === stop)?.focus();
}

function renderHeader(root: HTMLElement, head: HTMLElement, projDir: string | null, open: boolean) {
  const projCfgPath = projDir ? core.projectConfigPath(projDir) : null;
  const c = countsFromState(S.state, S.allIds, S.opencodeText, {
    projectDir: projDir,
    home: effectiveHome(),
    projectOpencodeText: projCfgPath ? S.projectTexts[projCfgPath] : undefined,
  });
  const header = el('header', 'sb-header');
  const stats = el('div', 'sb-stats');
  stats.appendChild(statsLine(c));
  const back = open ? el('button', 'sb-c-back', 'Go Back') : null;
  if (back) {
    back.type = 'button';
    back.setAttribute('aria-keyshortcuts', 'Escape');
    back.addEventListener('click', () => closeBundle(root));
  }
  header.append(back ?? el('div', 'sb-title', 'Skill Bundles'), stats);
  head.appendChild(header);
  if (pending()) busyBadge(stats);
  return back;
}

/** One bundle's skills, with per-skill Disable pill and Alt/right-click send menu. */
function renderBundle(root: HTMLElement, b: Bundle, projDir: string | null, focus: CompactFocus, back: HTMLElement) {
  const scope = describeBundleScope(b, projDir);
  const title = el('div', 'sb-c-title');
  const text = el('div', 'sb-c-text');
  const h = el('h2', 'sb-c-title-name', b.name);
  h.id = 'sb-c-open-title';
  h.tabIndex = 0;
  h.setAttribute('role', 'button');
  h.setAttribute('aria-haspopup', 'dialog');
  h.title = 'Alt-click, right-click, or press Menu/Alt+Enter for projects & global';
  h.addEventListener('keydown', (e) => {
    if (isMenuKey(e, true)) {
      e.preventDefault();
      openAtAnchor(h, (x, y) => openProjectsMenu(b.id, x, y, h));
    }
  });
  text.appendChild(h);
  const disabledCount = disabledCountOf(b);
  const disabledPart = disabledCount > 0 ? ` · ${disabledCount} disabled` : '';
  const m = el('span', 'sb-c-meta', `${skillCount(b.skills.length)} · ${scope.openStatus}${disabledPart}`);
  if (scope.otherCount > 0) {
    const label = projDir != null
      ? ` · +${scope.otherCount} other project${scope.otherCount > 1 ? 's' : ''}`
      : ` · +${scope.otherCount} project${scope.otherCount > 1 ? 's' : ''}`;
    m.appendChild(el('span', 'sb-c-proj', label));
  }
  text.appendChild(m);
  title.appendChild(text);
  // Here the switch is the only control for the bundle, so it stays in the tab order.
  const sw = bundleSwitch(b, true, scope.on);
  title.appendChild(sw);
  onAltOrContext(title, (x, y) => openProjectsMenu(b.id, x, y, h), '.sb-c-switch');
  root.appendChild(title);

  const list = el('ul', 'sb-c-skills');
  list.setAttribute('aria-labelledby', h.id);
  for (const id of b.skills) {
    const isDisabled = isSkillDisabled(id);
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

    onAltOrContext(li, (x, y, e) => openSendMenu(id, x, y, e.altKey, li, b.id), '.sb-c-disable-pill');
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (isMenuKey(e, true)) {
        e.preventDefault();
        openAtAnchor(li, (x, y) => openSendMenu(id, x, y, e.altKey, li, b.id));
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
  restoreBundleFocus(focus, { list, header: h, sw, back });
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
  const left = document.querySelector<HTMLElement>('.sb-c-head .sb-stats');
  if (!left || left.querySelector('.sb-c-busy') || !pending()) return;
  busyBadge(left);
}
