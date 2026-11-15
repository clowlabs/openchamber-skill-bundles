// "Send skill to project": the context menu and the folder copy.
import { HostRequestError, type HostClient } from '@openchamber/sdk';
import * as core from '../src/core.js';

export type Project = { id: string; name: string; directory: string };
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
let projects: Project[] = [];
let projectsState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let projectsError = '';
let subscribed = false;
let onProjectsChange: (() => void) | null = null;

export function initSend(d: SendDeps) {
  deps = d;
}

function codeOf(e: unknown) {
  return e instanceof HostRequestError ? e.code : '';
}

function ensureProjects() {
  if (subscribed) return;
  subscribed = true;
  projectsState = 'loading';
  const apply = (snap: { state: string; projects: Project[] }) => {
    projects = snap.projects.filter((p) => !core.isChatsDir(p.directory)).sort((a, b) => a.name.localeCompare(b.name));
    projectsState = snap.state === 'error' ? 'error' : snap.state === 'ready' ? 'ready' : 'loading';
    if (snap.state === 'error') projectsError = 'OpenChamber could not list projects.';
    onProjectsChange?.();
  };
  const fail = (e: unknown) => {
    subscribed = false;
    projectsState = 'error';
    projectsError = codeOf(e) === 'NOT_GRANTED'
      ? 'Needs the “sessions” permission. Re-approve Skill Bundles in Settings → Extensions.'
      : `Could not list projects: ${e instanceof Error ? e.message : String(e)}`;
    onProjectsChange?.();
  };
  deps.host.listProjects().then(apply, fail);
  deps.host.onProjects(apply).catch((e) => {
    subscribed = false;
    console.warn('skill-bundles: onProjects failed', e);
  });
}

function homeOf(dir: string) {
  return /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/.exec(dir)?.[1];
}
const shortDir = (dir: string) => core.shortenDir(dir, homeOf(dir));

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

let open: { close: () => void } | null = null;

export function closeSendMenu() {
  open?.close();
}

export function openSendMenu(id: string, x: number, y: number, altAtOpen: boolean, returnFocus?: HTMLElement | null) {
  closeSendMenu();
  ensureProjects();
  const blocked = deps.blockedReason(id);

  const menu = document.createElement('div');
  menu.className = 'sb-ctx';
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;
  const title = document.createElement('div');
  title.className = 'sb-ctx-title';
  menu.appendChild(title);
  let filterInput: HTMLInputElement | null = null;
  const list = document.createElement('div');
  list.className = 'sb-ctx-items';
  menu.appendChild(list);
  const foot = document.createElement('div');
  foot.className = 'sb-ctx-foot';
  foot.textContent = blocked ?? HINT;
  menu.appendChild(foot);

  let altDown = altAtOpen;
  let filter = '';
  let busy = false;
  let confirmFor: string | null = null;
  const dup = () => altDown;
  let staleFiles: string[] | null = []; // null = listing failed

  const paintTitle = () => {
    title.textContent = `${dup() ? 'Duplicate' : 'Move'} ${id} to…`;
    menu.setAttribute('aria-label', title.textContent);
    menu.classList.toggle('dup', dup());
    for (const b of list.querySelectorAll<HTMLElement>('.sb-ctx-icon')) b.textContent = dup() ? '⧉' : '→';
  };

  const items = () => [...list.querySelectorAll<HTMLButtonElement>('button.sb-ctx-item:not([disabled])')];

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
      close();
      await deps.enqueue(() => copySkill(id, p, move));
    } catch (e) {
      close();
      deps.toastError(e, `Could not send ${id}`);
    }
  };

  const paint = () => {
    const keep = document.activeElement instanceof HTMLElement && menu.contains(document.activeElement) ? document.activeElement.dataset.pid : undefined;
    list.textContent = '';
    if (projects.length > 8 && !filterInput) {
      filterInput = document.createElement('input');
      filterInput.className = 'sb-ctx-filter';
      filterInput.placeholder = 'Filter projects';
      filterInput.setAttribute('aria-label', 'Filter projects');
      filterInput.addEventListener('input', () => { filter = filterInput!.value; paint(); });
      menu.insertBefore(filterInput, list);
    }
    const shown: Project[] = core.filterProjects(projects, filter);
    if (projectsState === 'error') list.appendChild(note(projectsError));
    else if (!shown.length) list.appendChild(note(projectsState === 'loading' ? 'Loading projects…' : filter ? 'No matching projects' : 'No projects in OpenChamber'));
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

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Alt') { altDown = e.type === 'keydown'; paintTitle(); }
    if (e.type !== 'keydown') return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!all.length) return;
      const n = e.key === 'ArrowDown' ? (i + 1) % all.length : i <= 0 ? all.length - 1 : i - 1;
      all[n].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? all[0] : all[all.length - 1])?.focus();
    } else if (e.key === 'Enter' && document.activeElement === filterInput) {
      e.preventDefault();
      all[0]?.click();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      (filterInput && document.activeElement !== filterInput ? filterInput : all[0])?.focus();
    }
  };
  const onDown = (e: PointerEvent) => { if (!menu.contains(e.target as Node)) close(); };
  const onBlur = () => close();

  function close() {
    if (open?.close !== close) return;
    open = null;
    onProjectsChange = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onBlur);
    menu.remove();
    if (returnFocus?.isConnected) returnFocus.focus();
  }

  open = { close };
  onProjectsChange = () => paint();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  menu.addEventListener('contextmenu', (e) => e.preventDefault());

  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  paint();
  place(menu, x, y);
  menu.style.visibility = '';
  (filterInput ?? items()[0] ?? menu).focus();
}

function place(menu: HTMLElement, x: number, y: number) {
  const pad = 4;
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x + r.width + pad > vw ? x - r.width : x;
  let top = y + r.height + pad > vh ? y - r.height : y;
  left = Math.max(pad, Math.min(left, vw - r.width - pad));
  top = Math.max(pad, Math.min(top, vh - r.height - pad));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function button(text: string, cls: string) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  if (text) b.textContent = text;
  return b;
}
function note(text: string) {
  const n = document.createElement('div');
  n.className = 'sb-ctx-note';
  n.textContent = text;
  return n;
}
