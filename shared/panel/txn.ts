// Transactional multi-file writer for panels. Writes run in the given order; on failure every
// write is undone, newest first. Targets marked `shared` (files the user also edits) are re-read
// right before writing and merged, and on rollback restored only if still exactly what we wrote;
// otherwise the user's version stays and the pre-save text goes to a rescue file.
import { readOptional, type FileHost } from './host';

export type TxnWrite = {
  path: string;
  /** Text as planned from (null = the file did not exist). */
  before: string | null;
  after: string;
  /**
   * Shared file: re-read before writing; if it changed, `merge(fresh)` gives the text to write
   * (null or === fresh = nothing to write). Without merge, a changed shared file aborts.
   */
  shared?: boolean;
  merge?: (fresh: string | null) => string | null;
  /** Rollback for a file we created (before === null) and that is still ours: text to leave. */
  neutralize?: (wrote: string) => string | null;
  /** Runs right before this write (e.g. a daily backup). */
  beforeWrite?: () => Promise<void>;
};

export type Written = { path: string; before: string | null; wrote: string; shared: boolean; neutralize?: TxnWrite['neutralize'] };

export type TxnHooks = {
  /** A shared file was edited after our write; it was left as is. rescued = '' when none was kept. */
  onConflict?: (path: string, rescued: string) => void;
  /** A restore failed. */
  onRestoreError?: (path: string, e: unknown) => void;
  /** Rescue file name for `path`; default `<path>.<tag>-rescue-<stamp>-<rand>`. */
  rescueName?: (path: string) => string;
};

export class TxnConflictError extends Error {
  constructor(readonly path: string) {
    super(`${path} changed on disk`);
  }
}

/** `<path>.<tag>-rescue-<YYYYMMDD-HHMMSS>-<rand>` */
export function rescueName(path: string, tag: string, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15);
  return `${path}.${tag}-rescue-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Write all, in order. Returns what was written. Throws (after rolling back) on failure. */
export async function runTxn(host: FileHost, writes: readonly TxnWrite[], hooks: TxnHooks & { tag: string }): Promise<Written[]> {
  const written: Written[] = [];
  try {
    for (const w of writes) {
      await w.beforeWrite?.();
      let after = w.after;
      let before = w.before;
      if (w.shared) {
        const fresh = await readOptional(host, w.path);
        if (fresh !== w.before) {
          if (!w.merge) throw new TxnConflictError(w.path);
          const merged = w.merge(fresh);
          if (merged == null || merged === fresh) continue; // nothing of ours to write
          after = merged;
        } else if (after === fresh) continue;
        before = fresh;
      }
      await host.writeFile(w.path, after);
      written.push({ path: w.path, before, wrote: after, shared: !!w.shared, neutralize: w.neutralize });
    }
  } catch (e) {
    await rollback(host, written, hooks);
    throw e;
  }
  return written;
}

export async function rollback(host: FileHost, written: readonly Written[], hooks: TxnHooks & { tag: string }) {
  for (const w of [...written].reverse()) {
    try {
      if (!w.shared) {
        if (w.before != null) await host.writeFile(w.path, w.before);
        else if (w.neutralize) {
          const n = w.neutralize(w.wrote);
          if (n != null) await host.writeFile(w.path, n);
        }
        continue;
      }
      const current = await readOptional(host, w.path);
      if (current === w.wrote) {
        // Untouched since our write: undo. A file we created can't be deleted (no SDK delete).
        const restore = w.before ?? w.neutralize?.(w.wrote) ?? null;
        if (restore != null) await host.writeFile(w.path, restore);
        continue;
      }
      let rescued = '';
      if (w.before != null) {
        rescued = (hooks.rescueName ?? ((p) => rescueName(p, hooks.tag)))(w.path);
        await host.writeFile(rescued, w.before);
      }
      hooks.onConflict?.(w.path, rescued);
    } catch (e) {
      hooks.onRestoreError?.(w.path, e);
    }
  }
}

/** Daily backup: write `backupPath` from `text` once (only if it doesn't exist yet). */
export async function backupOnce(host: FileHost, backupPath: string, text: string) {
  if ((await host.stat(backupPath)).kind === 'missing') await host.writeFile(backupPath, text);
}
