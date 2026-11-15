// "Send skill to project": the context menu and the folder copy.
import { type HostClient } from '@openchamber/sdk';
import * as core from '../src/core.js';
import {
  button, closePopup, codeOf, createPopup, note, projectList, projectsNote, shortDir, watchProjects, type Project,
} from './popup';

export type SendDeps = {
  host: HostClient;
  /** Why this skill can't be sent, or null. */
  blockedReason: (id: string) => string | null;
  /** Run fn in the panel's write queue; resolves when done. */
  enqueue: (task: () => Promise<void>) => Promise<boolean>;
  /** Persist "moved": global off + projectCopies note. Runs inside the queue; reports its own errors. */
  markMoved: (id: string, dir: string) => Promise<boolean>;
  toastError: (e: unknown, what: string) => void;
};

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
      let content: string;
      try {
        content = (await deps.host.readFile(`${root}/${r}`)).content;
      } catch (err) {
        if (codeOf(err) === 'FILE_TOO_LARGE') throw new Error(`${r} is larger than 2 MB`);
        throw new Error(`${r} could not be read as text (${codeOf(err) || (err as Error).message})`);
      }
      if (utf8.encode(content).length > FILE_MAX) throw new Error(`${r} is larger than 2 MB`);
      if (core.looksBinary(content)) throw new Error(`${r} is not UTF-8 text`);
      out.push({ rel: r, content });
    }
  };
  await walk('');
  return out;
}

const skillSrc = (id: string) => `${core.SKILLS_DIR}/${id}`;

/** Copy the whole skill folder. Reads and checks every file before writing any. */
async function copySkill(id: string, project: Project, move: boolean) {
  const src = skillSrc(id);
  const dest = core.projectSkillDir(project.directory, id);
  let files: FileCopy[];
  try {
    files = await walkFiles(src, 'strict');
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
    message: `Moved to ${project.name} — global copy turned off (delete ${src} to remove it)`,
    copy: { text: src },
  });
}

// ---------- menu ----------

export const closeSendMenu = closePopup;

export function openSendMenu(id: string, x: number, y: number, altAtOpen: boolean, returnFocus?: HTMLElement | null) {
  const blocked = deps.blockedReason(id);
  let altDown = altAtOpen;
  let filter = '';
  let busy = false;
  let confirmFor: string | null = null;
  const dup = () => altDown;
  let staleFiles: string[] | null = []; // null = listing failed

  let unwatch = () => {};
  const pop = createPopup({
    itemSelector: 'button.sb-ctx-item',
    returnFocus,
    altAtOpen,
    onAlt: (down) => { altDown = down; paintTitle(); },
    onClose: () => unwatch(),
  });
  const { menu, title, list, foot } = pop;
  foot.textContent = blocked ?? HINT;

  const paintTitle = () => {
    title.textContent = `${dup() ? 'Duplicate' : 'Move'} ${id} to…`;
    menu.setAttribute('aria-label', title.textContent);
    menu.classList.toggle('dup', dup());
    for (const b of list.querySelectorAll<HTMLElement>('.sb-ctx-icon')) b.textContent = dup() ? '⧉' : '→';
  };

  const activate = async (p: Project, alt: boolean, overwrite = false) => {
    if (busy || blocked) return;
    const move = !(alt || dup());
    busy = true;
    paint();
    try {
      const dest = core.projectSkillDir(p.directory, id);
      if (!overwrite && (await deps.host.stat(dest)).kind !== 'missing') {
        // The SDK can't delete, so files only in the old copy survive an overwrite.
        try {
          const [srcFiles, destFiles] = await Promise.all([walkFiles(skillSrc(id), 'preview'), walkFiles(dest, 'preview')]);
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
    const keep = document.activeElement instanceof HTMLElement && menu.contains(document.activeElement) ? document.activeElement.dataset.pid : undefined;
    list.textContent = '';
    pop.ensureFilter(projectList().projects.length, 'Filter projects', (v) => { filter = v; paint(); });
    const shown: Project[] = core.filterProjects(projectList().projects, filter);
    const status = projectsNote(shown.length, filter);
    if (status) list.appendChild(note(status));
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
          const shown = staleFiles.slice(0, 5).join(', ');
          s.textContent = `${staleFiles.length} old file${staleFiles.length > 1 ? 's' : ''} will stay: ${shown}${staleFiles.length > 5 ? `, and ${staleFiles.length - 5} more` : ''}`;
          s.title = staleFiles.join('\n');
          c.appendChild(s);
        }
        const yes = button('Overwrite', 'sb-ctx-btn danger');
        const no = button('Cancel', 'sb-ctx-btn');
        yes.addEventListener('click', (e) => { confirmFor = null; void activate(p, e.altKey, true); });
        no.addEventListener('click', () => { confirmFor = null; paint(); focusItem(p.id); });
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
    paintTitle();
    if (keep) focusItem(keep);
  };

  const focusItem = (pid: string) => list.querySelector<HTMLElement>(`[data-pid="${CSS.escape(pid)}"]`)?.focus();

  unwatch = watchProjects(paint);
  paint();
  pop.show(x, y);
}
