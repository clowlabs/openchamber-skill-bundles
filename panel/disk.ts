// Low-level disk reads every io module shares: stat stamps and project config texts.
import { statFileStamp } from '../status/cache';
import { isUnreadable, pool } from '../shared/panel/host';
import { host, readOptional } from './state';

export const statStamp = (p: string): Promise<string> => statFileStamp(host, p);

/** Stat stamps of `paths` (deduplicated); `preset` supplies stamps already read. */
export async function readStampsMap(paths: readonly string[], preset?: Record<string, string>): Promise<Record<string, string>> {
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

/** Project config texts by path: null = missing on disk, omitted = unreadable. */
export async function readProjectTextsSafe(paths: readonly string[]): Promise<Record<string, string | null>> {
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
