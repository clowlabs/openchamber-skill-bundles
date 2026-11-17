// Bundle "Projects" checklist: which project folders a bundle is turned on in.
import * as core from '../src/core.js';
import { createPopup, note, onRefreshMenus, projectList, projectsNote, shortDir, watchProjects, type Project } from './popup';
import { S, activeProjectDir, commit, homeOpt, sameProjectDir } from './io';

const GLOBAL_KEY = '__global';

type RowOptions = {
  key: string;
  label: string;
  title?: string;
  sub?: string;
  checked: boolean;
  onChange?: (checked: boolean) => void;
};

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
  const { menu, title, list } = pop;
  menu.setAttribute('aria-modal', 'false');

  const toggle = (dir: string, on: boolean) => {
    commit((s) => {
      if (!s.bundles.some((x) => x.id === bundleId)) return s;
      const opts = homeOpt();
      if (core.normalizeScopeDir(dir, opts) === null) {
        return on ? s : core.removeBundleProject(s, bundleId, dir, opts);
      }
      return core.setBundleInScope(s, bundleId, on, { projectDir: dir, ...opts });
    }, undefined, { label: on ? 'add project' : 'remove project' });
  };

  const row = (opts: RowOptions) => {
    const l = document.createElement('label');
    l.className = 'sb-proj-row';
    l.title = opts.title ?? opts.key;
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.className = 'sb-proj-check';
    c.checked = opts.checked;
    c.dataset.dir = opts.key;
    c.addEventListener('change', () => (opts.onChange ? opts.onChange(c.checked) : toggle(opts.key, c.checked)));
    const name = document.createElement('span');
    name.className = 'sb-ctx-name';
    name.textContent = opts.label;
    const d = document.createElement('span');
    d.className = 'sb-ctx-dir';
    d.textContent = opts.sub ?? shortDir(opts.key);
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
    const hOpt = homeOpt();
    const mine = b.projects ?? [];
    const excluded = b.excludedProjects ?? [];
    const allProjects = projectList().projects.filter((p) => core.normalizeScopeDir(p.directory, hOpt) !== null);
    pop.ensureFilter(allProjects.length + mine.length + excluded.length, 'Filter projects', (v) => { filter = v; paint(); });

    list.appendChild(row({
      key: GLOBAL_KEY,
      label: 'Global (all projects)',
      title: 'Turn on in every project',
      sub: 'every project',
      checked: b.enabled,
      onChange: (checked) => {
        commit((s) => core.setBundleGlobal(s, bundleId, checked), undefined, {
          label: checked ? 'enable bundle globally' : 'disable bundle globally',
        });
      },
    }));

    const curDir = activeProjectDir();
    const curNorm = curDir ? core.normalizeScopeDir(curDir, hOpt) : null;
    const sameNorm = (a: string, bNorm: string | null) =>
      bNorm != null && core.normalizeScopeDir(a, hOpt) === bNorm;

    const knownNorms = new Set<string>();
    for (const p of allProjects) {
      const n = core.normalizeScopeDir(p.directory, hOpt);
      if (n != null) knownNorms.add(n);
    }
    const isKnown = (dir: string) => {
      const n = core.normalizeScopeDir(dir, hOpt);
      return n != null ? knownNorms.has(n) : allProjects.some((p) => sameProjectDir(p.directory, dir));
    };
    const mineNorms = new Set<string>();
    for (const m of mine) {
      const n = core.normalizeScopeDir(m, hOpt);
      if (n != null) mineNorms.add(n);
    }
    const inMine = (dir: string) => {
      const n = core.normalizeScopeDir(dir, hOpt);
      return n != null ? mineNorms.has(n) : mine.some((m) => sameProjectDir(m, dir));
    };

    const knownRaw: Project[] = core.filterProjects(allProjects, filter);
    const known = curNorm
      ? [...knownRaw.filter((p) => sameNorm(p.directory, curNorm)), ...knownRaw.filter((p) => !sameNorm(p.directory, curNorm))]
      : curDir
        ? [...knownRaw.filter((p) => sameProjectDir(p.directory, curDir)), ...knownRaw.filter((p) => !sameProjectDir(p.directory, curDir))]
        : knownRaw;
    const q = filter.trim().toLowerCase();
    const unlistedMine = mine.filter((d) => !isKnown(d) && (!q || d.toLowerCase().includes(q)));
    const unlistedExcluded = b.enabled
      ? excluded.filter((d) => !inMine(d) && !isKnown(d) && (!q || d.toLowerCase().includes(q)))
      : [];
    const status = projectsNote(known.length + unlistedMine.length + unlistedExcluded.length, filter);

    if (status) list.appendChild(note(status));
    for (const p of known) {
      const isCur = curNorm ? sameNorm(p.directory, curNorm) : (curDir != null && sameProjectDir(p.directory, curDir));
      const checked = core.isBundleActive(b, { projectDir: p.directory, ...hOpt });
      list.appendChild(row({
        key: p.directory,
        label: p.name,
        sub: isCur ? `current · ${shortDir(p.directory)}` : undefined,
        checked,
      }));
    }

    // Folders in the bundle that OpenChamber doesn't list, kept flush in the checklist so they can be unchecked.
    if (unlistedMine.length || unlistedExcluded.length) {
      const folderLabel = (d: string) => d.split('/').filter(Boolean).pop() ?? d;
      for (const d of unlistedMine) list.appendChild(row({ key: d, label: folderLabel(d), checked: true }));
      for (const d of unlistedExcluded) list.appendChild(row({ key: d, label: folderLabel(d), checked: false }));
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
onRefreshMenus(refreshProjectsMenu);
