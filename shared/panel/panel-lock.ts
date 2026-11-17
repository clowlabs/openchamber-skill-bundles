// A panel's side of a file lock shared with a CLI. The SDK has no delete or exclusive create,
// so the panel writes its record, reads it back to confirm its token, and releases by writing a
// marker. It never touches a lock that isn't its own. Protocol functions are injected.
import { readOptional, type FileHost } from './host';

export type LockVerdict = 'free' | 'held' | 'stale';

export type PanelLockProtocol<Info> = {
  path: string;
  /** Lock file text → parsed info. */
  parse: (text: string) => Info;
  /** null info = no lock file. "free" is taken; "stale" only when reclaimStale allows it. */
  classify: (info: Info | null, opts: { now: number; mtimeMs: number }) => LockVerdict;
  /**
   * A "stale" lock this panel may take over, e.g. an orphaned lock of another panel frame past
   * its TTL. Must be false for process (CLI) locks: the panel can't probe pids. Default: never.
   */
  reclaimStale?: (info: Info) => boolean;
  /** True if `info` is the panel's own record with this token. */
  isOwn: (info: Info, token: string) => boolean;
  /** Whether reading the mtime is worth it (e.g. false for a released marker). */
  needsMtime?: (info: Info) => boolean;
  /** Text the panel writes to take the lock. */
  record: (token: string, now: number) => string;
  /** Text the panel writes to release. */
  releasedMarker: string;
};

export type PanelLockOptions<Info> = PanelLockProtocol<Info> & {
  host: FileHost;
  /** Polling; tests shorten it. Read on every acquire. */
  timing?: { pollMs: number; waitMs: number };
  /** Message when the wait times out; mtimeMs is 0 when unknown. */
  timeoutMessage?: (mtimeMs: number, now: number) => string;
  /** Release failed (best effort; the save itself already happened). */
  onReleaseError?: (e: unknown) => void;
  /** Token source; tests may inject. */
  token?: () => string;
};

export class LockedError extends Error {}

export function randomToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const statMtimeMs = (st: { kind: string; mtime: number }): number =>
  st.kind === 'missing' ? 0 : st.mtime < 1e12 ? st.mtime * 1000 : st.mtime;

export type PanelLock = {
  acquire: () => Promise<string>;
  release: (token: string) => Promise<void>;
  /** acquire → fn → release (always). */
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  timing: { pollMs: number; waitMs: number };
};

export function createPanelLock<Info>(o: PanelLockOptions<Info>): PanelLock {
  const timing = o.timing ?? { pollMs: 250, waitMs: 3000 };
  const info = (text: string | null) => (text == null ? null : o.parse(text));
  const ours = (text: string | null, token: string) => {
    const i = info(text);
    return i != null && o.isOwn(i, token);
  };
  async function mtimeMs() {
    return statMtimeMs(await o.host.stat(o.path));
  }
  async function acquire(): Promise<string> {
    const deadline = Date.now() + timing.waitMs;
    for (;;) {
      const i = info(await readOptional(o.host, o.path));
      const now = Date.now();
      const m = i == null || (o.needsMtime && !o.needsMtime(i)) ? 0 : await mtimeMs();
      const verdict = o.classify(i, { now, mtimeMs: m });
      if (verdict === 'free' || (verdict === 'stale' && i != null && o.reclaimStale?.(i) === true)) {
        // Taking over is the same write + token read-back as taking a free lock.
        const token = (o.token ?? randomToken)();
        await o.host.writeFile(o.path, o.record(token, Date.now()));
        if (ours(await readOptional(o.host, o.path), token)) return token;
        // Someone else won the race; fall through and wait.
      }
      if (Date.now() >= deadline) throw new LockedError(o.timeoutMessage?.(m, now) ?? 'Another writer holds the lock — try again');
      await sleep(timing.pollMs);
    }
  }
  async function release(token: string) {
    try {
      if (ours(await readOptional(o.host, o.path), token)) await o.host.writeFile(o.path, o.releasedMarker);
    } catch (e) {
      o.onReleaseError?.(e);
    }
  }
  return {
    acquire,
    release,
    timing,
    async withLock(fn) {
      const token = await acquire();
      try {
        return await fn();
      } finally {
        await release(token);
      }
    },
  };
}
