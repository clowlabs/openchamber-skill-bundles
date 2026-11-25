// Save transactions: the write queue, the CLI lock, planning and publishing a state change
// (save/saveLocked), description edits, seeding defaults and undo.
import type { HostClient } from '@openchamber/sdk';
import * as core from '../src/core.js';
import type { ChangePlan, PlanError, State } from '../src/core.js';
import { skillRoots } from '../src/discover.js';
import seed from '../data/default-bundles.json';
import { broadcastChange } from './sync';
import { parseSkillRules, sameIds } from '../status/counts';
import { errText, isUnreadable, pool } from '../shared/panel/host';
import { createQueue } from '../shared/panel/queue';
import { createPanelLock, LockedError, type PanelLock } from '../shared/panel/panel-lock';
import { backupOnce, runTxn, type TxnWrite } from '../shared/panel/txn';
import { capText, fitList } from '../shared/panel/toast';
import {
  S, activeProjectDir, clearUndo, history, homeOpt, host, hooks, lockTiming, readOptional, RefusedError, sameRec, skillPath,
  StaleError, toastError,
} from './state';
import { readStampsMap, statStamp } from './disk';
import { ensureMds, hasSkillMd, liveSkillIds, setMd, skillText } from './catalog';
import {
  hydration, load, noteWriteQueued, recordOwnWrite, runDeferredSync, syncInFlightNow, writeEnded, writeStarted,
} from './refresh';

// ---------- lock ----------

let lock: PanelLock;
/** A new host gets its own lock client. */
export function resetLock(h: HostClient) {
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

const withLock = <T>(fn: () => Promise<T>) => lock.withLock(fn);

// ---------- write queue: every write runs here, one at a time, none dropped ----------

const queue = createQueue({
  onQueued: () => hooks.renderLight(),
  onSettled: () => {
    hooks.render();
    if (queue.pending === 0) runDeferredSync();
  },
  onError: (e) => toastError(e, 'Saving failed'),
});

export const enqueue: typeof queue.enqueue = (task) => {
  noteWriteQueued();
  return queue.enqueue(async () => {
    const hydrating = hydration();
    if (hydrating) await hydrating.catch(() => {});
    // Never plan a write on index data: SKILL.md texts and stamps come only from the disk load.
    if (!S.fresh) throw new Error('skills are not loaded from disk yet');
    const syncInFlight = syncInFlightNow();
    if (syncInFlight) await syncInFlight.catch(() => false);
    writeStarted();
    try {
      await task();
    } finally {
      writeEnded();
    }
  });
};
/** Writes queued or running. */
export const pending = () => queue.pending;

// ---------- undo ----------

const MAX_UNDO = 30;

export const canUndo = () => S.loaded && history.stack.length > 0;
export const undoDepth = () => history.stack.length;
export const undoLabel = () => history.stack.at(-1)?.label ?? null;

export type ChangeOpts = { label?: string; undoable?: boolean | 'clear' };

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
  // Stricter than core (which refuses 'called' and skips 'auto' without text): reload instead of
  // saving with a skip, since here missing text means a load gap, not a vanished file.
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
    clearUndo();
  } else if (opts?.undoable !== false && prev && next !== prev && JSON.stringify(prev) !== JSON.stringify(next)) {
    history.stack.push({ state: prev, label: opts?.label ?? 'change' });
    if (history.stack.length > MAX_UNDO) history.stack.splice(0, history.stack.length - MAX_UNDO);
  }
  return true;
}

/** Revert the most recent undoable state change. */
export async function undo(): Promise<boolean> {
  if (!canUndo() || pending() > 0) return false;
  const entry = history.stack.at(-1);
  if (!entry) return false;
  const prev = entry.state;
  let ok = false;
  const ran = await enqueue(async () => {
    if (!canUndo() || history.stack.at(-1) !== entry) return;
    ok = await applyChange((cur) => {
      const managedProjects = [...new Set([...(prev.managedProjects ?? []), ...(cur.managedProjects ?? [])])];
      return managedProjects.length ? { ...prev, managedProjects } : { ...prev };
    }, { undoable: false });
    if (ok && history.stack.at(-1) === entry) {
      history.stack.pop();
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
