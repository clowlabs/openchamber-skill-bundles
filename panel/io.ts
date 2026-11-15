// Files, the CLI lock, the write queue and the frontmatter cache.
import { HostRequestError, type HostClient } from '@openchamber/sdk';
import * as core from '../src/core.js';
import type { ChangePlan, PlanError, State } from '../src/core.js';
import seed from '../data/default-bundles.json';
import { errText as hostErrText, isNotFound, pool, readOptional as readOpt } from '../shared/panel/host';
import { createQueue } from '../shared/panel/queue';
import { createPanelLock, LockedError, type PanelLock } from '../shared/panel/panel-lock';
import { backupOnce, runTxn, type TxnWrite } from '../shared/panel/txn';
import { capText, fitList } from '../shared/panel/toast';
import { homeFromDirs as sharedHomeFromDirs } from '../shared/panel/projects';

/** The host client; main sets it at boot, tests pass a fake. */
export let host: HostClient;
export function setHost(h: HostClient) {
  host = h;
  lock = createPanelLock({
    host: h,
    path: core.LOCK_PATH,
    parse: core.parseLock,
    classify: (info, opts) => core.classifyLock(info, opts),
    isOwn: (info, token) => info.kind === 'panel' && info.token === token,
    // An orphaned panel lock (frame unloaded mid-save) past PANEL_LOCK_TTL_MS. Never a CLI lock.
    reclaimStale: (info) => info.kind === 'panel',
    needsMtime: (info) => info.kind !== 'released',
    record: core.panelLockRecord,
    releasedMarker: core.RELEASED_MARKER,
    timing: lockTiming,
    timeoutMessage: (mtimeMs, now) =>
      mtimeMs > 0 && now - mtimeMs >= core.LOCK_UNPARSEABLE_STALE_MS
        ? `A CLI lock from ${new Date(mtimeMs).toLocaleString()} is blocking saves. If no \`skills\` command is running, run \`skills sync\` to clear the stale lock.`
        : 'CLI is writing — try again',
    onReleaseError: (e) => toastError(e, 'Could not release the lock'),
  });
}
let lock: PanelLock;

/** Data loaded from disk plus write-queue bookkeeping. */
export const S = {
  state: null as State | null,
  loaded: false,
  allIds: [] as string[],
  skillMds: {} as Record<string, string>,
  opencodeText: '',
  bundlesText: null as string | null,
  /** User's home dir, derived once at load (undefined = unknown: textual collapsing only). */
  home: undefined as string | undefined,
  homeDerived: false,
  descDraft: null as { id: string; value: string } | null,
};

/** Set by main: full and stats-only re-render. */
export const hooks = { render: () => {}, renderLight: () => {} };

/** `{ home }` for every core call that takes it. */
export const homeOpt = () => (S.home ? { home: S.home } : {});

/** Home dir from OpenChamber's project dirs (see shared/panel/projects). */
export const homeFromDirs = (dirs: string[]) => sharedHomeFromDirs(dirs);

async function deriveHome() {
  if (S.homeDerived) return;
  try {
    const snap = await host.listProjects();
    S.home = homeFromDirs(snap.projects.map((p) => p.directory));
    S.homeDerived = snap.state === 'ready' || S.home != null; // retry next load while still loading
  } catch (e) {
    console.warn('skill-bundles: could not list projects to find the home folder', e);
  }
}

export const skillPath = (id: string) => `${core.SKILLS_DIR}/${id}/SKILL.md`;
export const mode = (id: string) => core.effectiveMode(S.state!, id);
export const bundlesOf = (id: string) => (S.state ? S.state.bundles.filter((b) => b.skills.includes(id)) : []);

export function errText(e: unknown) {
  if (e instanceof HostRequestError) return `${e.code}: ${e.message}`;
  return hostErrText(e);
}
export function toastError(e: unknown, what: string) {
  void host.toast({ kind: 'error', message: `${what}: ${errText(e)}`, copy: true, dismiss: true });
}

// ---------- frontmatter cache ----------

type Meta = { description: string; autoinvoke: boolean; error: string | null };
const EMPTY: Meta = { description: '', autoinvoke: true, error: null };
const fm = new Map<string, Meta>();

export function meta(id: string): Meta {
  const md = S.skillMds[id];
  if (md == null) return EMPTY;
  let m = fm.get(id);
  if (!m) {
    try {
      const r = core.readFrontmatter(md);
      m = { description: r.description, autoinvoke: r.autoinvoke, error: null };
    } catch (e) {
      m = { ...EMPTY, error: errText(e) };
    }
    fm.set(id, m);
  }
  return m;
}
/** Error text when core can't safely edit this skill's SKILL.md. */
export const fmError = (id: string) => meta(id).error;
function setMd(id: string, text: string) {
  S.skillMds[id] = text;
  fm.delete(id);
}

// ---------- write queue: every write runs here, one at a time, none dropped ----------

const queue = createQueue({
  onQueued: () => hooks.renderLight(),
  onSettled: () => hooks.render(),
  onError: (e) => toastError(e, 'Saving failed'),
});
export const enqueue = queue.enqueue;
/** Writes queued or running. */
export const pending = () => queue.pending;

class StaleError extends Error {}
class RefusedError extends Error {}

// ---------- lock ----------

// Protocol shared with the CLI (core.LOCK_PATH etc.), run by shared/panel/panel-lock.
/** How long to wait for a held lock. Tests shorten it. */
export const lockTiming = { pollMs: 250, waitMs: 3000 };

export const readOptional = (path: string) => readOpt(host, path);

const withLock = <T>(fn: () => Promise<T>) => lock.withLock(fn);

// ---------- load ----------

export async function load() {
  await deriveHome();
  let dirs: string[] = [];
  try {
    const { entries } = await host.listDir(core.SKILLS_DIR);
    dirs = entries.filter((e) => e.kind === 'directory' && !e.name.startsWith('.')).map((e) => e.name);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  const allIds = [...new Set([...dirs, ...core.BUILTIN_SKILLS])].sort();

  const mds: Record<string, string> = {};
  const [, opencodeText, bundlesText] = await Promise.all([
    pool(dirs, 8, async (id) => {
      const text = await readOptional(skillPath(id));
      if (text != null) mds[id] = text;
    }),
    host.readFile(core.OPENCODE_PATH).then((r) => r.content),
    readOptional(core.BUNDLES_PATH),
  ]);
  S.allIds = allIds;
  S.skillMds = mds;
  fm.clear();
  S.opencodeText = opencodeText;
  S.bundlesText = bundlesText;
  S.state = bundlesText == null ? null : core.parseBundles(bundlesText, homeOpt());
  S.loaded = true;
}

// ---------- save ----------

type ProjectTexts = Record<string, string | null>;

function planFor(next: State, projectTexts: ProjectTexts): ChangePlan {
  try {
    return core.planChange({ bundlesText: S.bundlesText, opencodeText: S.opencodeText, skillMds: S.skillMds }, next, S.allIds, projectTexts, homeOpt());
  } catch (e) {
    const pe = e as Partial<PlanError>;
    const where = pe.file === 'skill' ? (pe.id ? `skills/${pe.id}/SKILL.md` : 'SKILL.md')
      : pe.file === 'opencode' ? 'opencode.json'
      : pe.file === 'project' ? (pe.id ? core.projectConfigPath(pe.id) : 'project opencode.json') : '';
    const msg = errText(e);
    throw new RefusedError(where && !msg.includes(where) ? `${where}: ${msg}` : msg);
  }
}
const skillIds = (p: ChangePlan) => p.writes.flatMap((w) => (w.kind === 'skill' && w.id ? [w.id] : []));

/** Re-read the SKILL.md files a plan will write. Returns true if any differed (cache now fresh). */
async function refreshSkillMds(ids: string[]) {
  let changed = false;
  await pool(ids, 8, async (id) => {
    const fresh = await readOptional(skillPath(id));
    if (fresh == null) throw new StaleError(`${id}/SKILL.md disappeared`);
    if (fresh !== S.skillMds[id]) { setMd(id, fresh); changed = true; }
  });
  return changed;
}

/** Text of `<dir>/.opencode/opencode.json` for every dir the next state touches (missing → null). */
async function readProjectTexts(next: State): Promise<ProjectTexts> {
  const out: ProjectTexts = {};
  await pool(core.projectTargets(next, homeOpt()), 8, async (dir) => {
    out[dir] = await readOptional(core.projectConfigPath(dir));
  });
  return out;
}
const sameTexts = (a: ProjectTexts, b: ProjectTexts) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => k in b && a[k] === b[k]);

async function save(next: State) {
  // Refuse early, before taking the lock (project files read now; re-read under the lock).
  const projectTexts = await readProjectTexts(next);
  const first = planFor(next, projectTexts);
  await withLock(() => saveLocked(next, first, projectTexts));
}

// Order: core.PUBLISH_ORDER (SKILL.md, project files, opencode.json, skill-bundles.json last).
async function saveLocked(next: State, first: ChangePlan, firstTexts: ProjectTexts) {
  // Bundle files changed under us: abort and reload (the caller handles StaleError).
  const [onDisk, bundlesOnDisk, projectTexts] = await Promise.all([
    host.readFile(core.OPENCODE_PATH), readOptional(core.BUNDLES_PATH), readProjectTexts(next),
  ]);
  if (onDisk.content !== S.opencodeText) throw new StaleError('opencode.json changed on disk');
  if (bundlesOnDisk !== S.bundlesText) throw new StaleError('skill-bundles.json changed on disk');

  // SKILL.md and project-file changes merge: core only splices skill rules, so plan on the
  // text read under the lock.
  let plan = sameTexts(firstTexts, projectTexts) ? first : planFor(next, projectTexts);
  for (let i = 0; i < 5 && (await refreshSkillMds(skillIds(plan))); i++) plan = planFor(next, projectTexts);

  // plan.writes is in core.PUBLISH_ORDER. Project files are shared with the user: re-read and
  // merged right before writing, restored on failure only if still exactly what we wrote.
  const writes: TxnWrite[] = plan.writes.map((w) => ({
    path: w.path,
    before: w.before,
    after: w.after,
    ...(w.kind === 'opencode' ? {
      beforeWrite: () => backupOnce(host, core.OPENCODE_PATH.replace(/[^/]+$/, core.backupName()), S.opencodeText),
    } : {}),
    ...(w.kind === 'project' ? {
      shared: true,
      merge: (fresh: string | null) => core.applyProjectPermissions(fresh, projectSkillIds(w.after)),
      neutralize: (wrote: string) => core.applyProjectPermissions(wrote, []),
    } : {}),
  }));
  await runTxn(host, writes, {
    tag: 'skill-bundles',
    onConflict: (path, rescued) => void host.toast({
      kind: 'error', dismiss: true, persistent: true, copy: { text: rescued || path },
      message: `Save failed and ${path} was edited meanwhile, so it was left as is (it may still hold this save's skill rules).${rescued ? ` Its earlier version is in ${rescued}.` : ''}`,
    }),
    onRestoreError: (path, r) => toastError(r, `Could not restore ${path}`),
  });
  for (const w of plan.writes) {
    if (w.kind === 'skill' && w.id) setMd(w.id, w.after);
    else if (w.kind === 'opencode') S.opencodeText = w.after;
    else if (w.kind === 'bundles') S.bundlesText = w.after;
  }
  S.state = plan.state ?? next;
  toastSkipped(plan.skipped);
}

/** Skill ids allowed by a project file text we generated. */
function projectSkillIds(text: string): string[] {
  try {
    const perms = (JSON.parse(text) as { permissions?: { action?: string; resource?: string }[] }).permissions ?? [];
    return perms.filter((r) => r.action === 'skill' && typeof r.resource === 'string').map((r) => r.resource as string);
  } catch {
    return [];
  }
}

function toastSkipped(skipped: ChangePlan['skipped']) {
  if (!skipped.length) return;
  const full = skipped.map((s) => `${s.id}: ${s.reason}`).join('\n');
  void host.toast({
    kind: 'info', dismiss: true,
    message: fitList(`Skipped ${skipped.length} skill(s) needing manual edit: `, skipped.map((s) => s.id)),
    copy: { text: capText(full) },
  });
}

async function reloadAfter(e: unknown) {
  if (e instanceof RefusedError) {
    void host.toast({ kind: 'error', message: `Change refused, nothing written: ${e.message}`, copy: true, dismiss: true });
    return;
  }
  if (e instanceof LockedError) {
    void host.toast({ kind: 'error', message: e.message, dismiss: true });
    return;
  }
  if (e instanceof StaleError) void host.toast({ kind: 'error', message: `${e.message} — reloaded`, dismiss: true });
  else toastError(e, 'Saving failed');
  try { await load(); } catch (r) { toastError(r, 'Reload failed'); }
}

/** Queue a state change. `onAccepted` runs only once the change is on disk. */
export function commit(fn: (s: State) => State, onAccepted?: () => void) {
  if (!S.loaded) return;
  void enqueue(async () => {
    if (await applyChange(fn)) onAccepted?.();
  });
}

/** Turn a bundle on or off (flip when `on` is omitted) through the normal save path. */
export function toggleBundle(bundleId: string, on?: boolean, onAccepted?: () => void) {
  commit((s) => flip(bundleId, on)(s), onAccepted);
}

const flip = (bundleId: string, on?: boolean) => (s: State) => {
  const b = s.bundles.find((x) => x.id === bundleId);
  if (!b) throw new Error(`Unknown bundle "${bundleId}"`);
  return core.setBundleEnabled(s, bundleId, on ?? !b.enabled);
};

/** Body of a commit; call only from inside the queue. True once on disk. */
export async function applyChange(fn: (s: State) => State): Promise<boolean> {
  if (!S.state) return false;
  let next: State;
  try {
    next = fn(S.state);
  } catch (e) {
    toastError(e, 'Change refused');
    return false;
  }
  try {
    await save(next);
  } catch (e) {
    await reloadAfter(e);
    return false;
  }
  return true;
}

export function saveDescription(id: string, text: string) {
  void enqueue(async () => {
    if (S.skillMds[id] == null) return;
    const apply = (md: string) => {
      try { return core.setDescription(md, text); } catch (e) { throw new RefusedError(errText(e)); }
    };
    try {
      apply(S.skillMds[id]); // refuse early, before taking the lock
      await withLock(async () => {
        // Apply to the file as it is now, so a CLI mode change since load survives.
        const fresh = await readOptional(skillPath(id));
        if (fresh == null) throw new StaleError(`${id}/SKILL.md disappeared`);
        if (fresh !== S.skillMds[id]) setMd(id, fresh);
        const next = apply(fresh);
        if (next !== fresh) await host.writeFile(skillPath(id), next);
        setMd(id, next);
      });
    } catch (e) {
      if (e instanceof RefusedError && S.descDraft?.id === id) S.descDraft = null;
      await reloadAfter(e);
      return;
    }
    if (S.descDraft?.id === id && S.descDraft.value === text) S.descDraft = null;
  });
}

export function seedDefaults() {
  void enqueue(async () => {
    if (S.state) return;
    try {
      await save(core.parseBundles(JSON.stringify(seed), homeOpt()));
      void host.toast({ kind: 'success', message: 'Created skill-bundles.json from the default bundles.' });
    } catch (e) {
      await reloadAfter(e);
    }
  });
}
