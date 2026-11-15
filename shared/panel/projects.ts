// OpenChamber's project list for panels: one subscription shared by every menu, OpenChamber's
// synthetic chat folders skipped, plus the home folder guess and short directory labels.
import { errorCode, type ProjectInfo, type ProjectsHost, type ProjectsSnapshot } from './host';

export type Project = ProjectInfo;

/** OpenChamber keeps chats at `<home>/.config/openchamber/chats/…`. */
export const CHATS_SUFFIX = '/.config/openchamber/chats';

/** Index of the chats suffix as a whole path segment run in `dir`, or -1. */
function chatsIndex(dir: string, suffix: string) {
  const i = dir.indexOf(suffix);
  return i > 0 && (dir.length === i + suffix.length || dir[i + suffix.length] === '/') ? i : -1;
}

/** True for OpenChamber's chat folders (not real projects). */
export function isChatsDir(dir: string | null | undefined, suffix = CHATS_SUFFIX) {
  const d = String(dir ?? '');
  return d === suffix.slice(1) || d.startsWith(suffix.slice(1) + '/') || chatsIndex(d, suffix) >= 0 || chatsIndex(`/${d}`, suffix) >= 0;
}

const HOME_PREFIX = /^(\/home\/[^/]+|\/Users\/[^/]+)(?=\/|$)/;

/**
 * The SDK doesn't expose the home dir. Derive it from project dirs: (1) a chats dir is
 * `<home><suffix>[/…]`; (2) else one shared `/home/<u>` or `/Users/<u>` prefix. Else undefined.
 */
export function homeFromDirs(dirs: readonly string[], opts: { chatsSuffix?: string } = {}): string | undefined {
  const suffix = opts.chatsSuffix ?? CHATS_SUFFIX;
  for (const d of dirs) {
    const i = chatsIndex(d, suffix);
    if (i > 0) return d.slice(0, i);
  }
  const homes = new Set(dirs.map((d) => HOME_PREFIX.exec(d)?.[1]).filter(Boolean));
  return homes.size === 1 ? [...homes][0] : undefined;
}

/** `~/…` under home, else the last two segments (`…/a/b`). */
export function shortenDir(dir: string | null | undefined, home?: string) {
  const d = String(dir ?? '').replace(/\/+$/, '');
  if (home) {
    const h = home.replace(/\/+$/, '');
    if (d === h) return '~';
    if (d.startsWith(h + '/')) return '~' + d.slice(h.length);
  }
  const segs = d.split('/').filter(Boolean);
  return segs.length <= 2 ? d || '/' : `…/${segs.slice(-2).join('/')}`;
}

/** Case-insensitive match on name or directory. */
export function filterProjects<T extends Project>(list: readonly T[], query: string | null | undefined): T[] {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((p) => p.name.toLowerCase().includes(q) || p.directory.toLowerCase().includes(q));
}

export type ProjectListOptions = {
  host: ProjectsHost;
  /** Message when listing is refused for lack of the `sessions` capability. */
  notGrantedMessage?: string;
  /** Skip predicate; default isChatsDir. */
  skip?: (dir: string) => boolean;
  /** Known home dir (e.g. derived at load) for shortDir. */
  home?: () => string | undefined;
  /** Log prefix for warnings. */
  name?: string;
};

export type ProjectList = {
  readonly projects: Project[];
  readonly state: 'idle' | 'loading' | 'ready' | 'error';
  readonly error: string;
  /** Start listing (once); `onChange` runs on each snapshot. Returns an unsubscribe. */
  watch: (onChange: () => void) => () => void;
  /** Status line instead of an empty list, or null. */
  note: (shownCount: number, filter: string) => string | null;
  /** Short label for a dir, using the known home or a /home|/Users guess. */
  shortDir: (dir: string) => string;
};

export function createProjectList(o: ProjectListOptions): ProjectList {
  let projects: Project[] = [];
  let state: ProjectList['state'] = 'idle';
  let error = '';
  let subscribed = false;
  const listeners = new Set<() => void>();
  const skip = o.skip ?? ((d: string) => isChatsDir(d));
  const notify = () => listeners.forEach((l) => l());

  const apply = (snap: ProjectsSnapshot) => {
    projects = snap.projects.filter((p) => !skip(p.directory)).sort((a, b) => a.name.localeCompare(b.name));
    state = snap.state === 'error' ? 'error' : snap.state === 'ready' ? 'ready' : 'loading';
    if (snap.state === 'error') error = 'OpenChamber could not list projects.';
    notify();
  };
  const fail = (e: unknown) => {
    subscribed = false;
    state = 'error';
    error = errorCode(e) === 'NOT_GRANTED'
      ? (o.notGrantedMessage ?? 'Needs the “sessions” permission. Re-approve the extension in Settings → Extensions.')
      : `Could not list projects: ${e instanceof Error ? e.message : String(e)}`;
    notify();
  };

  return {
    get projects() { return projects; },
    get state() { return state; },
    get error() { return error; },
    watch(onChange) {
      listeners.add(onChange);
      if (!subscribed) {
        subscribed = true;
        state = 'loading';
        o.host.listProjects().then(apply, fail);
        o.host.onProjects?.(apply).catch((e) => {
          subscribed = false;
          console.warn(`${o.name ?? 'panel'}: onProjects failed`, e);
        });
      }
      return () => { listeners.delete(onChange); };
    },
    note(shownCount, filter) {
      if (state === 'error') return error;
      if (shownCount) return null;
      return state === 'loading' ? 'Loading projects…' : filter ? 'No matching projects' : 'No projects in OpenChamber';
    },
    shortDir(dir) {
      const home = o.home?.() ?? /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/.exec(dir)?.[1];
      return shortenDir(dir, home);
    },
  };
}
