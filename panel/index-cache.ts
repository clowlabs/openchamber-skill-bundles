// Persistent panel index in extension storage (`host.storage`): what the rail and page need to
// paint (ids, paths, frontmatter summaries, bundles come from disk) without walking skill folders
// or reading every SKILL.md. Disposable: a missing, malformed or mismatched entry means a normal
// disk load, and every boot revalidates from disk right after painting.
import type { SkillRef } from '../src/discover.js';
import type { Unreachable } from './discover';
import type { JsonValue } from '@openchamber/sdk';
import { isVerifiedStamp } from '../status/cache';

/**
 * The index is a manifest plus parts: the host refuses any single value over 64 KiB of UTF-8
 * (GUEST_STORAGE_VALUE_BYTES), and ~230 skills already need more. Parts are written first under a
 * fresh generation, the manifest last, so a reader sees one whole generation or the older one.
 */
export const PANEL_INDEX_KEY = 'panel-index-v2';
const PART_KEY = (gen: string, i: number) => `${PANEL_INDEX_KEY}.${gen}.${i}`;
/** Single-key format of 0.2.18–0.2.19; deleted on the first write of the new one. */
const LEGACY_KEY = 'panel-index-v1';
export const STORAGE_VALUE_BYTES = 65_536;
/** Room under the host limit for the part's own wrapper. */
const PART_BYTES = 60_000;
/** At most ~1 MB of the extension's 2 MiB namespace. */
export const MAX_PANEL_INDEX_PARTS = 16;

const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export type IndexedMeta = { description: string; autoinvoke: boolean; error: string | null };
/** `stamp` is the SKILL.md stat stamp the summary was read at; a different stamp means re-read. */
export type IndexedSkill = SkillRef & IndexedMeta & { stamp: string };

export type PanelIndex = {
  v: 1;
  /** JSON of skillRoots(opencode.json) the scan used; a different config means a different scan. */
  rootsKey: string;
  home?: string;
  allIds: string[];
  skills: IndexedSkill[];
  unreachable: Unreachable[];
  unreadable: string[];
};

const isStr = (x: unknown): x is string => typeof x === 'string';
const isObj = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function parseSkill(x: unknown): IndexedSkill | null {
  if (!isObj(x)) return null;
  const { id, root, path, dir, description, autoinvoke, error, stamp } = x;
  if (!isStr(id) || !id || !isStr(root) || !isStr(path) || !(dir === null || isStr(dir))) return null;
  if (!isStr(stamp) || !isVerifiedStamp(stamp)) return null;
  if (!isStr(description) || typeof autoinvoke !== 'boolean' || !(error === null || isStr(error))) return null;
  return { id, root, path, dir, description, autoinvoke, error, stamp };
}

/** A valid index, or null. All-or-nothing: one bad field drops the whole entry. */
export function parsePanelIndex(raw: unknown): PanelIndex | null {
  if (!isObj(raw) || raw.v !== 1 || !isStr(raw.rootsKey)) return null;
  const { allIds, skills, unreachable, unreadable } = raw;
  if (!Array.isArray(allIds) || !allIds.every(isStr)) return null;
  if (!Array.isArray(unreadable) || !unreadable.every(isStr)) return null;
  if (!Array.isArray(unreachable) || !unreachable.every((u) => isObj(u) && isStr(u.path) && isStr(u.code))) return null;
  if (!Array.isArray(skills)) return null;
  const parsed: IndexedSkill[] = [];
  for (const s of skills) {
    const p = parseSkill(s);
    if (!p) return null;
    parsed.push(p);
  }
  const home = isStr(raw.home) && raw.home ? raw.home : undefined;
  return {
    v: 1,
    rootsKey: raw.rootsKey,
    ...(home ? { home } : {}),
    allIds: [...allIds],
    skills: parsed,
    unreachable: unreachable.map((u) => ({ path: u.path as string, code: u.code as string })),
    unreadable: [...unreadable],
  };
}

type IndexStorage = {
  storage?: {
    get: (key: string) => Promise<JsonValue | undefined>;
    set: (key: string, value: JsonValue) => Promise<void>;
    delete?: (key: string) => Promise<void>;
  };
};

type Manifest = { gen: string; parts: number };

function parseManifest(raw: unknown): (Manifest & Record<string, unknown>) | null {
  if (!isObj(raw) || raw.v !== 1 || !isStr(raw.gen) || !raw.gen) return null;
  const parts = raw.parts;
  if (!Number.isSafeInteger(parts) || (parts as number) < 0 || (parts as number) > MAX_PANEL_INDEX_PARTS) return null;
  return { ...raw, gen: raw.gen, parts: parts as number };
}

/** The stored index, or null when missing, partial (a part of its generation is gone) or invalid. */
export async function readPanelIndex(host: IndexStorage): Promise<PanelIndex | null> {
  const storage = host.storage;
  if (!storage) return null;
  try {
    const manifest = parseManifest(await storage.get(PANEL_INDEX_KEY));
    if (!manifest) return null;
    const parts = await Promise.all(Array.from({ length: manifest.parts }, (_, i) => storage.get(PART_KEY(manifest.gen, i))));
    const skills: unknown[] = [];
    for (const [i, part] of parts.entries()) {
      if (!isObj(part) || part.gen !== manifest.gen || part.i !== i || !Array.isArray(part.skills)) return null;
      skills.push(...part.skills);
    }
    const { gen: _gen, parts: _parts, ...rest } = manifest;
    return parsePanelIndex({ ...rest, skills });
  } catch {
    return null;
  }
}

/** Comparable text of an index, to skip writing what is already stored. */
export const panelIndexText = (index: PanelIndex): string => JSON.stringify(index);

/** Skills in order, cut so each part stays under PART_BYTES; null when one skill alone is too big. */
function splitSkills(skills: readonly IndexedSkill[]): IndexedSkill[][] | null {
  const out: IndexedSkill[][] = [];
  let cur: IndexedSkill[] = [];
  let size = 0;
  for (const s of skills) {
    const n = utf8Bytes(s) + 1;
    if (n > PART_BYTES) return null;
    if (size + n > PART_BYTES && cur.length) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(s);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

const newGen = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Store `index` as a new generation. True once the manifest names it. Too large an index stores
 * nothing (false) and leaves the old one. Old parts are deleted only after the manifest switched.
 */
export async function writePanelIndex(host: IndexStorage, index: PanelIndex): Promise<boolean> {
  const storage = host.storage;
  if (!storage) return false;
  const chunks = splitSkills(index.skills);
  if (!chunks || chunks.length > MAX_PANEL_INDEX_PARTS) return false;
  const { skills: _skills, ...rest } = index;
  const gen = newGen();
  const manifest = { ...rest, gen, parts: chunks.length } as unknown as JsonValue;
  if (utf8Bytes(manifest) > STORAGE_VALUE_BYTES) return false;
  const old = parseManifest(await storage.get(PANEL_INDEX_KEY).catch(() => undefined));
  for (const [i, part] of chunks.entries()) {
    await storage.set(PART_KEY(gen, i), { gen, i, skills: part } as unknown as JsonValue);
  }
  await storage.set(PANEL_INDEX_KEY, manifest);
  // Best effort: a leftover part only wastes space; the manifest decides what is read.
  const stale = old && old.gen !== gen ? Array.from({ length: old.parts }, (_, i) => PART_KEY(old.gen, i)) : [];
  await Promise.all([...stale, LEGACY_KEY].map((k) => storage.delete?.(k).catch(() => {})));
  return true;
}
