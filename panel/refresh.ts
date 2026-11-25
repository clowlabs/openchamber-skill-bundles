// Refresh coordination: generations, disk stamps, lock observation, the disk load (with the
// cache-first boot) and every sync from disk (runSync, syncFromDisk, checkDisk, startSync).
// Writes run in txn.ts and reach this module only through the write gate below.
import * as core from '../src/core.js';
import type { State } from '../src/core.js';
import { skillRoots } from '../src/discover.js';
import type { Unreachable } from './discover';
import { listenChanges } from './sync';
import { sameIds } from '../status/counts';
import { saveSkillIndexCache } from '../status/cache';
import { errorCode } from '../shared/panel/host';
import { statMtimeMs } from '../shared/panel/panel-lock';
import {
  S, activeProjectDir, clearUndo, deriveHome, effectiveHome, homeOpt, host, hooks, lockTiming, readOptional, sameRec,
  setPreviewHome,
} from './state';
import { readProjectTextsSafe, readStampsMap, statStamp } from './disk';
import { applySkillSnapshot, lazySkills, meta, sameLazy, scanSkills, skillText } from './catalog';
import { paintFromIndex, savePanelIndex } from './stored-index';

export type SyncOpts = { full?: boolean };

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

function projectConfigPaths(state: State | null): string[] {
  const dirs = new Set<string>(state ? core.projectTargets(state, homeOpt()) : []);
  const activeDir = activeProjectDir();
  if (activeDir) dirs.add(activeDir);
  return [...dirs].sort().map(core.projectConfigPath);
}

function configStampPaths(opencodeText: string | null, state: State | null = S.state): string[] {
  return [core.BUNDLES_PATH, core.OPENCODE_PATH, core.LOCK_PATH, ...skillRoots(opencodeText), ...projectConfigPaths(state)];
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

export async function recordOwnWrite(lockedCfgStamps: Record<string, string>, writtenSkillStamps: Record<string, string>) {
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


// ---------- write gate: the queue (txn.ts) reports writes; loads and syncs yield to them ----------

/** Writes running now: a sync that sees one stops and defers itself. */
let activeWrites = 0;
/** Bumped as each write is queued: a load that saw a different value does not trust its stamps. */
let writeSeq = 0;
/** A cache-painted boot still reading the disk; writes wait for it. */
let hydrating: Promise<void> | null = null;

export function noteWriteQueued() {
  writeSeq++;
}
export function writeStarted() {
  activeWrites++;
}
export function writeEnded() {
  activeWrites--;
}
/** The cache-first boot in progress, if any (read synchronously by the queued write). */
export const hydration = () => hydrating;
/** The sync in progress, if any (read synchronously by the queued write). */
export const syncInFlightNow = () => syncInFlight;
/** After the queue drains: run the sync a write deferred. */
export function runDeferredSync() {
  if (!deferredSync) return;
  const next = deferredSync;
  deferredSync = null;
  void syncFromDisk(next).catch(() => {});
}

/** A new host: drop generations' stamps, the sync in flight, queued syncs and the lock retry. */
export function resetRefresh() {
  gen++;
  resetStamps();
  syncInFlight = null;
  postLoadStamps = null;
  queuedSync = null;
  deferredSync = null;
  clearLockRetry();
}

// ---------- load ----------

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
  setPreviewHome(undefined);
  const myGen = ++gen;
  const loadWriteSeq = writeSeq;
  const loadSyncSeq = syncSeq;
  resetStamps();
  queuedSync = null;
  deferredSync = null;
  clearLockRetry();
  clearUndo();
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
      return [rootStamps, await scanSkills(opencodeText, undefined, lazySkills())] as const;
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
  S.phase = 'verified';
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
              savePanelIndex(roots, skillFileStamps);
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

// ---------- background sync ----------

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
  let nextLazy = lazySkills();
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
      pendingFullSync ? undefined : lazySkills(),
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
      if (lazySkills().has(id)) continue; // untouched, or replaced by a newer scan: keep the scan's view
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
      !sameLazy(nextLazy, lazySkills())
    ));

  if (!changed) {
    // Stamps may still be newer (a touched file, same text): keep the stored index pinned to them.
    if (needsFull) savePanelIndex(skillRoots(opencodeText), skillFileStamps);
    return false;
  }

  if (configChanged) {
    clearUndo();
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
  if (needsFull) savePanelIndex(skillRoots(opencodeText), skillFileStamps);

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
