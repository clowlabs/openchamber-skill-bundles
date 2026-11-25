// Persistent panel index in extension storage (`host.storage`): what the rail and page need to
// paint (ids, paths, frontmatter summaries, bundles come from disk) without walking skill folders
// or reading every SKILL.md. Disposable: a missing, malformed or mismatched entry means a normal
// disk load, and every boot revalidates from disk right after painting.
import type { SkillRef } from '../src/discover.js';
import type { Unreachable } from './discover';
import type { StorageHost } from '../status/cache';

export const PANEL_INDEX_KEY = 'panel-index-v1';
/** Storage holds 2 MiB per extension; leave room for the other keys. */
export const MAX_PANEL_INDEX_CHARS = 1_500_000;

export type IndexedMeta = { description: string; autoinvoke: boolean; error: string | null };
export type IndexedSkill = SkillRef & IndexedMeta;

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
  const { id, root, path, dir, description, autoinvoke, error } = x;
  if (!isStr(id) || !id || !isStr(root) || !isStr(path) || !(dir === null || isStr(dir))) return null;
  if (!isStr(description) || typeof autoinvoke !== 'boolean' || !(error === null || isStr(error))) return null;
  return { id, root, path, dir, description, autoinvoke, error };
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

export async function readPanelIndex(host: StorageHost): Promise<PanelIndex | null> {
  if (!host.storage) return null;
  try {
    return parsePanelIndex(await host.storage.get(PANEL_INDEX_KEY));
  } catch {
    return null;
  }
}

/** Serialized form, or null when it is over the size cap (then nothing is stored). */
export function serializePanelIndex(index: PanelIndex): string | null {
  const text = JSON.stringify(index);
  return text.length > MAX_PANEL_INDEX_CHARS ? null : text;
}

export async function writePanelIndex(host: StorageHost, text: string): Promise<void> {
  if (!host.storage) return;
  try {
    await host.storage.set(PANEL_INDEX_KEY, JSON.parse(text));
  } catch {
    // Non-fatal: the next boot just loads from disk.
  }
}
