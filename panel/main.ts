import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountMenu,
  mountSearchField,
  mountSpinner,
  mountSwitch,
  mountTabs,
  mountTextField,
} from '@openchamber/sdk/ui';
import * as core from '../src/core.js';
import type { Group, Mode } from '../src/core.js';
import { closeSendMenu, initSend, openSendMenu, refreshSendMenu } from './send';
import { initPopup, isPopupOpen, setHomeSource } from './popup';
import { openProjectsMenu, refreshProjectsMenu } from './projects';
import { deferRender, endDrag, initDrag, isDragging, onPillDown } from './drag';
import { renderDetail } from './detail';
import { renderCompact, renderCompactBusy } from './compact';
import { countsFromState, formatTokens, liveLine, livePct, TOKENS_TITLE, tokensOf } from '../status/counts';
import { $, el, HAND_EDIT, MODE_LABEL, UNBUNDLED, type Disposable } from './dom';
import { createEditGuard } from './edit-guard';
import {
  S, activeProjectDir, applyChange, bundlesOf, canUndo, checkDisk, commit, effectiveHome, enqueue, errText, fmError, hooks, load, meta, mode, noteCreatedBundle, pending, seedDefaults, setHost, startSync, toastError, undo, undoDepth, undoLabel,
} from './io';
import { connectHost } from '@openchamber/sdk';

const host = connectHost();
setHost(host);
initPopup(host);
setHomeSource(() => effectiveHome());
host.onDirectory((dir) => {
  if (S.activeDir === dir) return;
  S.activeDir = dir;
  if (S.loaded) {
    render();
    const projDir = activeProjectDir();
    if (projDir && !Object.hasOwn(S.projectTexts, core.projectConfigPath(projDir))) {
      void checkDisk().catch(() => {});
    }
  }
});

/** View-only state. */
const V = {
  selected: null as string | null,
  query: '',
  tab: 'bundles' as 'bundles' | 'all',
  renaming: null as string | null,
  renameDraft: '',
  confirmDelete: null as string | null,
  focusedRow: null as string | null,
  refocusRow: false,
};

let groupMounts: Disposable[] = [];
let statMounts: Disposable[] = [];
let bannerMount: Disposable | null = null;

// ---------- selection ----------

/** Move the selection highlight without rebuilding the list, then redraw the detail pane. */
function select(id: string) {
  const prev = V.selected;
  V.selected = id;
  const root = $('groups');
  if (prev != null && prev !== id) {
    for (const n of root.querySelectorAll<HTMLElement>(`[data-id="${CSS.escape(prev)}"]`)) {
      n.classList.remove('sel');
      if (n.hasAttribute('aria-current')) n.setAttribute('aria-current', 'false');
    }
  }
  for (const n of root.querySelectorAll<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)) {
    n.classList.add('sel');
    if (n.hasAttribute('aria-current')) n.setAttribute('aria-current', 'true');
  }
  renderDetail(V.selected);
}

function matches(id: string) {
  if (!V.query) return true;
  const q = V.query.toLowerCase();
  return id.toLowerCase().includes(q) || meta(id).description.toLowerCase().includes(q);
}

// ---------- header ----------

function renderStats() {
  statMounts.forEach((m) => m.dispose());
  statMounts = [];
  const root = $('stats');
  root.textContent = '';
  if (!S.loaded) return;
  const c = countsFromState(S.state, S.allIds, S.opencodeText);
  const n = c.bundlesOn?.length ?? 0;
  const text = S.state
    ? `${c.live} live / ${c.installed} installed (${livePct(c)}%) · ${n} ${n === 1 ? 'bundle' : 'bundles'} on · ~${formatTokens(tokensOf(c.chars))} tokens`
    : `${liveLine(c)} · from opencode.json`;
  const line = el('span', 'sb-stats-line', text);
  line.title = `Live = skills agents can use (allowed in opencode.json). Installed = skill folders plus built-ins.\n${TOKENS_TITLE}`;
  root.appendChild(line);
  if (pending()) {
    const span = el('span');
    root.appendChild(span);
    statMounts.push(mountBadge(span, { label: 'Saving…', tone: 'neutral' }));
  }
}

function renderBanner() {
  bannerMount?.dispose();
  bannerMount = null;
  if (S.loaded && !S.state) {
    bannerMount = mountBanner($('banner'), {
      tone: 'info', title: 'No bundles yet',
      body: 'skill-bundles.json does not exist. Nothing has been changed.',
      action: { label: 'Create from defaults', onClick: seedDefaults },
    });
  }
  const unreach = $('unreachable');
  const n = S.loaded ? S.unreachable.length : 0;
  if (n > 0) {
    unreach.textContent = `${n} skill location${n === 1 ? '' : 's'} couldn't be read, usually a skills folder from opencode.json or a symlink outside the folders this extension may open.${S.incomplete ? ' Until then on/off still works, but "when called", descriptions and sending to a project are blocked.' : ''} Hover for paths.`;
    unreach.title = S.unreachable.map((u) => `${u.path} (${u.code})`).join('\n');
  } else {
    unreach.textContent = '';
    unreach.removeAttribute('title');
  }
}

// ---------- bundles view ----------

function renderPill(id: string, from: string, parent: HTMLElement) {
  const err = fmError(id);
  const p = el('span', `sb-pill ${mode(id)}${id === V.selected ? ' sel' : ''}${err ? ' manual' : ''}`, id);
  p.dataset.id = id;
  p.title = err ? `Manual edit needed: ${err}\n${HAND_EDIT}` : meta(id).description || id;
  p.addEventListener('pointerdown', (e) => { if (S.loaded) onPillDown(e, id, from); });
  p.tabIndex = 0;
  p.setAttribute('role', 'button');
  p.setAttribute('aria-haspopup', 'menu');
  p.setAttribute('aria-label', `${id}, ${MODE_LABEL[mode(id)]}${err ? ', manual edit needed' : ''}`);
  p.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (isDragging()) { endDrag(false); return; }
    openSendMenu(id, e.clientX, e.clientY, e.altKey, p, from);
  });
  p.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(id); }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); menuAt(p, id, e.altKey, from); }
  });
  parent.appendChild(p);
}

function menuAt(anchor: HTMLElement, id: string, alt: boolean, from?: string) {
  const r = anchor.getBoundingClientRect();
  openSendMenu(id, r.left, r.bottom, alt, anchor, from);
}

function sendBlocked(id: string): string | null {
  if (core.isBuiltin(id)) return 'Built-in skill: it has no folder to send.';
  if (S.skillMds[id] == null) return 'This skill has no SKILL.md to send.';
  if (S.incomplete) return "Some skill folders couldn't be read, so this may not be the copy OpenCode uses.";
  const err = fmError(id);
  if (err) return `Manual edit needed (${err}). ${HAND_EDIT}.`;
  return null;
}

function renderGroup(g: Group, root: HTMLElement) {
  const box = el('div', 'sb-group');
  box.dataset.bundle = g.id;
  const head = el('div', 'sb-group-head');
  box.appendChild(head);
  const visible = g.skills.filter(matches);
  const busy = pending() > 0;

  if (V.renaming === g.id) {
    const f = el('div', 'sb-rename');
    head.appendChild(f);
    let name = V.renameDraft;
    const field = mountTextField(f, { value: name, onChange: (v) => { name = v; V.renameDraft = v; field.update({ value: v }); } });
    groupMounts.push(field);
    const done = () => {
      const n = name.trim();
      if (n && n !== g.name) commit((s) => core.renameBundle(s, g.id, n), () => { V.renaming = null; V.renameDraft = ''; }, { label: 'rename bundle' });
      else { V.renaming = null; V.renameDraft = ''; render(); }
    };
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') { V.renaming = null; V.renameDraft = ''; render(); } });
    const b = el('span'); head.appendChild(b);
    groupMounts.push(mountButton(b, { label: 'Save', size: 'xs', onClick: done, loading: busy }));
  } else {
    head.appendChild(el('span', 'sb-group-name', g.name));
    head.appendChild(el('span', 'sb-group-count', V.query ? `${visible.length}/${g.skills.length}` : `${g.skills.length}`));
    if (!g.synthetic) {
      const inc = g.projects ?? [];
      const exc = g.excludedProjects ?? [];
      const total = inc.length + exc.length;
      if (total) {
        const badge = el('span');
        head.appendChild(badge);
        let label: string;
        let tone: 'success' | 'info';
        if (g.enabled && exc.length > 0) {
          label = `On · except ${exc.length} project${exc.length > 1 ? 's' : ''}`;
          tone = 'info';
        } else {
          label = g.enabled
            ? `On · +${inc.length} project${inc.length > 1 ? 's' : ''}`
            : `Off · ${inc.length} project${inc.length > 1 ? 's' : ''}`;
          tone = g.enabled ? 'success' : 'info';
        }
        const tips: string[] = [];
        if (inc.length) tips.push(...inc);
        if (exc.length) tips.push(`Excluded:\n${exc.join('\n')}`);
        badge.title = tips.join('\n');
        groupMounts.push(mountBadge(badge, { label, tone }));
      }
      const pb = el('button', 'sb-proj-btn', 'Projects');
      pb.type = 'button';
      pb.setAttribute('aria-haspopup', 'dialog');
      pb.title = 'Turn this bundle on in specific projects';
      if (total) pb.appendChild(el('span', 'sb-proj-count', String(total)));
      pb.addEventListener('click', () => { const r = pb.getBoundingClientRect(); openProjectsMenu(g.id, r.left, r.bottom, pb); });
      head.appendChild(pb);
      head.addEventListener('click', (e) => {
        if (!e.altKey) return;
        if ((e.target as HTMLElement).closest('button, input, label, .sb-pill, .oc-sdk')) return;
        e.preventDefault();
        openProjectsMenu(g.id, e.clientX, e.clientY, pb);
      });
      head.addEventListener('contextmenu', (e) => {
        if ((e.target as HTMLElement).closest('.sb-pill')) return;
        e.preventDefault();
        openProjectsMenu(g.id, e.clientX, e.clientY, pb);
      });
      const sw = el('span'); head.appendChild(sw);
      groupMounts.push(mountSwitch(sw, { label: '', checked: g.enabled, onChange: (on) => commit((s) => core.setBundleEnabled(s, g.id, on), undefined, { label: 'toggle bundle' }) }));
      const m = el('span'); head.appendChild(m);
      groupMounts.push(mountMenu(m, {
        label: '⋯', variant: 'ghost', size: 'xs',
        items: [{ id: 'rename', label: 'Rename' }, { id: 'delete', label: 'Delete bundle', destructive: true }],
        onSelect: (a) => { if (a === 'rename') { V.renaming = g.id; V.renameDraft = g.name; } else V.confirmDelete = g.id; render(); },
      }));
    }
  }

  if (V.confirmDelete === g.id) {
    const c = el('div', 'sb-confirm', `Delete "${g.name}"? Its skills stay installed.`);
    const a = el('span'), b = el('span');
    c.append(a, b);
    groupMounts.push(mountButton(a, { label: 'Delete', variant: 'destructive', size: 'xs', loading: busy, onClick: () => commit((s) => core.deleteBundle(s, g.id), () => { V.confirmDelete = null; }, { label: 'delete bundle' }) }));
    groupMounts.push(mountButton(b, { label: 'Cancel', variant: 'ghost', size: 'xs', onClick: () => { V.confirmDelete = null; render(); } }));
    box.appendChild(c);
  }

  const pills = el('div', 'sb-pills');
  box.appendChild(pills);
  if (!visible.length) pills.appendChild(el('span', 'sb-empty-pills', V.query && g.skills.length ? 'No matches · drop here' : 'Drop skills here'));
  for (const id of visible) renderPill(id, g.id, pills);
  root.appendChild(box);
}

// ---------- all-skills view ----------

function manualBadge(parent: HTMLElement, id: string) {
  const err = fmError(id);
  if (!err) return;
  const s = el('span', 'sb-manual');
  s.title = err;
  parent.appendChild(s);
  return mountBadge(s, { label: 'manual edit needed', tone: 'warning' });
}

function renderAll(root: HTMLElement) {
  const list = el('div', 'sb-flat');
  root.appendChild(list);
  const ids = S.allIds.filter(matches);
  if (!ids.length) groupMounts.push(mountEmpty(list, { title: 'No skills match' }));
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'All skills. Arrow keys move, A / C / O set the mode, menu key sends to a project.');
  const rows: HTMLElement[] = [];
  // Exactly one tab stop: the focused row, else the selected one, else the first visible.
  const tabStop = [V.focusedRow, V.selected].find((x) => x != null && ids.includes(x)) ?? ids[0];
  for (const id of ids) {
    const m = mode(id);
    const broken = fmError(id);
    const row = el('div', `sb-row${id === V.selected ? ' sel' : ''}`);
    row.dataset.id = id;
    row.tabIndex = id === tabStop ? 0 : -1;
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-haspopup', 'menu');
    row.setAttribute('aria-current', id === V.selected ? 'true' : 'false');
    row.setAttribute('aria-label', `${id}, ${MODE_LABEL[m]}${broken ? ', manual edit needed' : ''}`);
    row.appendChild(el('span', `sb-dot ${m}`));
    row.appendChild(el('span', 'sb-row-id', id));
    const badges = el('span', 'sb-row-badges');
    const mb = manualBadge(badges, id);
    if (mb) groupMounts.push(mb);
    for (const b of bundlesOf(id)) {
      const s = el('span'); badges.appendChild(s);
      groupMounts.push(mountBadge(s, { label: b.name, tone: b.enabled ? 'primary' : 'neutral' }));
    }
    row.appendChild(badges);
    row.appendChild(segmented(id));
    row.addEventListener('click', () => { V.focusedRow = id; select(id); });
    row.addEventListener('focus', () => { V.focusedRow = id; });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); openSendMenu(id, e.clientX, e.clientY, e.altKey, row); });
    row.addEventListener('keydown', (e) => onRowKey(e, id, rows));
    rows.push(row);
    list.appendChild(row);
  }
  if (V.refocusRow) {
    V.refocusRow = false;
    rows.find((r) => r.dataset.id === V.focusedRow)?.focus();
  }
}

const MODE_KEYS: Record<string, Mode> = { a: 'auto', c: 'called', o: 'off' };

function setModeQuick(id: string, m: Mode) {
  if (fmError(id) || (m === 'called' && core.isBuiltin(id)) || mode(id) === m) return;
  commit((s) => core.setOverride(s, id, m), undefined, { label: 'set mode' });
}

function onRowKey(e: KeyboardEvent, id: string, rows: HTMLElement[]) {
  if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey) return;
  const i = rows.findIndex((r) => r.dataset.id === id);
  const go = (n: number) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, n))];
    if (!r) return;
    rows.forEach((x) => (x.tabIndex = -1));
    r.tabIndex = 0;
    r.focus();
  };
  const k = e.key.toLowerCase();
  if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1); }
  else if (e.key === 'Home') { e.preventDefault(); go(0); }
  else if (e.key === 'End') { e.preventDefault(); go(rows.length - 1); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(id); }
  else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); menuAt(e.currentTarget as HTMLElement, id, e.altKey); }
  else if (!e.altKey && k in MODE_KEYS) { e.preventDefault(); V.refocusRow = true; setModeQuick(id, MODE_KEYS[k]); }
}

/** Compact one-click Auto / Called / Off control for list rows. */
function segmented(id: string) {
  const broken = fmError(id);
  const cur = mode(id);
  const g = el('span', `sb-seg${broken ? ' sb-disabled' : ''}`);
  g.setAttribute('role', 'radiogroup');
  g.setAttribute('aria-label', `How agents use ${id}`);
  if (broken) { g.setAttribute('aria-disabled', 'true'); g.title = `Manual edit needed: ${broken}`; }
  const opts: [Mode, string, string][] = [['auto', 'Auto', 'A'], ['called', 'Called', 'C'], ['off', 'Off', 'O']];
  for (const [m, label, key] of opts) {
    if (m === 'called' && core.isBuiltin(id)) continue;
    const b = el('button', `sb-seg-btn ${m}${m === cur ? ' on' : ''}`, label);
    b.type = 'button';
    b.tabIndex = -1; // the row is the tab stop; A / C / O are the keyboard path
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', m === cur ? 'true' : 'false');
    b.title = `${MODE_LABEL[m]} (${key})`;
    b.disabled = !!broken;
    b.addEventListener('click', (e) => { e.stopPropagation(); V.focusedRow = id; V.refocusRow = true; setModeQuick(id, m); });
    g.appendChild(b);
  }
  return g;
}

// ---------- render ----------

function renderGroups() {
  groupMounts.forEach((m) => m.dispose());
  groupMounts = [];
  const root = $('groups');
  if (!S.loaded) return; // keep the loading spinner
  root.textContent = '';
  $('new-bundle').style.display = V.tab === 'bundles' && S.state ? '' : 'none';
  if (!S.state) return;
  if (V.tab === 'all') return renderAll(root);
  for (const g of core.groups(S.state, S.allIds)) renderGroup(g, root);
}

/** Stats and button state only: safe while a click is in flight. */
function renderLight() {
  if (compact) { renderCompactBusy(); return; }
  renderStats();
  newField?.update({ disabled: !S.loaded });
  newButton?.update({ disabled: !S.loaded, loading: pending() > 0 });
  const undoable = canUndo();
  undoButton?.update({ disabled: !undoable || pending() > 0 });
  const undoText = undoable ? `Undo ${undoLabel() ?? 'last change'} (Ctrl/Cmd+Z)` : 'Nothing to undo';
  if (undoSpan) {
    undoSpan.title = undoText;
    undoSpan.querySelector('button')?.setAttribute('aria-label', undoText);
  }
  if (resetConfirmWrap) resetConfirmWrap.hidden = !skipUndoConfirm;
  resetConfirmBtn?.update({ disabled: pending() > 0 });
  if (undoConfirmSnapshot) {
    if (!undoable || undoDepth() !== undoConfirmSnapshot.depth || undoLabel() !== undoConfirmSnapshot.label) {
      closeUndoConfirm();
    } else {
      undoConfirmBtn?.update({ disabled: pending() > 0 });
    }
  }
}

/** Rail panel = compact hot-swap list; page and everything else = full editor. */
let compact = false;

function render() {
  if (compact) {
    renderCompact($('compact'));
    refreshProjectsMenu();
    refreshSendMenu();
    return;
  }
  if (isDragging()) { deferRender(); renderLight(); return; }
  editGuard.markRendered();
  const bundles = S.state?.bundles;
  if (V.renaming && !bundles?.some((b) => b.id === V.renaming)) { V.renaming = null; V.renameDraft = ''; }
  if (V.confirmDelete && !bundles?.some((b) => b.id === V.confirmDelete)) V.confirmDelete = null;
  renderBanner();
  renderGroups();
  renderDetail(V.selected);
  renderLight();
  refreshProjectsMenu();
  refreshSendMenu();
}

function isEditingPageControl(): boolean {
  if (compact) return false;
  const docFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  if (!docFocused) return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  const inRename = Boolean(V.renaming && active.closest?.('.sb-rename') && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'));
  const inDesc = Boolean(active.closest?.('#detail') && active.tagName === 'TEXTAREA');
  return inRename || inDesc;
}

const editGuard = createEditGuard({
  isEditing: isEditingPageControl,
  isTargetDeleted: () => {
    const bundles = S.state?.bundles;
    const renamingDeleted = Boolean(V.renaming && !bundles?.some((b) => b.id === V.renaming));
    const selectedDeleted = Boolean(V.selected && !S.allIds.includes(V.selected));
    return renamingDeleted || selectedDeleted;
  },
  onDefer: () => {
    renderLight();
    refreshProjectsMenu();
    refreshSendMenu();
  },
  onRender: render,
});

hooks.render = render;
hooks.renderLight = renderLight;
hooks.onExternalSync = () => {
  if (compact) {
    renderCompact($('compact'));
    refreshProjectsMenu();
    refreshSendMenu();
  } else {
    editGuard.onExternalSync();
  }
};

initDrag({
  canDrag: (id) => !fmError(id),
  onDrop: (id, from, to, altKey) => {
    const copy = altKey && to !== UNBUNDLED;
    commit((s) => core.moveSkill(s, id, from, to, { copy }), undefined, { label: copy ? 'duplicate skill' : 'move skill' });
  },
  onClick: select,
  onEnd: render,
});

// ---------- undo ----------

const SKIP_UNDO_CONFIRM_KEY = 'skill-bundles.skipUndoConfirm';
let skipUndoConfirm = false;
let storageOpts: { scope: 'device' } | undefined;

function setSkipUndoConfirm(v: boolean) {
  skipUndoConfirm = v;
  if (v) {
    void host.storage.set(SKIP_UNDO_CONFIRM_KEY, true, storageOpts).catch(() => {});
  } else {
    void host.storage.delete(SKIP_UNDO_CONFIRM_KEY, storageOpts).catch(() => {});
  }
}

let undoConfirmMounts: Disposable[] = [];
let undoConfirmBtn: ReturnType<typeof mountButton> | null = null;
let undoConfirmSnapshot: { depth: number; label: string | null } | null = null;

function closeUndoConfirm(restoreFocus = false) {
  const bar = $('undo-confirm');
  const hadFocus = bar.contains(document.activeElement);
  undoConfirmMounts.forEach((m) => m.dispose());
  undoConfirmMounts = [];
  undoConfirmBtn = null;
  undoConfirmSnapshot = null;
  bar.textContent = '';
  bar.hidden = true;
  if (restoreFocus && hadFocus) {
    const btn = undoSpan?.querySelector('button') as HTMLButtonElement | null;
    if (btn && !btn.disabled) btn.focus();
  }
}

function requestUndo() {
  if (!canUndo() || pending() > 0) return;
  if (skipUndoConfirm) {
    closeUndoConfirm();
    void undo();
    return;
  }
  closeUndoConfirm();
  const label = undoLabel();
  undoConfirmSnapshot = { depth: undoDepth(), label };
  const bar = $('undo-confirm');
  bar.setAttribute('role', 'alertdialog');
  bar.setAttribute('aria-label', 'Confirm undo');
  bar.hidden = false;
  bar.appendChild(el('span', 'sb-undo-msg', `Undo ${label ?? 'last change'}?`));

  const remember = el('label', 'sb-undo-remember');
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  remember.append(chk, document.createTextNode("Don't ask again"));
  bar.appendChild(remember);

  const actions = el('span', 'sb-undo-actions');
  const yes = el('span');
  const no = el('span');
  actions.append(yes, no);
  bar.appendChild(actions);

  undoConfirmBtn = mountButton(yes, {
    label: 'Undo',
    variant: 'default',
    size: 'xs',
    disabled: pending() > 0,
    onClick: () => {
      if (chk.checked) setSkipUndoConfirm(true);
      closeUndoConfirm(true);
      void undo();
    },
  });
  undoConfirmMounts.push(
    undoConfirmBtn,
    mountButton(no, {
      label: 'Cancel',
      variant: 'ghost',
      size: 'xs',
      onClick: () => closeUndoConfirm(true),
    }),
  );
  (yes.querySelector('button') as HTMLButtonElement | null)?.focus();
}

// ---------- boot ----------

let tabsHandle: ReturnType<typeof mountTabs> | null = null;
let newField: ReturnType<typeof mountTextField> | null = null;
let newButton: ReturnType<typeof mountButton> | null = null;
let undoButton: ReturnType<typeof mountButton> | null = null;
let resetConfirmBtn: ReturnType<typeof mountButton> | null = null;
let undoSpan: HTMLElement | null = null;
let resetConfirmWrap: HTMLElement | null = null;
let mounted = false;

function mountChrome() {
  tabsHandle = mountTabs($('tabs'), {
    items: [{ id: 'bundles', label: 'Bundles' }, { id: 'all', label: 'All skills' }],
    activeId: V.tab,
    onChange: (id) => { closeSendMenu(); V.tab = id as typeof V.tab; tabsHandle!.update({ activeId: id }); render(); },
  });
  const undoWrap = $('undo-wrap');
  undoSpan = el('span');
  resetConfirmWrap = el('span');
  const resetLabel = 'Undo confirmation is off. Click to ask before undoing.';
  resetConfirmWrap.title = resetLabel;
  resetConfirmWrap.hidden = !skipUndoConfirm;
  undoWrap.append(undoSpan, resetConfirmWrap);
  undoButton = mountButton(undoSpan, { label: 'Undo', variant: 'secondary', size: 'xs', disabled: true, onClick: requestUndo });
  undoSpan.querySelector('button')?.setAttribute('aria-keyshortcuts', 'Control+Z Meta+Z');
  const undoConfirmBar = $('undo-confirm');
  undoConfirmBar.addEventListener('keydown', (e) => {
    if (!undoConfirmBar.hidden && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeUndoConfirm(true);
    }
  });
  resetConfirmBtn = mountButton(resetConfirmWrap, {
    label: 'Ask',
    variant: 'ghost',
    size: 'xs',
    onClick: () => {
      setSkipUndoConfirm(false);
      renderLight();
    },
  });
  resetConfirmWrap.querySelector('button')?.setAttribute('aria-label', resetLabel);

  const search = mountSearchField($('search'), {
    value: '', placeholder: 'Search skills',
    onChange: (v) => { V.query = v.trim(); search.update({ value: v }); renderGroups(); },
  });
  const nb = $('new-bundle');
  const f = el('div'), b = el('div');
  nb.append(f, b);
  let name = '';
  newField = mountTextField(f, { value: '', placeholder: 'New bundle name', disabled: true, onChange: (v) => { name = v; newField!.update({ value: v }); } });
  const create = () => {
    const n = name.trim();
    if (!n || !S.loaded) return;
    commit((s) => {
      const next = core.createBundle(s, n);
      const created = next.bundles.at(-1);
      if (created) noteCreatedBundle(created.id);
      return next;
    }, () => {
      if (name.trim() === n) { name = ''; newField?.update({ value: '' }); }
    }, { label: 'create bundle' });
  };
  f.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  newButton = mountButton(b, { label: 'New bundle', variant: 'secondary', disabled: true, onClick: create });

  document.addEventListener('keydown', (e) => {
    if (compact) return;
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() !== 'z') return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable || target.closest('[contenteditable]'))) return;
    if (isPopupOpen() || isDragging() || !canUndo() || pending() > 0) return;
    e.preventDefault();
    requestUndo();
  });
}

async function boot() {
  const spin = el('div');
  (compact ? $('compact') : $('groups')).appendChild(spin);
  const s = mountSpinner(spin, { label: 'Loading skills…' });
  try {
    await load();
  } catch (e) {
    s.dispose();
    // On the rail the editor (#app, which holds #banner) is hidden: mount where it shows.
    const at = compact ? $('compact') : $('banner');
    if (compact) at.textContent = '';
    mountBanner(at, { tone: 'error', title: 'Could not load skills', body: errText(e) });
    return;
  }
  s.dispose();
  render();
  startSync();
}

initSend({
  host,
  blockedReason: (id) => (S.loaded && S.state ? sendBlocked(id) : 'Still loading.'),
  skillRef: (id) => S.skillRefs[id],
  enqueue,
  // Already inside the queue (copySkill runs there), so apply directly instead of commit().
  markMoved: (id, dir) => applyChange((s) => core.markMovedToProject(s, id, dir), { undoable: 'clear' }),
  toastError,
});

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  storageOpts = ctx.features?.deviceStorage ? { scope: 'device' as const } : undefined;
  if (mounted) return;
  mounted = true;
  compact = ctx.surface === 'panel';
  document.body.classList.toggle('sb-compact', compact);
  if (!compact) {
    mountChrome();
    void host.storage.get(SKIP_UNDO_CONFIRM_KEY, storageOpts)
      .then((val) => {
        skipUndoConfirm = val === true;
        renderLight();
      })
      .catch(() => {});
  }
  void boot();
});
