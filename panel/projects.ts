// Bundle "Projects" checklist: which project folders a bundle is turned on in.
import * as core from '../src/core.js';
import { button, createPopup, note, projectList, projectsNote, replace, shortDir, watchProjects, type Project } from './popup';
import { S, activeProjectDir, commit, errText, homeOpt, host } from './io';

const sameDir = (a: string, b: string) => {
  try { return core.normalizeProjectDir(a, homeOpt()) === core.normalizeProjectDir(b, homeOpt()); } catch { return a === b; }
};

/** Validate an "Add folder…" entry the way the CLI does: absolute or ~/, not ~ itself, an existing directory. */
async function validateFolder(raw: string): Promise<string> {
  const text = raw.trim();
  if (!text) throw new Error('Enter a folder path');
  if (!text.startsWith('/') && !text.startsWith('~/') && text !== '~') throw new Error('Use an absolute path or one starting with ~/');
  const dir = core.normalizeProjectDir(text, homeOpt());
  if (dir === '~' || dir === '/') throw new Error('Pick a project folder, not your home or the root folder');
  let kind: string;
  try {
    kind = (await host.stat(dir)).kind;
  } catch (e) {
    throw new Error(`Can't check that folder (${errText(e)})`);
  }
  if (kind === 'missing') throw new Error('That folder does not exist');
  if (kind !== 'directory') throw new Error('That path is not a folder');
  return dir;
}

export function openProjectsMenu(bundleId: string, x: number, y: number, returnFocus?: HTMLElement | null) {
  const bundle = () => S.state?.bundles.find((b) => b.id === bundleId);
  if (!bundle()) return;
  let filter = '';
  let unwatch = () => {};
  const pop = createPopup({
    role: 'dialog',
    className: 'sb-proj',
    itemSelector: 'input.sb-proj-check',
    returnFocus,
    onClose: () => { unwatch(); if (repaintOpen === paint) repaintOpen = null; },
  });
  const { menu, title, list, foot } = pop;
  menu.setAttribute('aria-modal', 'false');

  // "Add folder…" lives in the footer so re-painting the list keeps its draft.
  const add = document.createElement('form');
  add.className = 'sb-proj-add';
  const input = document.createElement('input');
  input.className = 'sb-ctx-filter sb-proj-path';
  input.placeholder = 'Add folder… (/path or ~/path)';
  input.setAttribute('aria-label', 'Add a project folder by path');
  input.spellcheck = false;
  const addBtn = button('Add', 'sb-ctx-btn');
  addBtn.type = 'submit';
  const err = document.createElement('div');
  err.className = 'sb-proj-err';
  err.setAttribute('role', 'alert');
  add.append(input, addBtn);
  foot.append(add, err);
  const showErr = (msg: string) => {
    err.textContent = msg;
    input.title = msg;
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    replace(menu);
  };
  input.addEventListener('input', () => { if (err.textContent) showErr(''); });
  add.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      let dir: string;
      try {
        dir = await validateFolder(input.value);
      } catch (x) {
        showErr(errText(x));
        return;
      }
      if (bundle()?.projects?.some((d) => sameDir(d, dir))) { showErr('Already in this bundle'); return; }
      showErr('');
      commit((s) => core.addBundleProject(s, bundleId, dir, homeOpt()), () => { input.value = ''; }, { label: 'add project' });
    })();
  });

  const toggle = (dir: string, on: boolean) => {
    commit((s) => {
      const cur = s.bundles.find((x) => x.id === bundleId);
      if (!cur) return s;
      if (cur.enabled) {
        return on
          ? core.includeBundleProject(s, bundleId, dir, homeOpt())
          : core.excludeBundleProject(s, bundleId, dir, homeOpt());
      }
      return on
        ? core.addBundleProject(s, bundleId, dir, homeOpt())
        : core.removeBundleProject(s, bundleId, dir, homeOpt());
    }, undefined, { label: on ? 'add project' : 'remove project' });
  };

  const row = (label: string, dir: string, checked: boolean, extra?: string, onChange?: (checked: boolean) => void) => {
    const l = document.createElement('label');
    l.className = 'sb-proj-row';
    l.title = dir === '__global' ? 'Turn on in every project' : dir;
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.className = 'sb-proj-check';
    c.checked = checked;
    c.dataset.dir = dir;
    c.addEventListener('change', () => (onChange ? onChange(c.checked) : toggle(dir, c.checked)));
    const name = document.createElement('span');
    name.className = 'sb-ctx-name';
    name.textContent = label;
    const d = document.createElement('span');
    d.className = 'sb-ctx-dir';
    d.textContent = extra ?? shortDir(dir);
    l.append(c, name, d);
    return l;
  };

  const paint = () => {
    const b = bundle();
    if (!b) { pop.close(); return; }
    const keep = (document.activeElement as HTMLElement | null)?.dataset?.dir;
    title.textContent = `${b.name}: turn on in projects`;
    menu.setAttribute('aria-label', title.textContent);
    list.textContent = '';
    const mine = b.projects ?? [];
    const excluded = b.excludedProjects ?? [];
    pop.ensureFilter(projectList().projects.length + mine.length + excluded.length, 'Filter projects', (v) => { filter = v; paint(); });

    list.appendChild(row('Global (all projects)', '__global', b.enabled, 'every project', (checked) => {
      commit((s) => core.setBundleGlobal(s, bundleId, checked), undefined, {
        label: checked ? 'enable bundle globally' : 'disable bundle globally',
      });
    }));

    const curDir = activeProjectDir();
    const knownRaw: Project[] = core.filterProjects(projectList().projects, filter);
    const known = curDir
      ? [...knownRaw.filter((p) => sameDir(p.directory, curDir)), ...knownRaw.filter((p) => !sameDir(p.directory, curDir))]
      : knownRaw;
    const status = projectsNote(known.length, filter);
    const q = filter.trim().toLowerCase();
    const unlistedMine = mine.filter((d) => !projectList().projects.some((p) => sameDir(p.directory, d)) && (!q || d.toLowerCase().includes(q)));
    const unlistedExcluded = b.enabled
      ? excluded.filter((d) => !mine.some((m) => sameDir(m, d)) && !projectList().projects.some((p) => sameDir(p.directory, d)) && (!q || d.toLowerCase().includes(q)))
      : [];

    if (known.length || unlistedMine.length || unlistedExcluded.length || status) {
      const h = document.createElement('div');
      h.className = 'sb-ctx-title';
      h.textContent = 'Projects';
      list.appendChild(h);
    }
    if (status) list.appendChild(note(status));
    for (const p of known) {
      const isCur = curDir != null && sameDir(p.directory, curDir);
      const checked = b.enabled
        ? !excluded.some((d) => sameDir(d, p.directory)) || mine.some((d) => sameDir(d, p.directory))
        : mine.some((d) => sameDir(d, p.directory));
      list.appendChild(row(p.name, p.directory, checked, isCur ? `current · ${shortDir(p.directory)}` : undefined));
    }

    // Folders in the bundle that OpenChamber doesn't list, so they can be unchecked.
    if (unlistedMine.length || unlistedExcluded.length) {
      const h = document.createElement('div');
      h.className = 'sb-ctx-title';
      h.textContent = 'Other folders';
      list.appendChild(h);
      for (const d of unlistedMine) list.appendChild(row(d.split('/').filter(Boolean).pop() ?? d, d, true));
      for (const d of unlistedExcluded) list.appendChild(row(d.split('/').filter(Boolean).pop() ?? d, d, false));
    }
    if (keep) list.querySelector<HTMLElement>(`[data-dir="${CSS.escape(keep)}"]`)?.focus();
  };

  unwatch = watchProjects(paint);
  // Saves re-render the page; repaint the checklist from the saved state too.
  repaintOpen = paint;
  paint();
  pop.show(x, y);
}

let repaintOpen: (() => void) | null = null;
/** Called after every render so an open checklist reflects the saved state. */
export function refreshProjectsMenu() {
  repaintOpen?.();
}
