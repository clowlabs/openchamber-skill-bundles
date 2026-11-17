// Shared persistent skill-ID index in extension storage (`host.storage`), so Work Status mounts
// paint in a single round-trip instead of walking 200+ skill folders on every expand/open.
import type { JsonValue } from '@openchamber/sdk';
import { errorCode, pool, type FileHost } from '../shared/panel/host';

export const SKILL_INDEX_KEY = 'skill-index-v1';
const MAX_CACHE_CHARS = 60_000;

export type StorageHost = {
  storage?: {
    get: (key: string) => Promise<JsonValue | undefined>;
    set: (key: string, value: JsonValue) => Promise<void>;
  };
};

export type SkillIndexCache = {
  v: 1;
  rootsKey: string;
  rootStamps: string;
  allIds: string[];
  home?: string;
  scannedAt: number;
};

export const statFileStamp = (host: Pick<FileHost, 'stat'>, path: string): Promise<string> =>
  host.stat(path).then(
    (st) => `${st.kind}:${st.size}:${st.mtime}`,
    (e) => `err:${errorCode(e) || 'ERR'}`,
  );

export async function statRootsMap(
  host: Pick<FileHost, 'stat'>,
  roots: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = Object.create(null);
  await pool([...new Set(roots)], 16, async (r) => {
    out[r] = await statFileStamp(host, r);
  });
  return out;
}

export const formatRootStamps = (roots: readonly string[], stamps: Readonly<Record<string, string>>): string =>
  roots.map((r) => stamps[r] ?? '').join('|');

export function parseSkillIndexCache(raw: unknown): SkillIndexCache | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.rootsKey !== 'string' || typeof r.rootStamps !== 'string') return null;
  if (typeof r.scannedAt !== 'number' || !Number.isFinite(r.scannedAt)) return null;
  if (!Array.isArray(r.allIds) || !r.allIds.every((x): x is string => typeof x === 'string')) return null;
  const home = typeof r.home === 'string' && r.home ? r.home : undefined;
  return {
    v: 1,
    rootsKey: r.rootsKey,
    rootStamps: r.rootStamps,
    allIds: r.allIds,
    ...(home ? { home } : {}),
    scannedAt: r.scannedAt,
  };
}

export async function readSkillIndexCache(host: StorageHost): Promise<SkillIndexCache | null> {
  if (!host.storage) return null;
  try {
    return parseSkillIndexCache(await host.storage.get(SKILL_INDEX_KEY));
  } catch {
    return null;
  }
}

export async function writeSkillIndexCache(host: StorageHost, entry: SkillIndexCache): Promise<void> {
  if (!host.storage) return;
  try {
    if (JSON.stringify(entry).length > MAX_CACHE_CHARS) return;
    await host.storage.set(SKILL_INDEX_KEY, entry);
  } catch {
    // Storage failures are non-fatal; live discovery still works.
  }
}
