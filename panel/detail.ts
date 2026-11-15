// Right-hand pane: the selected skill.
import { mountBanner, mountButton, mountEmpty, mountSelect, mountTabs, mountTextField } from '@openchamber/sdk/ui';
import * as core from '../src/core.js';
import type { Mode } from '../src/core.js';
import { $, el, HAND_EDIT, UNBUNDLED, type Disposable } from './dom';
import { shortDir } from './popup';
import { S, bundlesOf, commit, fmError, homeOpt, meta, mode, orderBundles, saveDescription, skillPath } from './io';

let mounts: Disposable[] = [];
let disposing = false;

function modeTabs(root: HTMLElement, id: string) {
  const items = [
    { id: 'auto', label: 'Automatically' },
    ...(core.isBuiltin(id) ? [] : [{ id: 'called', label: 'When called' }]),
    { id: 'off', label: 'Off' },
  ];
  const broken = fmError(id);
  if (broken) {
    // The kit's tabs have no disabled state, so block them with CSS and ignore changes.
    root.classList.add('sb-disabled');
    root.setAttribute('aria-disabled', 'true');
    root.title = `Manual edit needed: ${broken}`;
  }
  // The active tab follows the saved state; the render after the write moves it.
  return mountTabs(root, { items, activeId: mode(id), onChange: (m) => { if (!broken) commit((s) => core.setOverride(s, id, m as Mode), undefined, { label: 'set mode' }); } });
}

export function renderDetail(selected: string | null) {
  disposing = true;
  mounts.forEach((m) => m.dispose());
  mounts = [];
  const root = $('detail');
  root.textContent = '';
  disposing = false;
  const state = S.state;
  if (!state) return;
  if (!selected || !S.allIds.includes(selected)) {
    mounts.push(mountEmpty(root, { title: 'No skill selected', body: 'Click a skill to edit its description and how agents use it.' }));
    return;
  }
  const id = selected;
  const builtin = core.isBuiltin(id);
  const md = S.skillMds[id];
  const fm = meta(id);

  root.appendChild(el('div', 'sb-d-id', id));
  root.appendChild(el('div', 'sb-d-path', builtin ? 'Built-in skill (no SKILL.md)' : md == null ? `${skillPath(id)} (missing)` : skillPath(id)));
  const broken = fm.error;
  if (broken) {
    const b = el('div');
    root.appendChild(b);
    mounts.push(mountBanner(b, { tone: 'warning', title: 'Manual edit needed', body: `${broken}. Edit SKILL.md by hand; the panel won't change this skill's mode or description.` }));
  }

  root.appendChild(el('div', 'sb-d-label', 'Bundles'));
  const badges = el('div', 'sb-d-badges');
  root.appendChild(badges);
  const mine = bundlesOf(id);
  if (!mine.length) badges.appendChild(el('span', 'sb-empty-pills', 'Unbundled'));
  for (const b of mine) {
    const chip = el('span', 'sb-chip', b.name);
    const x = el('button', '', '×');
    x.title = broken ? HAND_EDIT : `Remove from ${b.name}`;
    x.disabled = !!broken;
    if (!broken) x.addEventListener('click', () => commit((s) => core.moveSkill(s, id, b.id, UNBUNDLED, { copy: false }), undefined, { label: 'remove from bundle' }));
    chip.appendChild(x);
    badges.appendChild(chip);
  }
  const others = orderBundles(state.bundles).filter((b) => !b.skills.includes(id));
  if (others.length) {
    const add = el('span', 'sb-add');
    if (broken) add.title = HAND_EDIT;
    badges.appendChild(add);
    mounts.push(mountSelect(add, {
      value: null, placeholder: '+ bundle', searchable: others.length > 6, disabled: !!broken,
      options: others.map((b) => ({ id: b.id, label: b.name, hint: b.enabled ? 'on' : 'off' })),
      onChange: (to) => commit((s) => core.moveSkill(s, id, mine.length ? mine[0].id : UNBUNDLED, to, { copy: mine.length > 0 }), undefined, { label: 'add to bundle' }),
    }));
  }

  const dirs = core.projectsFor(state, id, homeOpt());
  if (dirs.length) {
    root.appendChild(el('div', 'sb-d-label', 'Projects'));
    const line = el('div', 'sb-d-projects');
    line.title = `On through a bundle in:\n${dirs.join('\n')}`;
    line.textContent = dirs.map((d) => shortDir(d)).join(', ');
    root.appendChild(line);
  }

  if (!builtin && md != null) {
    const d = el('div');
    root.appendChild(d);
    if (S.descDraft && S.descDraft.id !== id) S.descDraft = null;
    let desc = S.descDraft?.value ?? fm.description;
    let saved = fm.description;
    const field = mountTextField(d, {
      label: 'Description', value: desc, multiline: true, rows: 4, disabled: !!broken,
      onChange: (v) => { desc = v; S.descDraft = { id, value: v }; field.update({ value: v }); },
    });
    mounts.push(field);
    d.addEventListener('focusout', () => {
      if (broken || disposing || !d.isConnected || desc === saved) return;
      saved = desc;
      saveDescription(id, desc);
    });
  }

  root.appendChild(el('div', 'sb-d-label', 'Agents use it'));
  const row = el('div', 'sb-mode-row');
  root.appendChild(row);
  const seg = el('span');
  row.appendChild(seg);
  mounts.push(modeTabs(seg, id));
  if (state.overrides[id] != null) {
    const c = el('span');
    row.appendChild(c);
    mounts.push(mountButton(c, { label: 'Clear override', variant: 'ghost', size: 'xs', disabled: !!broken, onClick: () => commit((s) => core.setOverride(s, id, null), undefined, { label: 'clear override' }) }));
    const bundleMode: Mode = mine.some((b) => b.enabled) ? 'auto' : 'off';
    if (bundleMode !== mode(id)) {
      const label = mine.length ? `its bundle${mine.length > 1 ? 's' : ''} (${mine.map((b) => b.name).join(', ')})` : 'being unbundled';
      root.appendChild(el('div', 'sb-note', `Overrides ${label}, which would make it ${bundleMode === 'auto' ? 'automatic' : 'off'}.`));
    }
  }

  if (md != null) {
    root.appendChild(el('div', 'sb-d-label', 'SKILL.md'));
    root.appendChild(el('pre', 'sb-preview', md));
  }
}
