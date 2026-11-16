// Files, the CLI lock, the write queue and the frontmatter cache.
import { HostRequestError, type HostClient } from '@openchamber/sdk';
import * as core from '../src/core.js';
import type { Bundle, ChangePlan, PlanError, State } from '../src/core.js';
import type { SkillRef } from '../src/discover.js';
import { skillRoots } from '../src/discover.js';
import seed from '../data/default-bundles.json';
import { discoverSkills, type Unreachable } from './discover';
import { broadcastChange, listenChanges } from './sync';
import { errorCode, errText as hostErrText, pool, readOptional as readOpt } from '../shared/panel/host';
import { createQueue } from '../shared/panel/queue';
import { createPanelLock, LockedError, type PanelLock } from '../shared/panel/panel-lock';
import { backupOnce, runTxn, type TxnWrite } from '../shared/panel/txn';
import { capText, fitList } from '../shared/panel/toast';
import { homeFromDirs as sharedHomeFromDirs } from '../shared/panel/projects';

/** The host client; main sets it at boot, tests pass a fake. */
export let host: HostClient;
export function setHost(h: HostClient) {
  gen++;
  lastDiskStamp = null;
  configStamps = Object.create(null);
  skillFileStamps = Object.create(null);
  syncInFlight = null;
  queuedSync = null;
  deferredSync = null;
  clearLockRetry();
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
  skillRefs: Object.create(null) as Record<string, SkillRef>,
  skillPaths: Object.create(null) as Record<string, string>,
  unreachable: [] as Unreachable[],
  /** Some folder could not be scanned (unreachable roots, entries or truncation; not file reads). */
  incomplete: false,
  /** Ids found but whose markdown could not be read. */
  unreadable: [] as string[],
  skillMds: {} as Record<string, string>,
  opencodeText: '',
  bundlesText: null as string | null,
  /** User's home dir, derived once at load (undefined = unknown: textual collapsing only). */
  home: undefined as string | undefined,
  homeDerived: false,
  descDraft: null as { id: string; value: string } | null,
  /** Bundle ids created in this session (newest first) so pickers surface them first. */
  createdBundles: [] as string[],
};

export function noteCreatedBundle(id: string) {
  S.createdBundles = [id, ...S.createdBundles.filter((x) => x !== id)];
}

/** Order bundles for "add/move to bundle" pickers: session-created first, then empty bundles, then stored order. */
export function orderBundles(bundles: readonly Bundle[]): Bundle[] {
  const rank = (b: Bundle, i: number) => {
    const c = S.createdBundles.indexOf(b.id);
    if (c >= 0) return c;
    if (b.skills.length === 0) return S.createdBundles.length + (bundles.length - i);
    return S.createdBundles.length + bundles.length + 1 + i;
  };
  return bundles
    .map((b, i) => ({ b, r: rank(b, i) }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.b);
}

/** Set by main: full, stats-only, and external-sync re-render. */
export const hooks = {
  render: () => {},
  renderLight: () => {},
  onExternalSync: () => hooks.render(),
};

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

export const skillPath = (id: string) => S.skillPaths[id] ?? `${core.SKILLS_DIR}/${id}/SKILL.md`;
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
  if (md == null) return S.unreadable.includes(id) ? { ...EMPTY, error: `${skillPath(id)} could not be read` } : EMPTY;
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

let activeWrites = 0;

const queue = createQueue({
  onQueued: () => hooks.renderLight(),
  onSettled: () => {
    hooks.render();
    if (deferredSync && queue.pending === 0) {
      const next = deferredSync;
      deferredSync = null;
      void syncFromDisk(next).catch(() => {});
    }
  },
  onError: (e) => toastError(e, 'Saving failed'),
});
export const enqueue: typeof queue.enqueue = (task) =>
  queue.enqueue(async () => {
    if (syncInFlight) await syncInFlight.catch(() => false);
    activeWrites++;
    try {
      await task();
    } finally {
      activeWrites--;
    }
  });
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

// ---------- disk stamp & cross-surface sync ----------

type SyncOpts = { full?: boolean };

let gen = 0;
let lastDiskStamp: string | null = null;
let configStamps: Record<string, string> = Object.create(null);
let skillFileStamps: Record<string, string> = Object.create(null);
let syncInFlight: Promise<boolean> | null = null;
let queuedSync: SyncOpts | null = null;
let deferredSync: SyncOpts | null = null;
let lockRetryTimer: ReturnType<typeof setTimeout> | null = null;
let lockRetryDeadline = 0;
let lockRetryOpts: SyncOpts | null = null;

function clearLockRetry() {
  if (lockRetryTimer != null) {
    clearTimeout(lockRetryTimer);
    lockRetryTimer = null;
  }
  lockRetryDeadline = 0;
  lockRetryOpts = null;
}

function mergeSyncOpts(a: SyncOpts | null, b?: SyncOpts): SyncOpts {
  return a?.full || b?.full ? { full: true } : {};
}

const statStamp = (p: string): Promise<string> =>
  host.stat(p).then(
    (st) => `${st.kind}:${st.size}:${st.mtime}`,
    (e) => `err:${errorCode(e) || 'ERR'}`,
  );

function configStampPaths(opencodeText: string | null): string[] {
  return [core.BUNDLES_PATH, core.OPENCODE_PATH, core.LOCK_PATH, ...skillRoots(opencodeText)];
}

async function readStampsMap(paths: readonly string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths)];
  const out: Record<string, string> = Object.create(null);
  await pool(unique, 16, async (p) => {
    out[p] = await statStamp(p);
  });
  return out;
}

function computeConfigStamp(opencodeText: string | null, stamps: Record<string, string>): string {
  return configStampPaths(opencodeText).map((p) => `${p}=${stamps[p] ?? ''}`).join('|');
}

function computeSkillsStamp(skillPaths: Record<string, string>, stamps: Record<string, string>): string {
  const sorted = Object.values(skillPaths).sort();
  return sorted.map((p) => `${p}=${stamps[p] ?? ''}`).join('|');
}

function combineStamp(
  opencodeText: string | null,
  cfgStamps: Record<string, string>,
  skillPaths: Record<string, string>,
  skStamps: Record<string, string>,
): string {
  return `${computeConfigStamp(opencodeText, cfgStamps)}||${computeSkillsStamp(skillPaths, skStamps)}`;
}

async function readDiskStamp(): Promise<string> {
  const [cfgStamps, freshSkillStamps] = await Promise.all([
    readStampsMap(configStampPaths(S.opencodeText)),
    readStampsMap(Object.values(S.skillPaths).sort()),
  ]);
  return combineStamp(S.opencodeText, cfgStamps, S.skillPaths, freshSkillStamps);
}

async function readReleasedLockStamp(): Promise<string> {
  const lockText = await readOptional(core.LOCK_PATH);
  if (lockText !== core.RELEASED_MARKER) return '';
  return statStamp(core.LOCK_PATH);
}

// ---------- load ----------

const MAX_UNDO = 30;
let undoStack: { state: State; label: string }[] = [];

export const canUndo = () => S.loaded && undoStack.length > 0;
export const undoDepth = () => undoStack.length;
export const undoLabel = () => undoStack.at(-1)?.label ?? null;

export type ChangeOpts = { label?: string; undoable?: boolean | 'clear' };

export async function load() {
  const myGen = ++gen;
  queuedSync = null;
  deferredSync = null;
  clearLockRetry();
  undoStack = [];
  await deriveHome();
  const preConfigStamps = await readStampsMap([core.BUNDLES_PATH, core.OPENCODE_PATH, core.LOCK_PATH]);
  const [opencodeText, bundlesText] = await Promise.all([
    host.readFile(core.OPENCODE_PATH).then((r) => r.content),
    readOptional(core.BUNDLES_PATH),
  ]);
  const roots = skillRoots(opencodeText);
  const preRootStamps = await readStampsMap(roots);
  const { skills, unreachable } = await discoverSkills(host, opencodeText);
  const discoveredIds = Object.keys(skills);
  const allIds = [...new Set([...discoveredIds, ...core.BUILTIN_SKILLS])].sort();
  const skillPaths: Record<string, string> = Object.create(null);
  for (const id of discoveredIds) skillPaths[id] = skills[id].path;
  const sortedSkillPaths = Object.values(skillPaths).sort();
  const preSkillStamps = await readStampsMap(sortedSkillPaths);

  const incomplete = unreachable.length > 0;
  const unreadable: string[] = [];
  const mds: Record<string, string> = {};
  await pool(discoveredIds, 8, async (id) => {
    try {
      const text = await readOptional(skillPaths[id]);
      if (text != null) mds[id] = text;
    } catch (e) {
      // Listed but unreadable: keep the id (its allow rule still applies), leave the file alone.
      const code = errorCode(e);
      if (code !== 'DENIED' && code !== 'BAD_PATH' && code !== 'FILE_TOO_LARGE') throw e;
      unreachable.push({ path: skillPaths[id], code });
      unreadable.push(id);
    }
  });
  S.allIds = allIds;
  S.skillRefs = skills;
  S.skillPaths = skillPaths;
  S.unreachable = unreachable;
  S.incomplete = incomplete;
  S.unreadable = unreadable.sort();
  S.skillMds = mds;
  fm.clear();
  S.opencodeText = opencodeText;
  S.bundlesText = bundlesText;
  S.state = bundlesText == null ? null : core.parseBundles(bundlesText, homeOpt());
  S.loaded = true;
  if (myGen === gen) {
    try {
      const [held, postConfigStamps, postSkillStamps] = await Promise.all([
        isLockHeld(),
        readStampsMap(configStampPaths(opencodeText)),
        readStampsMap(sortedSkillPaths),
      ]);
      if (myGen === gen) {
        const nextSkillStamps: Record<string, string> = Object.create(null);
        let skillsStable = true;
        for (const p of sortedSkillPaths) {
          if (preSkillStamps[p] === postSkillStamps[p]) {
            nextSkillStamps[p] = postSkillStamps[p];
          } else {
            skillsStable = false;
          }
        }
        skillFileStamps = nextSkillStamps;
        const cfgStable =
          !held &&
          [core.BUNDLES_PATH, core.OPENCODE_PATH, core.LOCK_PATH].every((p) => preConfigStamps[p] === postConfigStamps[p]) &&
          roots.every((r) => preRootStamps[r] === postConfigStamps[r]);
        if (cfgStable && skillsStable) {
          configStamps = postConfigStamps;
          lastDiskStamp = combineStamp(opencodeText, postConfigStamps, skillPaths, nextSkillStamps);
        } else {
          configStamps = Object.create(null);
          lastDiskStamp = null;
        }
      }
    } catch {
      lastDiskStamp = null;
      configStamps = Object.create(null);
      skillFileStamps = Object.create(null);
    }
  }
}

// ---------- save ----------

type ProjectTexts = Record<string, string | null>;

function planFor(next: State, projectTexts: ProjectTexts): ChangePlan {
  try {
    return core.planChange(
      { bundlesText: S.bundlesText, opencodeText: S.opencodeText, skillMds: S.skillMds, skillPaths: S.skillPaths, unreadable: S.unreadable, incomplete: S.incomplete },
      next,
      S.allIds,
      projectTexts,
      homeOpt(),
    );
  } catch (e) {
    const pe = e as Partial<PlanError>;
    const where = pe.file === 'skill' ? (pe.id ? skillPath(pe.id) : 'SKILL.md')
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
    const p = skillPath(id);
    const fresh = await readOptional(p);
    if (fresh == null) throw new StaleError(`${p} disappeared`);
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
  const { writtenSkillIds, lockedCfgStamps, lockedSkillStamps } = await withLock(() => saveLocked(next, first, projectTexts));
  try {
    const lockStamp = await readReleasedLockStamp();
    configStamps = { ...lockedCfgStamps, [core.LOCK_PATH]: lockStamp };
    for (const [p, st] of Object.entries(lockedSkillStamps)) skillFileStamps[p] = st;
    lastDiskStamp = combineStamp(S.opencodeText, configStamps, S.skillPaths, skillFileStamps);
  } catch {
    // Best effort: checkDisk will resync if stat failed.
  }
  broadcastChange(writtenSkillIds.length > 0 ? { full: true } : undefined);
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
  const writtenSkillIds = skillIds(plan);
  const writtenPaths = [...new Set(writtenSkillIds.map((id) => skillPath(id)))];
  const [lockedCfgStamps, lockedSkillStamps] = await Promise.all([
    readStampsMap([core.BUNDLES_PATH, core.OPENCODE_PATH, ...skillRoots(S.opencodeText)]),
    readStampsMap(writtenPaths),
  ]);
  return { writtenSkillIds, lockedCfgStamps, lockedSkillStamps };
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
export function commit(fn: (s: State) => State, onAccepted?: () => void, opts?: ChangeOpts) {
  if (!S.loaded) return;
  void enqueue(async () => {
    if (await applyChange(fn, opts)) onAccepted?.();
  });
}

/** Turn a bundle on or off (flip when `on` is omitted) through the normal save path. */
export function toggleBundle(bundleId: string, on?: boolean, onAccepted?: () => void) {
  commit((s) => flip(bundleId, on)(s), onAccepted, { label: 'toggle bundle' });
}

const flip = (bundleId: string, on?: boolean) => (s: State) => {
  const b = s.bundles.find((x) => x.id === bundleId);
  if (!b) throw new Error(`Unknown bundle "${bundleId}"`);
  return core.setBundleEnabled(s, bundleId, on ?? !b.enabled);
};

/** Body of a commit; call only from inside the queue. True once on disk. */
export async function applyChange(fn: (s: State) => State, opts?: ChangeOpts): Promise<boolean> {
  if (!S.state) return false;
  const prev = S.state;
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
  if (opts?.undoable === 'clear') {
    undoStack = [];
  } else if (opts?.undoable !== false && prev && next !== prev && JSON.stringify(prev) !== JSON.stringify(next)) {
    undoStack.push({ state: prev, label: opts?.label ?? 'change' });
    if (undoStack.length > MAX_UNDO) undoStack.splice(0, undoStack.length - MAX_UNDO);
  }
  return true;
}

/** Revert the most recent undoable state change. */
export async function undo(): Promise<boolean> {
  if (!canUndo() || pending() > 0) return false;
  const entry = undoStack.at(-1);
  if (!entry) return false;
  const prev = entry.state;
  let ok = false;
  const ran = await enqueue(async () => {
    if (!canUndo() || undoStack.at(-1) !== entry) return;
    ok = await applyChange((cur) => {
      const managedProjects = [...new Set([...(prev.managedProjects ?? []), ...(cur.managedProjects ?? [])])];
      return managedProjects.length ? { ...prev, managedProjects } : { ...prev };
    }, { undoable: false });
    if (ok && undoStack.at(-1) === entry) {
      undoStack.pop();
      const liveIds = new Set((S.state?.bundles ?? []).map((b) => b.id));
      S.createdBundles = S.createdBundles.filter((id) => liveIds.has(id));
      hooks.renderLight();
    }
  });
  return ran && ok;
}

export function saveDescription(id: string, text: string) {
  void enqueue(async () => {
    if (S.skillMds[id] == null) return;
    const apply = (md: string) => {
      try { return core.setDescription(md, text); } catch (e) { throw new RefusedError(errText(e)); }
    };
    try {
      if (S.incomplete) throw new RefusedError(`some skill folders could not be read, so it is unclear which SKILL.md ${id} uses`);
      apply(S.skillMds[id]); // refuse early, before taking the lock
      const p = skillPath(id);
      let lockedSkillStamp = '';
      await withLock(async () => {
        // Apply to the file as it is now, so a CLI mode change since load survives.
        const fresh = await readOptional(p);
        if (fresh == null) throw new StaleError(`${p} disappeared`);
        if (fresh !== S.skillMds[id]) setMd(id, fresh);
        const next = apply(fresh);
        if (next !== fresh) await host.writeFile(p, next);
        setMd(id, next);
        lockedSkillStamp = await statStamp(p);
      });
      try {
        const lockStamp = await readReleasedLockStamp();
        skillFileStamps[p] = lockedSkillStamp;
        configStamps[core.LOCK_PATH] = lockStamp;
        lastDiskStamp = combineStamp(S.opencodeText, configStamps, S.skillPaths, skillFileStamps);
      } catch {
        // Best effort.
      }
      broadcastChange({ full: true });
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

// ---------- background sync ----------

const sameArr = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const sameRec = (a: Record<string, string>, b: Record<string, string>) => {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
};

const sameUnreach = (a: readonly Unreachable[], b: readonly Unreachable[]) =>
  a.length === b.length && a.every((u, i) => u.path === b[i].path && u.code === b[i].code);

function hasUnknownSkill(st: State | null, allIds: readonly string[]): boolean {
  if (!st) return false;
  const known = new Set(allIds);
  for (const b of st.bundles) {
    for (const id of b.skills) {
      if (!core.isBuiltin(id) && !known.has(id)) return true;
    }
  }
  for (const id of Object.keys(st.overrides)) {
    if (!core.isBuiltin(id) && !known.has(id)) return true;
  }
  return false;
}

async function isLockHeld(): Promise<boolean> {
  const lockText = await readOptional(core.LOCK_PATH);
  if (lockText == null) return false;
  const info = core.parseLock(lockText);
  if (info.kind === 'released') return false;
  const st = await host.stat(core.LOCK_PATH).catch(() => ({ kind: 'missing' as const, size: 0, mtime: 0 }));
  const mtimeMs = st.kind === 'missing' ? 0 : st.mtime < 1e12 ? st.mtime * 1000 : st.mtime;
  return core.classifyLock(info, { now: Date.now(), mtimeMs }) === 'held';
}

function scheduleLockRetry(opts?: SyncOpts) {
  lockRetryOpts = mergeSyncOpts(lockRetryOpts, opts);
  const now = Date.now();
  if (lockRetryDeadline === 0) lockRetryDeadline = now + lockTiming.waitMs;
  if (now >= lockRetryDeadline) {
    clearLockRetry();
    return;
  }
  if (lockRetryTimer != null) return;
  lockRetryTimer = setTimeout(() => {
    lockRetryTimer = null;
    if (!S.loaded) {
      clearLockRetry();
      return;
    }
    // Keep lockRetryOpts until runSync finishes a stable snapshot.
    void syncFromDisk().catch(() => {});
  }, lockTiming.pollMs);
}

async function runSync(opts?: SyncOpts): Promise<boolean> {
  const myGen = gen;
  if (!S.loaded || activeWrites > 0) return false;

  const effectiveOpts = mergeSyncOpts(lockRetryOpts, opts);
  if (lockRetryTimer != null) {
    clearTimeout(lockRetryTimer);
    lockRetryTimer = null;
  }

  if (await isLockHeld()) {
    scheduleLockRetry(effectiveOpts);
    return false;
  }
  if (myGen !== gen || !S.loaded || activeWrites > 0) return false;

  const oldCfgPaths = configStampPaths(S.opencodeText);
  const preConfigStamps = await readStampsMap(oldCfgPaths);
  if (myGen !== gen || !S.loaded || activeWrites > 0) return false;

  const [opencodeText, bundlesText] = await Promise.all([
    host.readFile(core.OPENCODE_PATH).then((r) => r.content),
    readOptional(core.BUNDLES_PATH),
  ]);
  if (myGen !== gen || !S.loaded) return false;
  if (activeWrites > 0) {
    deferredSync = mergeSyncOpts(deferredSync, effectiveOpts);
    return false;
  }

  const newCfgPaths = configStampPaths(opencodeText);
  const addedCfgPaths = newCfgPaths.filter((p) => !oldCfgPaths.includes(p));
  const preNewRootStamps = addedCfgPaths.length ? await readStampsMap(addedCfgPaths) : (Object.create(null) as Record<string, string>);
  if (myGen !== gen || !S.loaded) return false;
  if (activeWrites > 0) {
    deferredSync = mergeSyncOpts(deferredSync, effectiveOpts);
    return false;
  }

  const nextState = bundlesText == null ? null : core.parseBundles(bundlesText, homeOpt());
  const needsFull =
    Boolean(effectiveOpts.full) ||
    JSON.stringify(skillRoots(opencodeText)) !== JSON.stringify(skillRoots(S.opencodeText)) ||
    hasUnknownSkill(nextState, S.allIds);

  let nextAllIds = S.allIds;
  let nextSkillRefs = S.skillRefs;
  let nextSkillPaths = S.skillPaths;
  let nextIncomplete = S.incomplete;
  let nextUnreachable = S.unreachable;
  let nextUnreadable = S.unreadable;
  let nextMds = S.skillMds;
  let nextSkillStamps: Record<string, string> | null = null;

  if (needsFull) {
    const { skills, unreachable } = await discoverSkills(host, opencodeText);
    if (myGen !== gen || !S.loaded) return false;
    const discoveredIds = Object.keys(skills);
    nextAllIds = [...new Set([...discoveredIds, ...core.BUILTIN_SKILLS])].sort();
    nextSkillRefs = skills;
    nextSkillPaths = Object.create(null) as Record<string, string>;
    for (const id of discoveredIds) nextSkillPaths[id] = skills[id].path;
    nextIncomplete = unreachable.length > 0;
    nextUnreachable = unreachable;
    nextSkillStamps = await readStampsMap(Object.values(nextSkillPaths).sort());
    if (myGen !== gen || !S.loaded) return false;

    const unreadable: string[] = [];
    const mds: Record<string, string> = {};
    const unreadablePrev = new Set(S.unreadable);
    await pool(discoveredIds, 8, async (id) => {
      const p = nextSkillPaths[id];
      const st = nextSkillStamps?.[p];
      if (
        S.skillPaths[id] === p &&
        !unreadablePrev.has(id) &&
        Object.hasOwn(S.skillMds, id) &&
        st != null &&
        skillFileStamps[p] === st
      ) {
        mds[id] = S.skillMds[id];
        return;
      }
      try {
        const text = await readOptional(p);
        if (text != null) mds[id] = text;
      } catch (e) {
        const code = errorCode(e);
        if (code !== 'DENIED' && code !== 'BAD_PATH' && code !== 'FILE_TOO_LARGE') throw e;
        unreachable.push({ path: p, code });
        unreadable.push(id);
      }
    });
    nextUnreadable = unreadable.sort();
    nextMds = mds;
  }

  if (myGen !== gen || !S.loaded) return false;
  if (activeWrites > 0) {
    deferredSync = mergeSyncOpts(deferredSync, mergeSyncOpts(effectiveOpts, { full: needsFull }));
    return false;
  }

  // Double-read snapshot stability validation: re-check lock and stamps after all reads.
  if (await isLockHeld()) {
    scheduleLockRetry(mergeSyncOpts(effectiveOpts, { full: needsFull }));
    return false;
  }
  if (myGen !== gen || !S.loaded) return false;

  const allCfgPaths = [...new Set([...oldCfgPaths, ...newCfgPaths])];
  const [postConfigStamps, postSkillStamps] = await Promise.all([
    readStampsMap(allCfgPaths),
    needsFull ? readStampsMap(Object.values(nextSkillPaths).sort()) : Promise.resolve(null),
  ]);
  if (myGen !== gen || !S.loaded) return false;
  if (activeWrites > 0) {
    deferredSync = mergeSyncOpts(deferredSync, mergeSyncOpts(effectiveOpts, { full: needsFull }));
    return false;
  }

  const cfgStable =
    oldCfgPaths.every((p) => postConfigStamps[p] === preConfigStamps[p]) &&
    addedCfgPaths.every((p) => postConfigStamps[p] === preNewRootStamps[p]);
  const skillsStable =
    !needsFull ||
    (nextSkillStamps != null &&
      postSkillStamps != null &&
      computeSkillsStamp(nextSkillPaths, postSkillStamps) === computeSkillsStamp(nextSkillPaths, nextSkillStamps));

  if (!cfgStable || !skillsStable) {
    scheduleLockRetry(mergeSyncOpts(effectiveOpts, { full: needsFull }));
    return false;
  }

  clearLockRetry();
  const nextCfgStamps: Record<string, string> = Object.create(null);
  for (const p of newCfgPaths) nextCfgStamps[p] = postConfigStamps[p];
  configStamps = nextCfgStamps;
  if (needsFull && postSkillStamps) {
    skillFileStamps = postSkillStamps;
  }
  lastDiskStamp = combineStamp(opencodeText, configStamps, nextSkillPaths, skillFileStamps);

  const configChanged = opencodeText !== S.opencodeText || bundlesText !== S.bundlesText;
  const changed =
    configChanged ||
    !sameArr(nextAllIds, S.allIds) ||
    !sameRec(nextSkillPaths, S.skillPaths) ||
    nextIncomplete !== S.incomplete ||
    !sameArr(nextUnreadable, S.unreadable) ||
    !sameUnreach(nextUnreachable, S.unreachable) ||
    !sameRec(nextMds, S.skillMds);

  if (!changed) return false;

  if (configChanged) {
    undoStack = [];
    const liveIds = new Set((nextState?.bundles ?? []).map((b) => b.id));
    S.createdBundles = S.createdBundles.filter((id) => liveIds.has(id));
  }

  const prevMds = S.skillMds;
  S.allIds = nextAllIds;
  S.skillRefs = nextSkillRefs;
  S.skillPaths = nextSkillPaths;
  S.unreachable = nextUnreachable;
  S.incomplete = nextIncomplete;
  S.unreadable = nextUnreadable;
  S.skillMds = nextMds;
  if (needsFull) fm.clear();
  S.opencodeText = opencodeText;
  S.bundlesText = bundlesText;
  S.state = nextState;

  if (S.descDraft && prevMds[S.descDraft.id] !== S.skillMds[S.descDraft.id]) {
    if (S.skillMds[S.descDraft.id] != null && meta(S.descDraft.id).description === S.descDraft.value) {
      S.descDraft = null;
    }
  }

  hooks.onExternalSync();
  return true;
}

/** Refresh panel state from disk without flashing the loading spinner or queuing a write. */
export async function syncFromDisk(opts?: SyncOpts): Promise<boolean> {
  if (!S.loaded) return false;
  if (activeWrites > 0) {
    deferredSync = mergeSyncOpts(deferredSync, opts);
    return false;
  }
  if (syncInFlight) {
    queuedSync = mergeSyncOpts(queuedSync, opts);
    return syncInFlight;
  }
  let active!: Promise<boolean>;
  active = (async () => {
    let changed = false;
    let cur: SyncOpts | undefined = opts;
    try {
      while (true) {
        if (activeWrites > 0) {
          deferredSync = mergeSyncOpts(deferredSync, cur);
          if (queuedSync) {
            deferredSync = mergeSyncOpts(deferredSync, queuedSync);
            queuedSync = null;
          }
          break;
        }
        if (await runSync(cur)) changed = true;
        if (!queuedSync || !S.loaded) break;
        cur = queuedSync;
        queuedSync = null;
      }
      return changed;
    } finally {
      if (syncInFlight === active) syncInFlight = null;
    }
  })();
  syncInFlight = active;
  return active;
}

/** Stat key files and sync from disk if anything changed externally. */
export async function checkDisk(): Promise<boolean> {
  if (!S.loaded || activeWrites > 0) return false;
  const stamp = await readDiskStamp();
  if (!S.loaded || activeWrites > 0 || stamp === lastDiskStamp) return false;
  return syncFromDisk({ full: true });
}

/** Subscribe to cross-frame sync pings, visibility/focus checks, and background polling. */
export function startSync(pollMs = 1500): () => void {
  const stopListen = listenChanges(({ full }) => {
    void syncFromDisk({ full }).catch(() => {});
  });
  const onCheck = () => {
    void checkDisk().catch(() => {});
  };
  const onVis = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') onCheck();
  };
  const timer = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') onCheck();
  }, pollMs);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  if (typeof window !== 'undefined') window.addEventListener('focus', onCheck);
  return () => {
    stopListen();
    clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    if (typeof window !== 'undefined') window.removeEventListener('focus', onCheck);
    clearLockRetry();
  };
}
