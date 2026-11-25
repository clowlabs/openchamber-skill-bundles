// Files, the CLI lock, the write queue and the frontmatter cache.
import type { HostClient } from '@openchamber/sdk';
import * as core from '../src/core.js';
import type { Bundle, ChangePlan, PlanError, State } from '../src/core.js';
import type { SkillRef } from '../src/discover.js';
import { skillRoots } from '../src/discover.js';
import seed from '../data/default-bundles.json';
import { discoverSkills, type Unreachable } from './discover';
import { broadcastChange, listenChanges } from './sync';
import { parseSkillRules, sameIds } from '../status/counts';
import { isVerifiedStamp, saveSkillIndexCache, statFileStamp } from '../status/cache';
import { panelIndexText, readPanelIndex, writePanelIndex, type IndexedMeta, type PanelIndex } from './index-cache';
import { errorCode, errText, isUnreadable, pool, readOptional as readOpt } from '../shared/panel/host';
import { createQueue } from '../shared/panel/queue';
import { createPanelLock, LockedError, statMtimeMs, type PanelLock } from '../shared/panel/panel-lock';
import { backupOnce, runTxn, type TxnWrite } from '../shared/panel/txn';
import { capText, fitList } from '../shared/panel/toast';
import { deriveHomeFromHost, homeFromDirs } from '../shared/panel/projects';
export { errText } from '../shared/panel/host';
export { homeFromDirs } from '../shared/panel/projects';

/** The host client; main sets it at boot, tests pass a fake. */
export let host: HostClient;
export function setHost(h: HostClient) {
  gen++;
  resetStamps();
  syncInFlight = null;
  postLoadStamps = null;
  queuedSync = null;
  deferredSync = null;
  clearLockRetry();
  S.activeDir = null;
  S.projectTexts = Object.create(null);
  lazy = new Map();
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
  /** False while painted from the stored index only: disk not read yet, so writes and syncs wait. */
  fresh: false,
  allIds: [] as string[],
  skillRefs: Object.create(null) as Record<string, SkillRef>,
  skillPaths: Object.create(null) as Record<string, string>,
  unreachable: [] as Unreachable[],
  /** Some folder could not be scanned (unreachable roots, entries or truncation; not file reads). */
  incomplete: false,
  /** Ids found but whose markdown could not be read. */
  unreadable: [] as string[],
  /** Null-prototype: a skill may be named `constructor`. Read through skillText(). */
  skillMds: Object.create(null) as Record<string, string>,
  opencodeText: '',
  bundlesText: null as string | null,
  /** User's home dir, derived once at load (undefined = unknown: textual collapsing only). */
  home: undefined as string | undefined,
  homeDerived: false,
  descDraft: null as { id: string; value: string } | null,
  /** Bundle ids created in this session (newest first) so pickers surface them first. */
  createdBundles: [] as string[],
  /** Active project directory from host.onDirectory, or null. */
  activeDir: null as string | null,
  /** Last read `<dir>/.opencode/opencode.json` contents keyed by config path. */
  projectTexts: Object.create(null) as Record<string, string | null>,
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

/** Effective home dir: derived from projects, or inferred from S.activeDir. */
export const effectiveHome = (): string | undefined =>
  S.home ?? (S.fresh ? undefined : previewHome) ?? (S.activeDir ? homeFromDirs([S.activeDir]) : undefined);
/** Home stored with the index: shapes only the preview paint, never a save (that derives its own). */
let previewHome: string | undefined;

/** `{ home }` for every core call that takes it. */
export const homeOpt = () => {
  const h = effectiveHome();
  return h ? { home: h } : {};
};

export function sameProjectDir(a: string, b: string): boolean {
  return core.sameProjectDir(a, b, homeOpt());
}

export function activeProjectDir(): string | null {
  return core.normalizeScopeDir(S.activeDir, homeOpt());
}

export function isBundleOnInScope(b: Bundle, projDir = activeProjectDir()): boolean {
  return core.isBundleActive(b, { projectDir: projDir, ...homeOpt() });
}

async function deriveHome() {
  await deriveHomeFromHost(host, S, (e) => {
    console.warn('skill-bundles: could not list projects to find the home folder', e);
  });
}

export const skillPath = (id: string) => S.skillPaths[id] ?? `${core.SKILLS_DIR}/${id}/SKILL.md`;
export const mode = (id: string) => (S.state ? core.effectiveMode(S.state, id) : 'off');
export const bundlesOf = (id: string) => (S.state ? S.state.bundles.filter((b) => b.skills.includes(id)) : []);

export function toastError(e: unknown, what: string) {
  void host.toast({ kind: 'error', message: `${what}: ${errText(e)}`, copy: true, dismiss: true });
}

// ---------- frontmatter cache ----------

type Meta = IndexedMeta;
const EMPTY: Meta = { description: '', autoinvoke: true, error: null };
const fm = new Map<string, Meta>();
/**
 * Skills whose SKILL.md text is not in memory but whose summary is known for the file at `stamp`
 * (from the stored index, re-verified by stat on every scan). Text is read on demand: ensureMds.
 */
type LazySkill = { path: string; stamp: string; meta: Meta };
let lazy = new Map<string, LazySkill>();

/** True when the skill has a SKILL.md, loaded or not. */
/** The skill's SKILL.md text if it is in memory (own keys only). */
export const skillText = (id: string): string | undefined => (Object.hasOwn(S.skillMds, id) ? S.skillMds[id] : undefined);
export const hasSkillMd = (id: string) => skillText(id) != null || lazy.has(id);

export function meta(id: string): Meta {
  const md = skillText(id);
  if (md == null) {
    const l = lazy.get(id);
    if (l) return l.meta;
  }
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
  lazy.delete(id);
}

/**
 * Read the SKILL.md text of the given lazy skills. An unreadable file is recorded the way a scan
 * records it (unreadable + unreachable); a vanished one is a StaleError. A sync that replaced the
 * entry meanwhile wins: its snapshot is newer than this read.
 */
async function ensureMds(ids: readonly string[]) {
  const todo = [...new Set(ids)].filter((id) => skillText(id) == null && lazy.has(id));
  await pool(todo, 8, async (id) => {
    const entry = lazy.get(id);
    if (!entry) return;
    // One host read per entry, shared by every caller asking while it runs.
    let read = inflight.get(entry);
    if (!read) {
      read = readLazy(id, entry);
      inflight.set(entry, read);
      void read.then(() => inflight.delete(entry), () => inflight.delete(entry));
    }
    await read;
  });
}
const inflight = new Map<LazySkill, Promise<void>>();

async function readLazy(id: string, entry: LazySkill) {
  let text: string | null;
  try {
    text = await readOptional(entry.path);
  } catch (e) {
    if (!isUnreadable(e)) throw e;
    if (lazy.get(id) !== entry) return;
    lazy.delete(id);
    fm.delete(id);
    S.unreachable = [...S.unreachable, { path: entry.path, code: errorCode(e) }];
    S.unreadable = [...S.unreadable, id].sort();
    return;
  }
  if (lazy.get(id) !== entry) return;
  if (text == null) throw new StaleError(`${entry.path} disappeared`);
  setMd(id, text);
}

/** Load one skill's SKILL.md for display (detail pane). True once its text is in memory. */
export async function loadSkillMd(id: string): Promise<boolean> {
  try {
    await ensureMds([id]);
  } catch {
    return false;
  }
  return skillText(id) != null;
}

/** Skills a plan for `state` reads: every non-built-in skill that is not off. */
const liveSkillIds = (state: State) => S.allIds.filter((id) => !core.isBuiltin(id) && core.effectiveMode(state, id) !== 'off');

/** What a skill scan (or the stored index) knows; installed into S only through applySkillSnapshot. */
type SkillSnapshot = {
  allIds: string[];
  skillRefs: Record<string, SkillRef>;
  skillPaths: Record<string, string>;
  unreachable: Unreachable[];
  incomplete: boolean;
  unreadable: string[];
  mds: Record<string, string>;
  lazy: Map<string, LazySkill>;
};

function applySkillSnapshot(snap: SkillSnapshot) {
  S.allIds = snap.allIds;
  S.skillRefs = snap.skillRefs;
  S.skillPaths = snap.skillPaths;
  S.unreachable = snap.unreachable;
  S.incomplete = snap.incomplete;
  S.unreadable = snap.unreadable;
  S.skillMds = snap.mds;
  lazy = snap.lazy;
  fm.clear();
}

// ---------- write queue: every write runs here, one at a time, none dropped ----------

let activeWrites = 0;
let writeSeq = 0;

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
/** A cache-painted boot still reading the disk; writes wait for it. */
let hydrating: Promise<void> | null = null;

export const enqueue: typeof queue.enqueue = (task) => {
  writeSeq++;
  return queue.enqueue(async () => {
    if (hydrating) await hydrating.catch(() => {});
    // Never plan a write on index data: SKILL.md texts and stamps come only from the disk load.
    if (!S.fresh) throw new Error('skills are not loaded from disk yet');
    if (syncInFlight) await syncInFlight.catch(() => false);
    activeWrites++;
    try {
      await task();
    } finally {
      activeWrites--;
    }
  });
};
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
let syncSeq = 0;
let lastDiskStamp: string | null = null;
let configStamps: Record<string, string> = Object.create(null);
let skillFileStamps: Record<string, string> = Object.create(null);
let syncInFlight: Promise<boolean> | null = null;
let postLoadStamps: Promise<void> | null = null;
let queuedSync: SyncOpts | null = null;
let deferredSync: SyncOpts | null = null;
let lockRetryTimer: ReturnType<typeof setTimeout> | null = null;
let lockRetryDeadline = 0;
let lockRetryOpts: SyncOpts | null = null;
let pendingFullSync = false;

function resetStamps() {
  lastDiskStamp = null;
  configStamps = Object.create(null);
  skillFileStamps = Object.create(null);
  pendingFullSync = false;
}

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

const statStamp = (p: string): Promise<string> => statFileStamp(host, p);

function projectConfigPaths(state: State | null): string[] {
  const dirs = new Set<string>(state ? core.projectTargets(state, homeOpt()) : []);
  const activeDir = activeProjectDir();
  if (activeDir) dirs.add(activeDir);
  return [...dirs].sort().map(core.projectConfigPath);
}

function configStampPaths(opencodeText: string | null, state: State | null = S.state): string[] {
  return [core.BUNDLES_PATH, core.OPENCODE_PATH, core.LOCK_PATH, ...skillRoots(opencodeText), ...projectConfigPaths(state)];
}

async function readStampsMap(paths: readonly string[], preset?: Record<string, string>): Promise<Record<string, string>> {
  const unique = [...new Set(paths)];
  const out: Record<string, string> = Object.create(null);
  const toStat: string[] = [];
  for (const p of unique) {
    if (preset && Object.hasOwn(preset, p)) out[p] = preset[p];
    else toStat.push(p);
  }
  await pool(toStat, 32, async (p) => {
    out[p] = await statStamp(p);
  });
  return out;
}

async function readProjectTextsSafe(paths: readonly string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = Object.create(null);
  await pool([...new Set(paths)], 16, async (p) => {
    try {
      out[p] = await readOptional(p);
    } catch (e) {
      if (!isUnreadable(e)) throw e;
      // Leave `p` omitted (undefined) to distinguish unreadable from missing-on-disk (null).
    }
  });
  return out;
}

function computeConfigStamp(
  opencodeText: string | null,
  stamps: Record<string, string>,
  state: State | null = S.state,
): string {
  return configStampPaths(opencodeText, state).map((p) => `${p}=${stamps[p] ?? ''}`).join('|');
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
  state: State | null = S.state,
): string {
  return `${computeConfigStamp(opencodeText, cfgStamps, state)}||${computeSkillsStamp(skillPaths, skStamps)}`;
}

async function readReleasedLockStamp(): Promise<string> {
  const lockText = await readOptional(core.LOCK_PATH);
  if (lockText !== core.RELEASED_MARKER) return '';
  return statStamp(core.LOCK_PATH);
}

async function recordOwnWrite(lockedCfgStamps: Record<string, string>, writtenSkillStamps: Record<string, string>) {
  if (lastDiskStamp === null) return;
  try {
    const lockStamp = await readReleasedLockStamp();
    configStamps = { ...configStamps, ...lockedCfgStamps, [core.LOCK_PATH]: lockStamp };
    for (const [p, st] of Object.entries(writtenSkillStamps)) skillFileStamps[p] = st;
    lastDiskStamp = combineStamp(S.opencodeText, configStamps, S.skillPaths, skillFileStamps);
  } catch {
    // Best effort: checkDisk will resync if stat failed.
  }
}

type SkillScanReuse = {
  prevPaths: Record<string, string>;
  prevMds: Record<string, string>;
  prevUnreadable: readonly string[];
  prevStamps: Record<string, string>;
};

/** `known`: lazy skills a matching stat stamp lets this scan keep unread. */
async function scanSkills(opencodeText: string, reuse?: SkillScanReuse, known?: ReadonlyMap<string, LazySkill>) {
  const { skills, unreachable } = await discoverSkills(host, opencodeText);
  const discoveredIds = Object.keys(skills);
  const allIds = [...new Set([...discoveredIds, ...core.BUILTIN_SKILLS])].sort();
  const skillPaths: Record<string, string> = Object.create(null);
  for (const id of discoveredIds) skillPaths[id] = skills[id].path;
  const sortedSkillPaths = Object.values(skillPaths).sort();
  const skillStamps: Record<string, string> = reuse ? await readStampsMap(sortedSkillPaths) : Object.create(null);

  const incomplete = unreachable.length > 0;
  const unreadable: string[] = [];
  const mds: Record<string, string> = Object.create(null);
  const nextLazy = new Map<string, LazySkill>();
  const unreadablePrev = reuse ? new Set(reuse.prevUnreadable) : null;
  await pool(discoveredIds, 32, async (id) => {
    const p = skillPaths[id];
    const st = reuse ? skillStamps[p] : await statStamp(p);
    if (!reuse) skillStamps[p] = st;
    if (
      reuse &&
      unreadablePrev &&
      reuse.prevPaths[id] === p &&
      !unreadablePrev.has(id) &&
      Object.hasOwn(reuse.prevMds, id) &&
      st != null &&
      reuse.prevStamps[p] === st
    ) {
      mds[id] = reuse.prevMds[id];
      return;
    }
    const k = known?.get(id);
    if (k && k.path === p && st === k.stamp && isVerifiedStamp(st)) {
      nextLazy.set(id, k);
      return;
    }
    try {
      const text = await readOptional(p);
      if (text != null) mds[id] = text;
    } catch (e) {
      // Listed but unreadable: keep the id (its allow rule still applies), leave the file alone.
      if (!isUnreadable(e)) throw e;
      unreachable.push({ path: p, code: errorCode(e) });
      unreadable.push(id);
    }
  });
  unreadable.sort();
  return {
    allIds,
    skillRefs: skills,
    skillPaths,
    sortedSkillPaths,
    unreachable,
    incomplete,
    unreadable,
    mds,
    lazy: nextLazy,
    skillStamps,
  };
}

// ---------- load ----------

const MAX_UNDO = 30;
let undoStack: { state: State; label: string }[] = [];

export const canUndo = () => S.loaded && undoStack.length > 0;
export const undoDepth = () => undoStack.length;
export const undoLabel = () => undoStack.at(-1)?.label ?? null;

export type ChangeOpts = { label?: string; undoable?: boolean | 'clear' };

// ---------- stored index (cache-first boot) ----------

/** Text of the index known to be stored (read at boot or written successfully). */
let lastIndexText: string | null = null;
/** Index writes run one at a time, so an older write can never land after a newer one. */
let indexWrites: Promise<void> = Promise.resolve();

/** Null while any SKILL.md stamp is unverified: a summary must be pinned to the file it describes. */
function buildPanelIndex(roots: readonly string[]): PanelIndex | null {
  const skills: PanelIndex['skills'] = [];
  for (const r of Object.values(S.skillRefs).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (S.unreadable.includes(r.id)) continue; // no summary to pin; retried by every scan
    const stamp = skillFileStamps[r.path];
    if (!isVerifiedStamp(stamp)) return null;
    const m = meta(r.id);
    skills.push({ id: r.id, root: r.root, path: r.path, dir: r.dir, description: m.description, autoinvoke: m.autoinvoke, error: m.error, stamp });
  }
  const home = effectiveHome();
  return {
    v: 1,
    rootsKey: JSON.stringify(roots),
    ...(home ? { home } : {}),
    allIds: [...S.allIds],
    skills,
    unreachable: S.unreachable.map((u) => ({ path: u.path, code: u.code })),
    unreadable: [...S.unreadable],
  };
}

/** Store what the next boot paints first; skipped when unchanged, incomplete or too large. */
function savePanelIndex(roots: readonly string[]) {
  if (S.incomplete || !S.fresh) return;
  const index = buildPanelIndex(roots);
  if (!index) return;
  const h = host;
  indexWrites = indexWrites.then(async () => {
    const text = panelIndexText(index);
    if (text === lastIndexText) return;
    try {
      if (await writePanelIndex(h, index)) lastIndexText = text;
    } catch (e) {
      console.warn('skill-bundles: could not store the skill index; the next open loads from disk', e);
    }
  });
}

/** Paint state from the stored index plus the two config files: no folder walk, no SKILL.md. */
async function paintFromIndex(): Promise<boolean> {
  try {
    const [index, opencodeText, bundlesText] = await Promise.all([
      readPanelIndex(host),
      host.readFile(core.OPENCODE_PATH).then((r) => r.content),
      readOptional(core.BUNDLES_PATH),
    ]);
    if (!index || index.rootsKey !== JSON.stringify(skillRoots(opencodeText))) return false;
    previewHome = index.home;
    const home = S.home ?? index.home;
    const state = bundlesText == null ? null : core.parseBundles(bundlesText, home ? { home } : homeOpt());
    const refs: Record<string, SkillRef> = Object.create(null);
    const paths: Record<string, string> = Object.create(null);
    const known = new Map<string, LazySkill>();
    for (const s of index.skills) {
      refs[s.id] = { id: s.id, root: s.root, path: s.path, dir: s.dir };
      paths[s.id] = s.path;
      known.set(s.id, { path: s.path, stamp: s.stamp, meta: { description: s.description, autoinvoke: s.autoinvoke, error: s.error } });
    }
    applySkillSnapshot({
      allIds: index.allIds,
      skillRefs: refs,
      skillPaths: paths,
      unreachable: index.unreachable,
      incomplete: false, // only complete scans are stored
      unreadable: index.unreadable,
      mds: Object.create(null),
      lazy: known,
    });
    S.opencodeText = opencodeText;
    S.bundlesText = bundlesText;
    S.state = state;
    S.projectTexts = Object.create(null);
    S.fresh = false;
    S.loaded = true;
    lastIndexText = panelIndexText(index);
    return true;
  } catch {
    return false; // the disk load reports real errors
  }
}

/**
 * Load everything from disk. With `cache` on a first load, paint from the stored index first
 * (onLoaded fires twice: index, then disk); writes and syncs wait for the disk.
 */
export async function load(onLoaded?: () => void, opts?: { cache?: boolean }) {
  if (!opts?.cache || S.loaded) return loadFromDisk(onLoaded);
  const myGen = gen;
  const run = (async () => {
    if ((await paintFromIndex()) && myGen === gen) onLoaded?.();
    await loadFromDisk(onLoaded);
  })();
  hydrating = run;
  try {
    await run;
  } finally {
    if (hydrating === run) hydrating = null;
  }
}

async function loadFromDisk(onLoaded?: () => void) {
  // The indexed home is unverified: from here on only a derived home may shape parsed state.
  previewHome = undefined;
  const myGen = ++gen;
  const loadWriteSeq = writeSeq;
  const loadSyncSeq = syncSeq;
  resetStamps();
  queuedSync = null;
  deferredSync = null;
  clearLockRetry();
  undoStack = [];
  const homeP = deriveHome();
  const preConfigStamps = await readStampsMap([core.BUNDLES_PATH, core.OPENCODE_PATH, core.LOCK_PATH]);
  const [opencodeText, bundlesText] = await Promise.all([
    host.readFile(core.OPENCODE_PATH).then((r) => r.content),
    readOptional(core.BUNDLES_PATH),
    homeP,
  ]);
  const roots = skillRoots(opencodeText);
  const nextState = bundlesText == null ? null : core.parseBundles(bundlesText, homeOpt());
  const projPaths = projectConfigPaths(nextState);
  const [[preRootStamps, scan], [preProjStamps, projTexts]] = await Promise.all([
    (async () => {
      const rootStamps = await readStampsMap(roots);
      return [rootStamps, await scanSkills(opencodeText, undefined, lazy)] as const;
    })(),
    (async () => {
      const pStamps = await readStampsMap(projPaths);
      return [pStamps, await readProjectTextsSafe(projPaths)] as const;
    })(),
  ]);
  applySkillSnapshot(scan);
  S.opencodeText = opencodeText;
  S.bundlesText = bundlesText;
  S.state = nextState;
  S.projectTexts = projTexts;
  S.loaded = true;
  S.fresh = true;
  if (myGen === gen && writeSeq === loadWriteSeq && syncSeq === loadSyncSeq) {
    let activePost!: Promise<void>;
    activePost = (async () => {
      try {
        const lockCheck = await checkLock();
        const [postConfigStamps, postSkillStamps] = await Promise.all([
          readStampsMap(
            [core.BUNDLES_PATH, core.OPENCODE_PATH, core.LOCK_PATH, ...roots, ...projPaths],
            lockCheck.lockStamp !== null ? { [core.LOCK_PATH]: lockCheck.lockStamp } : undefined,
          ),
          readStampsMap(scan.sortedSkillPaths),
        ]);
        if (myGen === gen && writeSeq === loadWriteSeq && syncSeq === loadSyncSeq) {
          const nextSkillStamps: Record<string, string> = Object.create(null);
          let skillsStable = true;
          for (const p of scan.sortedSkillPaths) {
            if (scan.skillStamps[p] === postSkillStamps[p]) {
              nextSkillStamps[p] = postSkillStamps[p];
            } else {
              skillsStable = false;
            }
          }
          skillFileStamps = nextSkillStamps;
          const cfgStable =
            !lockCheck.held &&
            [core.BUNDLES_PATH, core.OPENCODE_PATH, core.LOCK_PATH].every((p) => preConfigStamps[p] === postConfigStamps[p]) &&
            roots.every((r) => preRootStamps[r] === postConfigStamps[r]) &&
            projPaths.every((p) => preProjStamps[p] === postConfigStamps[p]);
          if (cfgStable && skillsStable) {
            configStamps = postConfigStamps;
            lastDiskStamp = combineStamp(opencodeText, postConfigStamps, scan.skillPaths, nextSkillStamps, nextState);
            if (!scan.incomplete) {
              const home = effectiveHome();
              void saveSkillIndexCache(host, {
                roots,
                rootsKey: JSON.stringify(roots),
                rootMap: postConfigStamps,
                allIds: scan.allIds,
                home,
              });
              savePanelIndex(roots);
            }
          } else {
            configStamps = Object.create(null);
            lastDiskStamp = null;
          }
        }
      } catch {
        if (myGen === gen && writeSeq === loadWriteSeq && syncSeq === loadSyncSeq) resetStamps();
      } finally {
        if (postLoadStamps === activePost) postLoadStamps = null;
      }
    })();
    postLoadStamps = activePost;
  }
  if (myGen === gen) onLoaded?.();
  if (postLoadStamps) await postLoadStamps;
}

// ---------- save ----------

type ProjectTexts = Record<string, string | null>;

function planErrorWhere(pe: Partial<PlanError>): string {
  if (pe.file === 'skill') return pe.id ? skillPath(pe.id) : 'SKILL.md';
  if (pe.file === 'opencode') return 'opencode.json';
  if (pe.file === 'project') return pe.id ? core.projectConfigPath(pe.id) : 'project opencode.json';
  return '';
}

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
    const where = planErrorWhere(e as Partial<PlanError>);
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
    if (fresh !== skillText(id)) { setMd(id, fresh); changed = true; }
  });
  return changed;
}

function sameProjectRules(prev: State, next: State, dir: string): boolean {
  const hOpt = homeOpt();
  if (!core.projectTargets(prev, hOpt).includes(dir)) return false;
  const a = core.projectRuleSet(prev, dir, hOpt);
  const b = core.projectRuleSet(next, dir, hOpt);
  return sameIds(a.allowIds, b.allowIds) && sameIds(a.denyIds, b.denyIds);
}

/** Text of `<dir>/.opencode/opencode.json` for every dir the next state touches (missing → null). */
async function readProjectTexts(next: State): Promise<{ texts: ProjectTexts; skippedUnreadable: Set<string> }> {
  const texts: ProjectTexts = {};
  const skippedUnreadable = new Set<string>();
  await pool(core.projectTargets(next, homeOpt()), 8, async (dir) => {
    try {
      texts[dir] = await readOptional(core.projectConfigPath(dir));
    } catch (e) {
      if (isUnreadable(e) && S.state != null && sameProjectRules(S.state, next, dir)) {
        texts[dir] = null;
        skippedUnreadable.add(dir);
        return;
      }
      throw e;
    }
  });
  return { texts, skippedUnreadable };
}

async function save(next: State) {
  // The plan checks every live skill's frontmatter, so their texts must be in memory.
  const live = liveSkillIds(next);
  await ensureMds(live);
  // Fail closed: the planner silently skips a skill with no text unless it is marked unreadable.
  const blind = live.find((id) => skillText(id) == null && !S.unreadable.includes(id));
  if (blind) throw new StaleError(`${skillPath(blind)} is not loaded`);
  // Refuse early, before taking the lock (project files read now; re-read under the lock).
  const { texts: projectTexts, skippedUnreadable } = await readProjectTexts(next);
  const first = planFor(next, projectTexts);
  const { writtenSkillIds, lockedCfgStamps, lockedSkillStamps } = await withLock(() =>
    saveLocked(next, first, projectTexts, skippedUnreadable),
  );
  await recordOwnWrite(lockedCfgStamps, lockedSkillStamps);
  broadcastChange(writtenSkillIds.length > 0 ? { full: true } : undefined);
}

// Order: core.PUBLISH_ORDER (SKILL.md, project files, opencode.json, skill-bundles.json last).
async function saveLocked(next: State, first: ChangePlan, firstTexts: ProjectTexts, firstSkipped: Set<string>) {
  // Bundle files changed under us: abort and reload (the caller handles StaleError).
  const [onDisk, bundlesOnDisk, { texts: projectTexts, skippedUnreadable }] = await Promise.all([
    host.readFile(core.OPENCODE_PATH), readOptional(core.BUNDLES_PATH), readProjectTexts(next),
  ]);
  if (onDisk.content !== S.opencodeText) throw new StaleError('opencode.json changed on disk');
  if (bundlesOnDisk !== S.bundlesText) throw new StaleError('skill-bundles.json changed on disk');

  // SKILL.md and project-file changes merge: core only splices skill rules, so plan on the
  // text read under the lock.
  let plan = sameRec(firstTexts, projectTexts) && firstSkipped.size === skippedUnreadable.size ? first : planFor(next, projectTexts);
  for (let i = 0; i < 5 && (await refreshSkillMds(skillIds(plan))); i++) plan = planFor(next, projectTexts);

  // plan.writes is in core.PUBLISH_ORDER. Project files are shared with the user: re-read and
  // merged right before writing, restored on failure only if still exactly what we wrote.
  const plannedWrites = plan.writes.filter((w) => !(w.kind === 'project' && w.dir && skippedUnreadable.has(w.dir)));
  const writes: TxnWrite[] = plannedWrites.map((w) => ({
    path: w.path,
    before: w.before,
    after: w.after,
    ...(w.kind === 'opencode' ? {
      beforeWrite: () => backupOnce(host, core.OPENCODE_PATH.replace(/[^/]+$/, core.backupName()), S.opencodeText),
    } : {}),
    ...(w.kind === 'project' ? {
      shared: true,
      merge: (fresh: string | null) => {
        const { allowIds, denyIds } = projectSkillRules(w.after);
        return core.applyProjectPermissions(fresh, allowIds, { denyIds });
      },
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
  const readOrWrittenProjectPaths: string[] = [];
  const writtenByPath = new Map<string, string>();
  for (const w of plannedWrites) {
    if (w.kind === 'skill' && w.id) setMd(w.id, w.after);
    else if (w.kind === 'opencode') S.opencodeText = w.after;
    else if (w.kind === 'bundles') S.bundlesText = w.after;
    else if (w.kind === 'project') writtenByPath.set(w.path, w.after);
  }
  for (const dir of Object.keys(projectTexts)) {
    if (skippedUnreadable.has(dir)) continue;
    const p = core.projectConfigPath(dir);
    S.projectTexts[p] = writtenByPath.has(p) ? (writtenByPath.get(p) ?? null) : projectTexts[dir];
    readOrWrittenProjectPaths.push(p);
  }
  S.state = plan.state ?? next;
  toastSkipped(plan.skipped);
  const writtenSkillIds = skillIds(plan);
  const writtenPaths = [...new Set(writtenSkillIds.map((id) => skillPath(id)))];
  const [lockedCfgStamps, lockedSkillStamps] = await Promise.all([
    readStampsMap([core.BUNDLES_PATH, core.OPENCODE_PATH, ...skillRoots(S.opencodeText), ...readOrWrittenProjectPaths]),
    readStampsMap(writtenPaths),
  ]);
  return { writtenSkillIds, lockedCfgStamps, lockedSkillStamps };
}

/** Skill allow/deny ids from a project file text we generated. */
function projectSkillRules(text: string): { allowIds: string[]; denyIds: string[] } {
  const allowIds: string[] = [];
  const denyIds: string[] = [];
  for (const r of parseSkillRules(text) ?? []) {
    if (r.effect === 'deny') denyIds.push(r.resource);
    else allowIds.push(r.resource);
  }
  return { allowIds, denyIds };
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
  commit((s) => {
    const b = s.bundles.find((x) => x.id === bundleId);
    if (!b) throw new Error(`Unknown bundle "${bundleId}"`);
    return core.setBundleEnabled(s, bundleId, on ?? !b.enabled);
  }, onAccepted, { label: 'toggle bundle' });
}

/** Turn a bundle on or off in the active project scope (or globally when no project is open). */
export function toggleBundleInScope(bundleId: string, on?: boolean, onAccepted?: () => void) {
  const scope = { projectDir: activeProjectDir(), ...homeOpt() };
  commit((s) => {
    const b = s.bundles.find((x) => x.id === bundleId);
    if (!b) throw new Error(`Unknown bundle "${bundleId}"`);
    return core.setBundleInScope(s, bundleId, on ?? !core.isBundleActive(b, scope), scope);
  }, onAccepted, { label: 'toggle bundle' });
}

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
    if (!hasSkillMd(id)) return;
    const apply = (md: string) => {
      try { return core.setDescription(md, text); } catch (e) { throw new RefusedError(errText(e)); }
    };
    try {
      if (S.incomplete) throw new RefusedError(`some skill folders could not be read, so it is unclear which SKILL.md ${id} uses`);
      await ensureMds([id]);
      const md = skillText(id);
      if (md == null) throw new RefusedError(`${skillPath(id)} could not be read`);
      apply(md); // refuse early, before taking the lock
      const p = skillPath(id);
      let lockedSkillStamp = '';
      let written = false;
      await withLock(async () => {
        // Apply to the file as it is now, so a CLI mode change since load survives.
        const fresh = await readOptional(p);
        if (fresh == null) throw new StaleError(`${p} disappeared`);
        if (fresh !== skillText(id)) setMd(id, fresh);
        const next = apply(fresh);
        if (next !== fresh) {
          await host.writeFile(p, next);
          written = true;
          lockedSkillStamp = await statStamp(p);
        }
        setMd(id, next);
      });
      await recordOwnWrite({}, written ? { [p]: lockedSkillStamp } : {});
      if (written) broadcastChange({ full: true });
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

function sameRec<V>(a: Record<string, V>, b: Record<string, V>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

const sameLazy = (a: ReadonlyMap<string, LazySkill>, b: ReadonlyMap<string, LazySkill>) =>
  a.size === b.size && [...a].every(([id, x]) => b.get(id)?.stamp === x.stamp && b.get(id)?.path === x.path);

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

async function checkLock(): Promise<{ held: boolean; lockStamp: string | null }> {
  const lockText = await readOptional(core.LOCK_PATH);
  if (lockText == null) return { held: false, lockStamp: await statStamp(core.LOCK_PATH) };
  const info = core.parseLock(lockText);
  if (info.kind === 'released') return { held: false, lockStamp: null };
  let st: { kind: string; size: number; mtime: number };
  let lockStamp: string;
  try {
    st = await host.stat(core.LOCK_PATH);
    lockStamp = `${st.kind}:${st.size}:${st.mtime}`;
  } catch (e) {
    st = { kind: 'missing', size: 0, mtime: 0 };
    lockStamp = `err:${errorCode(e) || 'ERR'}`;
  }
  const held = core.classifyLock(info, { now: Date.now(), mtimeMs: statMtimeMs(st) }) === 'held';
  return { held, lockStamp };
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
  syncSeq++;
  const myGen = gen;
  const interrupted = (defer?: SyncOpts): boolean => {
    if (myGen !== gen || !S.loaded) return true;
    if (activeWrites > 0) {
      if (defer) deferredSync = mergeSyncOpts(deferredSync, defer);
      return true;
    }
    return false;
  };
  if (interrupted()) return false;

  const effectiveOpts = mergeSyncOpts(lockRetryOpts, opts);
  if (lockRetryTimer != null) {
    clearTimeout(lockRetryTimer);
    lockRetryTimer = null;
  }

  const preLock = await checkLock();
  if (preLock.held) {
    scheduleLockRetry(effectiveOpts);
    return false;
  }
  if (interrupted()) return false;

  const oldCfgPaths = configStampPaths(S.opencodeText, S.state);
  const preConfigStamps = await readStampsMap(
    oldCfgPaths,
    preLock.lockStamp !== null ? { [core.LOCK_PATH]: preLock.lockStamp } : undefined,
  );
  if (interrupted()) return false;

  const [opencodeText, bundlesText] = await Promise.all([
    host.readFile(core.OPENCODE_PATH).then((r) => r.content),
    readOptional(core.BUNDLES_PATH),
  ]);
  if (interrupted(effectiveOpts)) return false;

  let nextState: State | null = null;
  if (bundlesText != null) {
    try {
      nextState = core.parseBundles(bundlesText, homeOpt());
    } catch (err) {
      const errLock = await checkLock();
      if (!errLock.held && !interrupted()) {
        const sortedPaths = Object.values(S.skillPaths).sort();
        const readSkillStamps = Boolean(effectiveOpts.full) || (sortedPaths.length > 0 && Object.keys(skillFileStamps).length === 0);
        const [postCfgStamps, postErrSkillStamps] = await Promise.all([
          readStampsMap(oldCfgPaths, errLock.lockStamp !== null ? { [core.LOCK_PATH]: errLock.lockStamp } : undefined),
          readSkillStamps ? readStampsMap(sortedPaths) : Promise.resolve(null),
        ]);
        if (!interrupted() && oldCfgPaths.every((p) => postCfgStamps[p] === preConfigStamps[p])) {
          const rootsDiffered =
            JSON.stringify(skillRoots(opencodeText)) !== JSON.stringify(skillRoots(S.opencodeText)) ||
            skillRoots(S.opencodeText).some((r) => postCfgStamps[r] !== configStamps[r]);
          const skillsDiffered =
            postErrSkillStamps != null &&
            computeSkillsStamp(S.skillPaths, postErrSkillStamps) !== computeSkillsStamp(S.skillPaths, skillFileStamps);
          if (effectiveOpts.full || rootsDiffered || skillsDiffered) pendingFullSync = true;
          clearLockRetry();
          configStamps = postCfgStamps;
          // Record the seen stamps so `checkDisk()` won't retry every 1.5s while broken; `pendingFullSync` bypasses `scanSkills` cache on recovery.
          if (postErrSkillStamps) skillFileStamps = postErrSkillStamps;
          lastDiskStamp = combineStamp(S.opencodeText, configStamps, S.skillPaths, skillFileStamps, S.state);
          console.warn('skill-bundles: failed to parse skill-bundles.json during sync', err);
          return false;
        }
      }
      if (!interrupted()) scheduleLockRetry(effectiveOpts);
      return false;
    }
  }

  const newCfgPaths = configStampPaths(opencodeText, nextState);
  const addedCfgPaths = newCfgPaths.filter((p) => !oldCfgPaths.includes(p));
  const preNewRootStamps = addedCfgPaths.length ? await readStampsMap(addedCfgPaths) : (Object.create(null) as Record<string, string>);
  if (interrupted(effectiveOpts)) return false;

  const nextProjectTexts = await readProjectTextsSafe(projectConfigPaths(nextState));
  if (interrupted(effectiveOpts)) return false;

  const needsFull =
    Boolean(effectiveOpts.full) ||
    pendingFullSync ||
    JSON.stringify(skillRoots(opencodeText)) !== JSON.stringify(skillRoots(S.opencodeText)) ||
    hasUnknownSkill(nextState, S.allIds);
  const fullSyncOpts = mergeSyncOpts(effectiveOpts, { full: needsFull });

  let nextAllIds = S.allIds;
  let nextSkillRefs = S.skillRefs;
  let nextSkillPaths = S.skillPaths;
  let nextIncomplete = S.incomplete;
  let nextUnreachable = S.unreachable;
  let nextUnreadable = S.unreadable;
  let nextMds = S.skillMds;
  let nextLazy = lazy;
  let nextSkillStamps: Record<string, string> | null = null;

  if (needsFull) {
    const scan = await scanSkills(
      opencodeText,
      pendingFullSync
        ? undefined
        : {
            prevPaths: S.skillPaths,
            prevMds: S.skillMds,
            prevUnreadable: S.unreadable,
            prevStamps: skillFileStamps,
          },
      pendingFullSync ? undefined : lazy,
    );
    if (interrupted(fullSyncOpts)) return false;
    nextAllIds = scan.allIds;
    nextSkillRefs = scan.skillRefs;
    nextSkillPaths = scan.skillPaths;
    nextIncomplete = scan.incomplete;
    nextUnreachable = scan.unreachable;
    nextUnreadable = scan.unreadable;
    nextMds = scan.mds;
    nextLazy = scan.lazy;
    nextSkillStamps = scan.skillStamps;
  }

  // Double-read snapshot stability validation: re-check lock and stamps after all reads.
  const postLock = await checkLock();
  if (postLock.held) {
    scheduleLockRetry(fullSyncOpts);
    return false;
  }
  if (interrupted(fullSyncOpts)) return false;

  const allCfgPaths = [...new Set([...oldCfgPaths, ...newCfgPaths])];
  const [postConfigStamps, postSkillStamps] = await Promise.all([
    readStampsMap(allCfgPaths, postLock.lockStamp !== null ? { [core.LOCK_PATH]: postLock.lockStamp } : undefined),
    needsFull ? readStampsMap(Object.values(nextSkillPaths).sort()) : Promise.resolve(null),
  ]);
  if (interrupted(fullSyncOpts)) return false;

  const cfgStable =
    oldCfgPaths.every((p) => postConfigStamps[p] === preConfigStamps[p]) &&
    addedCfgPaths.every((p) => postConfigStamps[p] === preNewRootStamps[p]);
  const skillsStable =
    !needsFull ||
    (nextSkillStamps != null &&
      postSkillStamps != null &&
      computeSkillsStamp(nextSkillPaths, postSkillStamps) === computeSkillsStamp(nextSkillPaths, nextSkillStamps));

  if (!cfgStable || !skillsStable) {
    scheduleLockRetry(fullSyncOpts);
    return false;
  }

  clearLockRetry();
  const nextCfgStamps: Record<string, string> = Object.create(null);
  for (const p of newCfgPaths) nextCfgStamps[p] = postConfigStamps[p];
  configStamps = nextCfgStamps;
  if (needsFull && !nextIncomplete) {
    const roots = skillRoots(opencodeText);
    const home = effectiveHome();
    void saveSkillIndexCache(host, {
      roots,
      rootsKey: JSON.stringify(roots),
      rootMap: nextCfgStamps,
      allIds: nextAllIds,
      home,
    });
  }
  if (needsFull && postSkillStamps) {
    skillFileStamps = postSkillStamps;
    pendingFullSync = false;
  }
  lastDiskStamp = combineStamp(opencodeText, configStamps, nextSkillPaths, skillFileStamps, nextState);

  if (needsFull) {
    // The scan kept these unread on the entry it saw. An on-demand read that settled since (text
    // loaded, or recorded unreadable) describes that same file later, so it wins over the scan.
    for (const [id, k] of [...nextLazy]) {
      if (lazy.has(id)) continue; // untouched, or replaced by a newer scan: keep the scan's view
      const text = skillText(id);
      if (text != null) {
        nextMds[id] = text;
        nextLazy.delete(id);
      } else if (S.unreadable.includes(id)) {
        nextLazy.delete(id);
        nextUnreadable = [...nextUnreadable, id].sort();
        nextUnreachable = [...nextUnreachable, ...S.unreachable.filter((u) => u.path === k.path)];
      }
    }
  }

  const configChanged = opencodeText !== S.opencodeText || bundlesText !== S.bundlesText;
  const projectChanged = !sameRec(nextProjectTexts, S.projectTexts);
  // Skill fields count only when this sync scanned them. A config-only sync holds references
  // captured before its awaits; on-demand reads may have updated S since (an unreadable result,
  // a loaded text), and copying the old values back would erase that.
  const changed =
    configChanged ||
    projectChanged ||
    (needsFull && (
      !sameIds(nextAllIds, S.allIds) ||
      !sameRec(nextSkillPaths, S.skillPaths) ||
      nextIncomplete !== S.incomplete ||
      !sameIds(nextUnreadable, S.unreadable) ||
      !sameUnreach(nextUnreachable, S.unreachable) ||
      !sameRec(nextMds, S.skillMds) ||
      !sameLazy(nextLazy, lazy)
    ));

  if (!changed) {
    // Stamps may still be newer (a touched file, same text): keep the stored index pinned to them.
    if (needsFull) savePanelIndex(skillRoots(opencodeText));
    return false;
  }

  if (configChanged) {
    undoStack = [];
    const liveIds = new Set((nextState?.bundles ?? []).map((b) => b.id));
    S.createdBundles = S.createdBundles.filter((id) => liveIds.has(id));
  }

  const prevMds = S.skillMds;
  if (needsFull) {
    applySkillSnapshot({
      allIds: nextAllIds,
      skillRefs: nextSkillRefs,
      skillPaths: nextSkillPaths,
      unreachable: nextUnreachable,
      incomplete: nextIncomplete,
      unreadable: nextUnreadable,
      mds: nextMds,
      lazy: nextLazy,
    });
  }
  S.opencodeText = opencodeText;
  S.bundlesText = bundlesText;
  S.state = nextState;
  S.projectTexts = nextProjectTexts;
  if (needsFull) savePanelIndex(skillRoots(opencodeText));

  const draftId = S.descDraft?.id;
  if (S.descDraft && draftId != null && (Object.hasOwn(prevMds, draftId) ? prevMds[draftId] : undefined) !== skillText(draftId)) {
    if (skillText(draftId) != null && meta(S.descDraft.id).description === S.descDraft.value) {
      S.descDraft = null;
    }
  }

  hooks.onExternalSync();
  return true;
}

/** Refresh panel state from disk without flashing the loading spinner or queuing a write. */
export async function syncFromDisk(opts?: SyncOpts): Promise<boolean> {
  if (!S.loaded || !S.fresh) return false;
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
export async function checkDisk(opts?: { includeSkills?: boolean }): Promise<boolean> {
  if (postLoadStamps) await postLoadStamps;
  if (!S.loaded || !S.fresh || activeWrites > 0) return false;
  if (syncInFlight) return syncInFlight;
  if (lastDiskStamp === null) return syncFromDisk({ full: true });

  const includeSkills = opts?.includeSkills ?? true;
  const cfgPaths = configStampPaths(S.opencodeText, S.state);
  const roots = skillRoots(S.opencodeText);
  const sortedSkills = includeSkills ? Object.values(S.skillPaths).sort() : null;

  const [freshCfgStamps, freshSkillStamps] = await Promise.all([
    readStampsMap(cfgPaths),
    sortedSkills ? readStampsMap(sortedSkills) : Promise.resolve(null),
  ]);
  if (!S.loaded || activeWrites > 0) return false;
  if (syncInFlight) return syncInFlight;
  if (lastDiskStamp === null) return syncFromDisk({ full: true });

  const cfgChanged = cfgPaths.some((p) => freshCfgStamps[p] !== configStamps[p]);
  const rootsChanged = roots.some((r) => freshCfgStamps[r] !== configStamps[r]);
  let skillsChanged =
    freshSkillStamps != null &&
    computeSkillsStamp(S.skillPaths, freshSkillStamps) !== computeSkillsStamp(S.skillPaths, skillFileStamps);

  if (!cfgChanged && !skillsChanged) return false;
  if (rootsChanged || skillsChanged) return syncFromDisk({ full: true });

  // Before taking the fast path on a config-tier tick, verify no SKILL.md changed alongside the config edit (e.g. CLI `skills set`).
  if (freshSkillStamps == null) {
    const checkedSkills = await readStampsMap(Object.values(S.skillPaths).sort());
    if (!S.loaded || activeWrites > 0) return false;
    if (syncInFlight) return syncInFlight;
    if (lastDiskStamp === null) return syncFromDisk({ full: true });
    skillsChanged = computeSkillsStamp(S.skillPaths, checkedSkills) !== computeSkillsStamp(S.skillPaths, skillFileStamps);
    if (skillsChanged) return syncFromDisk({ full: true });
  }
  return syncFromDisk({});
}

/** Subscribe to cross-frame sync pings, visibility/focus checks, and background polling. */
export function startSync(pollMs = 1500): () => void {
  let tick = 0;
  const stopListen = listenChanges(({ full }) => {
    void syncFromDisk({ full }).catch(() => {});
  });
  const onCheckFull = () => {
    void checkDisk().catch(() => {});
  };
  const onVis = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') onCheckFull();
  };
  const timer = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      const includeSkills = ++tick % 6 === 0;
      void checkDisk({ includeSkills }).catch(() => {});
    }
  }, pollMs);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  if (typeof window !== 'undefined') window.addEventListener('focus', onCheckFull);
  return () => {
    stopListen();
    clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    if (typeof window !== 'undefined') window.removeEventListener('focus', onCheckFull);
    clearLockRetry();
  };
}
