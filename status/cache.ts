// Shared persistent skill-ID index in extension storage (`host.storage`), so Work Status mounts
// paint in a single round-trip instead of walking 200+ skill folders on every expand/open.
import type { JsonValue } from '@openchamber/sdk';
import { errorCode, pool, type FileHost } from '../shared/panel/host';
import type { SkillCounts } from './counts';

export const SKILL_COUNTS_KEY = 'skill-counts-v1';
type LastCounts = Pick<SkillCounts, 'live' | 'installed' | 'chars'>;
type CountsEntry = { directory: string; counts: LastCounts };

/** Array order is oldest to newest; only the three displayed numbers are persisted. */
export function parseLastCountsCache(raw: unknown): CountsEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !Array.isArray(r.entries)) return [];
  const entries: CountsEntry[] = [];
  for (const entry of r.entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.directory !== 'string') return [];
    const c = entry.counts;
    if (!c || ![c.live, c.installed, c.chars].every((n) => Number.isSafeInteger(n) && n >= 0)
      || c.live > c.installed) return [];
    if (entries.some((e) => e.directory === entry.directory)) return [];
    entries.push({ directory: entry.directory, counts: { live: c.live, installed: c.installed, chars: c.chars } });
  }
  return entries.slice(-20);
}

async function readLastCountsCache(host: StorageHost): Promise<CountsEntry[]> {
  try {
    return host.storage ? parseLastCountsCache(await host.storage.get(SKILL_COUNTS_KEY)) : [];
  } catch {
    return [];
  }
}

const sameCounts = (a: LastCounts, b: LastCounts) =>
  a.live === b.live && a.installed === b.installed && a.chars === b.chars;

/** Directory epochs protect both cached and fresh paints, including A → B → A switches. */
export function createCachedStatusPainter(host: StorageHost, paint: (c: SkillCounts) => void) {
  let epoch = 0;
  let directory = '';
  let fresh = false;
  let writes = Promise.resolve();
  return {
    select(dir: string | null): Promise<void> {
      directory = dir ?? '';
      fresh = false;
      const ticket = ++epoch;
      const key = directory;
      return readLastCountsCache(host).then((entries) => {
        const cached = entries.find((e) => e.directory === key);
        if (cached && ticket === epoch && !fresh) {
          paint({ ...cached.counts, bundlesOn: [], fromOpencode: false });
        }
      });
    },
    ticket: () => epoch,
    isCurrent: (ticket: number) => ticket === epoch,
    fresh(ticket: number, c: SkillCounts): Promise<void> {
      if (ticket !== epoch) return Promise.resolve();
      fresh = true;
      paint(c);
      if (!host.storage) return Promise.resolve();
      const key = directory;
      const value = { live: c.live, installed: c.installed, chars: c.chars };
      // Serialize read/modify/write operations in this frame, so rapid paints cannot lose entries.
      writes = writes.then(async () => {
        const entries = await readLastCountsCache(host);
        const previous = entries.find((e) => e.directory === key);
        if (previous && sameCounts(previous.counts, value)) return;
        const next = [...entries.filter((e) => e.directory !== key), { directory: key, counts: value }].slice(-20);
        await host.storage?.set(SKILL_COUNTS_KEY, { v: 1, entries: next });
      }).catch(() => { /* A cache failure must never affect the live meter. */ });
      return writes;
    },
  };
}

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
