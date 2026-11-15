// "Move / duplicate skill to…": context menu for bundles and projects, plus the project folder copy.
import type { HostClient } from '@openchamber/sdk';
import * as core from '../src/core.js';
import type { State } from '../src/core.js';
import type { SkillRef } from '../src/discover.js';
import { HAND_EDIT } from './dom';
import { S, bundlesOf, commit, fmError, orderBundles } from './io';
import {
  button, closePopup, codeOf, createPopup, note, projectList, projectsNote, replace, shortDir, watchProjects, type Project,
} from './popup';

export type SendDeps = {
  host: HostClient;
  /** Why this skill can't be sent to a project, or null. */
  blockedReason: (id: string) => string | null;
  /** Why this skill can't be moved between bundles, or null. */
  bundleBlockedReason?: (id: string) => string | null;
  /** Move or copy `id` into bundle `to` (or UNBUNDLED). */
  moveToBundle?: (id: string, to: string, from: string | undefined, copy: boolean) => void;
  /** Discovered skill location (real dir or flat .md file). */
  skillRef: (id: string) => SkillRef | undefined;
  /** Run fn in the panel's write queue; resolves when done. */
  enqueue: (task: () => Promise<void>) => Promise<boolean>;
  /** Persist "moved": global off + projectCopies note. Runs inside the queue; reports its own errors. */
  markMoved: (id: string, dir: string) => Promise<boolean>;
  toastError: (e: unknown, what: string) => void;
};

/** Move or duplicate `id` into target bundle `to` (or `UNBUNDLED_ID`), from bundle `from` or from all bundles (`All skills` view). */
export function moveSkillToBundle(s: State, id: string, to: string, from?: string, copy = false): State {
  if (from != null) {
    return core.moveSkill(s, id, from, to, { copy: copy && from !== core.UNBUNDLED_ID && to !== core.UNBUNDLED_ID });
  }
  if (to === core.UNBUNDLED_ID) {
    return s.bundles
      .filter((b) => b.skills.includes(id))
      .reduce((acc, b) => core.moveSkill(acc, id, b.id, core.UNBUNDLED_ID, { copy: false }), s);
  }
  const mine = s.bundles.filter((b) => b.skills.includes(id) && b.id !== to).map((b) => b.id);
  if (copy || !mine.length) {
    return core.moveSkill(s, id, core.UNBUNDLED_ID, to, { copy: true });
  }
  const first = core.moveSkill(s, id, mine[0], to, { copy: false });
  return mine.slice(1).reduce((acc, bId) => core.moveSkill(acc, id, bId, core.UNBUNDLED_ID, { copy: false }), first);
}

const FILE_MAX = 2_000_000;
const FILES_MAX = 2000;
const HINT = 'Click = move · ⌥/Alt-click = duplicate';

let deps: SendDeps;

export function initSend(d: SendDeps) {
  deps = d;
}

// ---------- copy ----------

type FileCopy = { rel: string; content: string };
const utf8 = new TextEncoder();

async function readTextFile(path: string, label: string): Promise<string> {
  let content: string;
  try {
    content = (await deps.host.readFile(path)).content;
  } catch (err) {
    if (codeOf(err) === 'FILE_TOO_LARGE') throw new Error(`${label} is larger than 2 MB`);
    throw new Error(`${label} could not be read as text (${codeOf(err) || (err as Error).message})`);
  }
  if (utf8.encode(content).length > FILE_MAX) throw new Error(`${label} is larger than 2 MB`);
  if (core.looksBinary(content)) throw new Error(`${label} is not UTF-8 text`);
  return content;
}

/**
 * Walk `root`. `strict` reads every file and throws on anything that can't be copied
 * (non-regular, too many, over 2 MB, not text); `preview` only lists paths, capped silently.
 */
async function walkFiles(root: string, mode: 'strict'): Promise<FileCopy[]>;
async function walkFiles(root: string, mode: 'preview'): Promise<{ rel: string }[]>;
async function walkFiles(root: string, mode: 'strict' | 'preview'): Promise<{ rel: string; content?: string }[]> {
  const strict = mode === 'strict';
  const out: { rel: string; content?: string }[] = [];
  const walk = async (rel: string): Promise<void> => {
    const { entries } = await deps.host.listDir(rel ? `${root}/${rel}` : root);
    for (const e of entries) {
      if (out.length >= FILES_MAX) {
        if (strict) throw new Error(`more than ${FILES_MAX} files`);
        return;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.kind === 'directory') { await walk(r); continue; }
      if (!strict) { out.push({ rel: r }); continue; }
      if (e.kind !== 'file') throw new Error(`${r} is not a regular file (symlink or special file)`);
      out.push({ rel: r, content: await readTextFile(`${root}/${r}`, r) });
    }
  };
  await walk('');
  return out;
}

/** Copy the whole skill folder (or flat .md file as SKILL.md). Reads and checks every file before writing any. */
async function copySkill(id: string, project: Project, move: boolean) {
  const ref = deps.skillRef(id);
  const removeTarget = ref ? (ref.dir ?? ref.path) : `${core.SKILLS_DIR}/${id}`;
  const dest = core.projectSkillDir(project.directory, id);
  let files: FileCopy[];
  try {
    files = ref && ref.dir == null
      ? [{ rel: 'SKILL.md', content: await readTextFile(ref.path, `${id}.md`) }]
      : await walkFiles(ref?.dir ?? `${core.SKILLS_DIR}/${id}`, 'strict');
  } catch (e) {
    deps.toastError(e, `Not copied — ${id}`);
    return;
  }
  try {
    for (const f of files) await deps.host.writeFile(`${dest}/${f.rel}`, f.content);
  } catch (e) {
    deps.toastError(e, `Copy to ${project.name} stopped partway; check ${dest}`);
    return;
  }
  if (!move) {
    void deps.host.toast({ kind: 'success', message: `Copied to ${project.name}` });
    return;
  }
  if (!(await deps.markMoved(id, project.directory))) {
    void deps.host.toast({ kind: 'error', dismiss: true, message: `Copied to ${project.name}, but the global copy is still on (see the previous message).` });
    return;
  }
  void deps.host.toast({
    kind: 'success', dismiss: true,
    message: `Moved to ${project.name} — global copy turned off (delete ${removeTarget} to remove it)`,
    copy: { text: removeTarget },
  });
}

// ---------- menu ----------

export const closeSendMenu = closePopup;

type BundleItem = { id: string; name: string; skills: string[]; enabled: boolean; synthetic?: boolean };

function bundleItemsFor(id: string, from: string | undefined, duplicating: boolean): BundleItem[] {
  const state = S.state;
  if (!state) return [];
  const items: BundleItem[] = orderBundles(state.bundles)
    .filter((b) => !b.skills.includes(id))
    .map((b) => ({ id: b.id, name: b.name, skills: b.skills, enabled: b.enabled }));
  const inBundle = from != null ? from !== core.UNBUNDLED_ID : bundlesOf(id).length > 0;
  if (!duplicating && inBundle) {
    items.push({ id: core.UNBUNDLED_ID, name: 'Unbundled', skills: [], enabled: false, synthetic: true });
  }
  return items;
}

function defaultBundleBlocked(id: string): string | null {
  if (!S.loaded || !S.state) return 'Still loading.';
  const err = fmError(id);
  return err ? `Manual edit needed (${err}). ${HAND_EDIT}.` : null;
}

let repaintOpen: (() => void) | null = null;
/** Called after every render so an open menu reflects newly created or updated bundles. */
export function refreshSendMenu() {
  repaintOpen?.();
}

export function openSendMenu(id: string, x: number, y: number, altAtOpen: boolean, returnFocus?: HTMLElement | null, from?: string) {
  let altDown = altAtOpen;
  let filter = '';
  let busy = false;
  let confirmFor: string | null = null;
  const dup = () => altDown;
  let staleFiles: string[] | null = []; // null = listing failed

  let unwatch = () => {};
  const pop = createPopup({
    itemSelector: 'button.sb-ctx-item, .sb-ctx-confirm button',
    returnFocus,
    altAtOpen,
    onAlt: (down) => { altDown = down; paint(); },
    onClose: () => { unwatch(); if (repaintOpen === paint) repaintOpen = null; },
  });
  const { menu, title, list, foot } = pop;

  const paintTitle = () => {
    title.textContent = `${dup() ? 'Duplicate' : 'Move'} ${id} to…`;
    menu.setAttribute('aria-label', title.textContent);
    menu.classList.toggle('dup', dup());
    for (const b of list.querySelectorAll<HTMLElement>('.sb-ctx-icon')) b.textContent = dup() ? '⧉' : '→';
  };

  const activateBundle = (to: string, alt: boolean) => {
    const bundleBlocked = (deps.bundleBlockedReason ?? defaultBundleBlocked)(id);
    if (busy || bundleBlocked) return;
    const copy = Boolean(alt || dup());
    pop.close();
    const run = deps.moveToBundle ?? ((skillId, target, src, cp) => commit((s) => moveSkillToBundle(s, skillId, target, src, cp), undefined, { label: cp ? 'duplicate skill' : 'move skill' }));
    run(id, to, from, copy);
  };

  const activate = async (p: Project, alt: boolean, overwrite = false) => {
    const blocked = deps.blockedReason(id);
    if (busy || blocked) return;
    const move = !(alt || dup());
    busy = true;
    paint();
    try {
      const dest = core.projectSkillDir(p.directory, id);
      if (!overwrite && (await deps.host.stat(dest)).kind !== 'missing') {
        // The SDK can't delete, so files only in the old copy survive an overwrite.
        try {
          const ref = deps.skillRef(id);
          const [srcFiles, destFiles] = await Promise.all([
            ref && ref.dir == null ? Promise.resolve([{ rel: 'SKILL.md' }]) : walkFiles(ref?.dir ?? `${core.SKILLS_DIR}/${id}`, 'preview'),
            walkFiles(dest, 'preview'),
          ]);
          const have = new Set(srcFiles.map((f) => f.rel));
          staleFiles = destFiles.map((f) => f.rel).filter((f) => !have.has(f));
        } catch (e) {
          staleFiles = null;
          console.warn('skill-bundles: could not list existing files', e);
        }
        busy = false;
        confirmFor = p.id;
        paint();
        menu.querySelector<HTMLButtonElement>('.sb-ctx-confirm button')?.focus();
        return;
      }
      pop.close();
      await deps.enqueue(() => copySkill(id, p, move));
    } catch (e) {
      pop.close();
      deps.toastError(e, `Could not send ${id}`);
    }
  };

  const paint = () => {
    const blocked = deps.blockedReason(id);
    const bundleBlocked = (deps.bundleBlockedReason ?? defaultBundleBlocked)(id);
    const active = document.activeElement instanceof HTMLElement && menu.contains(document.activeElement) ? document.activeElement : undefined;
    const hadFocus = active != null && active !== pop.filterInput;
    const keepBid = active?.dataset.bid;
    const keepPid = active?.dataset.pid;
    const keepConfirm = active?.dataset.confirm;
    list.textContent = '';

    const allBundles = bundleItemsFor(id, from, dup());
    const q = filter.trim().toLowerCase();
    const shownBundles = !q ? allBundles : allBundles.filter((b) => b.name.toLowerCase().includes(q) || b.id.toLowerCase().includes(q));
    pop.ensureFilter(allBundles.length + projectList().projects.length, allBundles.length ? 'Filter bundles or projects' : 'Filter projects', (v) => { filter = v; paint(); });

    if (shownBundles.length) {
      const h = document.createElement('div');
      h.className = 'sb-ctx-title';
      h.textContent = 'Bundles';
      list.appendChild(h);
      for (const b of shownBundles) {
        const item = button('', 'sb-ctx-item');
        item.dataset.bid = b.id;
        item.setAttribute('role', 'menuitem');
        item.tabIndex = -1;
        const icon = document.createElement('span');
        icon.className = 'sb-ctx-icon';
        icon.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.className = 'sb-ctx-name';
        name.textContent = b.name;
        const meta = document.createElement('span');
        meta.className = 'sb-ctx-dir';
        meta.textContent = b.synthetic ? 'remove from bundle' : `${b.skills.length} skill${b.skills.length === 1 ? '' : 's'} · ${b.enabled ? 'on' : 'off'}`;
        item.append(icon, name, meta);
        item.title = bundleBlocked ?? (b.synthetic ? 'Remove from bundle' : b.name);
        if (bundleBlocked || busy) { item.disabled = true; item.setAttribute('aria-disabled', 'true'); }
        item.addEventListener('click', (e) => activateBundle(b.id, e.altKey));
        item.addEventListener('dblclick', (e) => activateBundle(b.id, e.altKey));
        list.appendChild(item);
      }
    }

    const shown: Project[] = core.filterProjects(projectList().projects, filter);
    const status = projectsNote(shown.length, filter);
    if (allBundles.length && (shown.length || !q)) {
      const h = document.createElement('div');
      h.className = 'sb-ctx-title';
      h.textContent = 'Projects';
      list.appendChild(h);
    }
    if (status && (!q || !shownBundles.length)) {
      list.appendChild(note(q && allBundles.length && status === 'No matching projects' ? 'No matching bundles or projects' : status));
    }
    for (const p of shown) {
      if (confirmFor === p.id) {
        const c = document.createElement('div');
        c.className = 'sb-ctx-confirm';
        c.setAttribute('role', 'group');
        c.textContent = `${id} already exists in ${p.name}. Overwrite?`;
        if (staleFiles == null) {
          const s = document.createElement('div');
          s.className = 'sb-ctx-stale';
          s.textContent = "Couldn't list existing files; old files may stay.";
          c.appendChild(s);
        } else if (staleFiles.length) {
          const s = document.createElement('div');
          s.className = 'sb-ctx-stale';
          const shownStale = staleFiles.slice(0, 5).join(', ');
          s.textContent = `${staleFiles.length} old file${staleFiles.length > 1 ? 's' : ''} will stay: ${shownStale}${staleFiles.length > 5 ? `, and ${staleFiles.length - 5} more` : ''}`;
          s.title = staleFiles.join('\n');
          c.appendChild(s);
        }
        const yes = button('Overwrite', 'sb-ctx-btn danger');
        const no = button('Cancel', 'sb-ctx-btn');
        yes.dataset.confirm = 'yes';
        no.dataset.confirm = 'no';
        yes.addEventListener('click', (e) => { confirmFor = null; void activate(p, e.altKey, true); });
        no.addEventListener('click', () => { confirmFor = null; paint(); focusProject(p.id); });
        c.append(yes, no);
        list.appendChild(c);
        continue;
      }
      const b = button('', 'sb-ctx-item');
      b.dataset.pid = p.id;
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      const icon = document.createElement('span');
      icon.className = 'sb-ctx-icon';
      icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'sb-ctx-name';
      name.textContent = p.name;
      const dir = document.createElement('span');
      dir.className = 'sb-ctx-dir';
      dir.textContent = shortDir(p.directory);
      b.append(icon, name, dir);
      b.title = blocked ?? p.directory;
      if (blocked || busy) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
      b.addEventListener('click', (e) => void activate(p, e.altKey));
      b.addEventListener('dblclick', (e) => void activate(p, e.altKey)); // guarded by `busy`/close
      list.appendChild(b);
    }
    foot.textContent = bundleBlocked ?? (allBundles.length ? HINT : (blocked ?? HINT));
    paintTitle();
    if (keepBid) focusBundle(keepBid);
    else if (keepPid) focusProject(keepPid);
    else if (keepConfirm) list.querySelector<HTMLElement>(`[data-confirm="${CSS.escape(keepConfirm)}"]`)?.focus();
    if (hadFocus && (!document.activeElement || !menu.contains(document.activeElement))) {
      (pop.items()[0] ?? pop.filterInput ?? menu).focus();
    }
    if (menu.isConnected) replace(menu);
  };

  const focusBundle = (bid: string) => list.querySelector<HTMLElement>(`[data-bid="${CSS.escape(bid)}"]`)?.focus();
  const focusProject = (pid: string) => list.querySelector<HTMLElement>(`[data-pid="${CSS.escape(pid)}"]`)?.focus();

  unwatch = watchProjects(paint);
  repaintOpen = paint;
  paint();
  pop.show(x, y);
}
