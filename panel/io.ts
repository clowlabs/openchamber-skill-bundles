// Files, the CLI lock, the write queue and the frontmatter cache.
import { HostRequestError, type HostClient } from '@openchamber/sdk';
import * as core from '../src/core.js';
import type { ChangePlan, PlanError, State } from '../src/core.js';
import seed from '../data/default-bundles.json';

/** The host client; main sets it at boot, tests pass a fake. */
export let host: HostClient;
export function setHost(h: HostClient) {
  host = h;
}

/** Data loaded from disk plus write-queue bookkeeping. */
export const S = {
  state: null as State | null,
  loaded: false,
  allIds: [] as string[],
  skillMds: {} as Record<string, string>,
  opencodeText: '',
  bundlesText: null as string | null,
  pending: 0,
  descDraft: null as { id: string; value: string } | null,
};

/** Set by main: full and stats-only re-render. */
export const hooks = { render: () => {}, renderLight: () => {} };

export const skillPath = (id: string) => `${core.SKILLS_DIR}/${id}/SKILL.md`;
export const mode = (id: string) => core.effectiveMode(S.state!, id);
export const bundlesOf = (id: string) => (S.state ? S.state.bundles.filter((b) => b.skills.includes(id)) : []);

export function errText(e: unknown) {
  if (e instanceof HostRequestError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
export function toastError(e: unknown, what: string) {
  void host.toast({ kind: 'error', message: `${what}: ${errText(e)}`, copy: true, dismiss: true });
}
const isNotFound = (e: unknown) => e instanceof HostRequestError && e.code === 'NOT_FOUND';

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

let chain: Promise<void> = Promise.resolve();
export function enqueue(task: () => Promise<void>): Promise<boolean> {
  S.pending++;
  hooks.renderLight();
  const run = chain.then(task).then(
    () => true,
    (e) => { toastError(e, 'Saving failed'); return false; },
  );
  chain = run.then(() => {
    S.pending--;
    hooks.render();
  });
  return run;
}

class StaleError extends Error {}
class LockedError extends Error {}
class RefusedError extends Error {}

// ---------- lock ----------

// Protocol shared with the CLI (core.LOCK_PATH etc.). The SDK has no delete, so the panel
// releases by writing core.RELEASED_MARKER, and never touches a lock that isn't its own.
/** How long to wait for a held lock. Tests shorten it. */
export const lockTiming = { pollMs: 250, waitMs: 3000 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function randomToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
const lockInfo = (text: string | null) => (text == null ? null : core.parseLock(text));
const isOurs = (text: string | null, token: string) => {
  const info = lockInfo(text);
  return info?.kind === 'panel' && info.token === token;
};
async function lockMtimeMs() {
  const st = await host.stat(core.LOCK_PATH);
  if (st.kind === 'missing') return 0;
  return st.mtime < 1e12 ? st.mtime * 1000 : st.mtime;
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return (await host.readFile(path)).content;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * Acquire the lock (polling up to lockTiming.waitMs), returning our token. Only a free lock
 * (missing, or a panel-owned released marker) is taken. The panel can't probe pids, so it never
 * reclaims a held or stale lock itself; for an old one it suggests `skills sync`.
 */
async function acquireLock(): Promise<string> {
  const deadline = Date.now() + lockTiming.waitMs;
  for (;;) {
    const info = lockInfo(await readOptional(core.LOCK_PATH));
    const now = Date.now();
    const mtimeMs = info == null || info.kind === 'released' ? 0 : await lockMtimeMs();
    const verdict = core.classifyLock(info, { now, mtimeMs });
    if (verdict === 'free') {
      const token = randomToken();
      await host.writeFile(core.LOCK_PATH, core.panelLockRecord(token, Date.now()));
      if (isOurs(await readOptional(core.LOCK_PATH), token)) return token;
      // Someone else won the race; fall through and wait.
    }
    if (Date.now() >= deadline) {
      if (mtimeMs > 0 && now - mtimeMs >= core.LOCK_UNPARSEABLE_STALE_MS) {
        throw new LockedError(`A CLI lock from ${new Date(mtimeMs).toLocaleString()} is blocking saves. If no \`skills\` command is running, run \`skills sync\` to clear the stale lock.`);
      }
      throw new LockedError('CLI is writing — try again');
    }
    await sleep(lockTiming.pollMs);
  }
}

async function releaseLock(token: string) {
  try {
    if (isOurs(await readOptional(core.LOCK_PATH), token)) await host.writeFile(core.LOCK_PATH, core.RELEASED_MARKER);
  } catch (e) {
    toastError(e, 'Could not release the lock');
  }
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const token = await acquireLock();
  try {
    return await fn();
  } finally {
    await releaseLock(token);
  }
}

// ---------- load ----------

/** Run fn over items, at most `size` at a time. */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length) await fn(queue.shift()!);
  };
  await Promise.all(Array.from({ length: size }, worker));
}

export async function load() {
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
  S.state = bundlesText == null ? null : core.parseBundles(bundlesText);
  S.loaded = true;
}

// ---------- save ----------

function planFor(next: State): ChangePlan {
  try {
    return core.planChange({ bundlesText: S.bundlesText, opencodeText: S.opencodeText, skillMds: S.skillMds }, next, S.allIds);
  } catch (e) {
    const pe = e as Partial<PlanError>;
    const where = pe.file === 'skill' ? (pe.id ? `skills/${pe.id}/SKILL.md` : 'SKILL.md') : pe.file === 'opencode' ? 'opencode.json' : '';
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

async function save(next: State) {
  const first = planFor(next); // refuse early, before taking the lock
  await withLock(() => saveLocked(next, first));
}

// Order: SKILL.md edits, opencode.json, skill-bundles.json last. Undo what was written on failure.
async function saveLocked(next: State, first: ChangePlan) {
  // Bundle files changed under us: abort and reload (the caller handles StaleError).
  const [onDisk, bundlesOnDisk] = await Promise.all([host.readFile(core.OPENCODE_PATH), readOptional(core.BUNDLES_PATH)]);
  if (onDisk.content !== S.opencodeText) throw new StaleError('opencode.json changed on disk');
  if (bundlesOnDisk !== S.bundlesText) throw new StaleError('skill-bundles.json changed on disk');

  // SKILL.md-only changes merge: base every edit on text read under the lock.
  let plan = first;
  for (let i = 0; i < 5 && (await refreshSkillMds(skillIds(plan))); i++) plan = planFor(next);

  // plan.writes is already in core.PUBLISH_ORDER. Undo what was written on failure.
  const written: { path: string; before: string }[] = [];
  try {
    for (const w of plan.writes) {
      if (w.kind === 'opencode') {
        const bak = core.OPENCODE_PATH.replace(/[^/]+$/, core.backupName());
        if ((await host.stat(bak)).kind === 'missing') await host.writeFile(bak, S.opencodeText);
      }
      await host.writeFile(w.path, w.after);
      // A bundles file that didn't exist (seeding) has nothing to restore; it is written last anyway.
      if (w.before != null) written.push({ path: w.path, before: w.before });
    }
  } catch (e) {
    for (const { path, before } of written.reverse()) {
      try { await host.writeFile(path, before); } catch (r) { toastError(r, `Could not restore ${path}`); }
    }
    throw e;
  }
  for (const w of plan.writes) {
    if (w.kind === 'skill' && w.id) setMd(w.id, w.after);
    else if (w.kind === 'opencode') S.opencodeText = w.after;
    else if (w.kind === 'bundles') S.bundlesText = w.after;
  }
  S.state = next;
  toastSkipped(plan.skipped);
}

function toastSkipped(skipped: ChangePlan['skipped']) {
  if (!skipped.length) return;
  // Toast text is capped at 500 chars by the host; Copy allows 32,000.
  const head = `Skipped ${skipped.length} skill(s) needing manual edit: `;
  const shown: string[] = [];
  for (const s of skipped) {
    const rest = skipped.length - shown.length - 1;
    const candidate = [...shown, s.id].join(', ') + (rest ? ` and ${rest} more` : '');
    if ((head + candidate).length > 480) break;
    shown.push(s.id);
  }
  const more = skipped.length - shown.length;
  const full = skipped.map((s) => `${s.id}: ${s.reason}`).join('\n');
  void host.toast({
    kind: 'info', dismiss: true,
    message: head + shown.join(', ') + (more ? `${shown.length ? ' and ' : ''}${more} more` : ''),
    copy: { text: full.length > 32000 ? `${full.slice(0, 31980)}\n…` : full },
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
      await save(core.parseBundles(JSON.stringify(seed)));
      void host.toast({ kind: 'success', message: 'Created skill-bundles.json from the default bundles.' });
    } catch (e) {
      await reloadAfter(e);
    }
  });
}
