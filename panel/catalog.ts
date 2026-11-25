// Skill catalog: what the panel knows about each SKILL.md. Scans, the lazy (unread) entries the
// stored index pins by stamp, on-demand text reads, the frontmatter cache, and the one place a
// scan result is installed into S (applySkillSnapshot).
import * as core from '../src/core.js';
import type { State } from '../src/core.js';
import type { SkillRef } from '../src/discover.js';
import { discoverSkills, type Unreachable } from './discover';
import { isVerifiedStamp } from '../status/cache';
import type { IndexedMeta } from './index-cache';
import { errorCode, errText, isUnreadable, pool } from '../shared/panel/host';
import { S, host, readOptional, skillPath, StaleError } from './state';
import { readStampsMap, statStamp } from './disk';

export type Meta = IndexedMeta;
const EMPTY: Meta = { description: '', autoinvoke: true, error: null };
const fm = new Map<string, Meta>();
/**
 * Skills whose SKILL.md text is not in memory but whose summary is known for the file at `stamp`
 * (from the stored index, re-verified by stat on every scan). Text is read on demand: ensureMds.
 */
export type LazySkill = { path: string; stamp: string; meta: Meta };
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
export function setMd(id: string, text: string) {
  S.skillMds[id] = text;
  fm.delete(id);
  lazy.delete(id);
}

/**
 * Read the SKILL.md text of the given lazy skills. An unreadable file is recorded the way a scan
 * records it (unreadable + unreachable); a vanished one is a StaleError. A sync that replaced the
 * entry meanwhile wins: its snapshot is newer than this read.
 */
export async function ensureMds(ids: readonly string[]) {
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
export const liveSkillIds = (state: State) => S.allIds.filter((id) => !core.isBuiltin(id) && core.effectiveMode(state, id) !== 'off');

/** What a skill scan (or the stored index) knows; installed into S only through applySkillSnapshot. */
export type SkillSnapshot = {
  allIds: string[];
  skillRefs: Record<string, SkillRef>;
  skillPaths: Record<string, string>;
  unreachable: Unreachable[];
  incomplete: boolean;
  unreadable: string[];
  mds: Record<string, string>;
  lazy: Map<string, LazySkill>;
};

export function applySkillSnapshot(snap: SkillSnapshot) {
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

export type SkillScanReuse = {
  prevPaths: Record<string, string>;
  prevMds: Record<string, string>;
  prevUnreadable: readonly string[];
  prevStamps: Record<string, string>;
};

/** `known`: lazy skills a matching stat stamp lets this scan keep unread. */
export async function scanSkills(opencodeText: string, reuse?: SkillScanReuse, known?: ReadonlyMap<string, LazySkill>) {
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

/** The lazy entries now installed (replaced whole by every snapshot). */
export const lazySkills = (): Map<string, LazySkill> => lazy;
/** A new host: no entry of the old one may be kept unread. */
export function resetLazy() {
  lazy = new Map();
}

export const sameLazy = (a: ReadonlyMap<string, LazySkill>, b: ReadonlyMap<string, LazySkill>) =>
  a.size === b.size && [...a].every(([id, x]) => b.get(id)?.stamp === x.stamp && b.get(id)?.path === x.path);
