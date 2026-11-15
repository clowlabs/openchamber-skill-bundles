/**
 * @module shared/core/lock
 * Wire format and staleness rules for a lock file shared by two kinds of writer:
 * - a *process* writer (e.g. a CLI) that can create the file exclusively and probe pids:
 *   `{"pid": <int>0>, "host": <hostname>, "time": <ms>, "token": <str>}`;
 * - a *holder* writer (e.g. a sandboxed panel) that can't create exclusively, delete or probe
 *   pids: it takes the lock with `{"owner": ownerName, "host": ownerName, "pid": 0, "token", "time"}`,
 *   holds it at most `ttlMs`, and releases by writing `{"owner": ownerName, "released": true, "time": 0}`.
 * Anything else (garbage, another host's process lock without a pid probe) is reclaimable only
 * after `unparseableStaleMs` of mtime age. I/O (exclusive create, reclaim, polling) stays in adapters.
 * Pure, no I/O; runs in browser and Node.
 */

/**
 * @typedef {{ownerName: string, ttlMs: number, unparseableStaleMs: number}} LockConfig
 * @typedef {{kind: "process", pid: number, host: string, token: string|null, time: number|null}
 *   | {kind: "holder", token: string|null, time: number|null, host: string|null}
 *   | {kind: "released"} | {kind: "invalid"}} LockInfo
 * @typedef {"free"|"held"|"stale"} LockVerdict
 */

/**
 * Builds the protocol for one lock. Every function is pure.
 * @param {LockConfig} config
 */
export function createLockProtocol({ ownerName, ttlMs, unparseableStaleMs }) {
  if (typeof ownerName !== "string" || !ownerName) throw new Error("ownerName must be a non-empty string");
  if (!(ttlMs > 0) || !(unparseableStaleMs > 0)) throw new Error("ttlMs and unparseableStaleMs must be positive");

  /** Exact text the holder writes to release (it cannot delete). Counts as free. */
  const releasedMarker = JSON.stringify({ owner: ownerName, released: true, time: 0 });

  /** Exact text the holder writes to take the lock. */
  const makeHolderRecord = (token, now) => JSON.stringify({ owner: ownerName, host: ownerName, pid: 0, token, time: now });

  /** Exact text a process writer creates (one trailing newline). */
  const makeProcessRecord = ({ pid, host, time, token }) => JSON.stringify({ pid, host, time, token }) + "\n";

  /** @returns {LockInfo} */
  function parseLock(text) {
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      return { kind: "invalid" };
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return { kind: "invalid" };
    const time = Number.isFinite(v.time) ? v.time : null;
    const token = typeof v.token === "string" ? v.token : null;
    if (v.owner === ownerName && v.released === true) return { kind: "released" };
    if (v.owner === ownerName) return { kind: "holder", token, time, host: typeof v.host === "string" ? v.host : null };
    if (Number.isInteger(v.pid) && v.pid > 0 && typeof v.host === "string" && v.host) {
      return { kind: "process", pid: v.pid, host: v.host, token, time };
    }
    return { kind: "invalid" };
  }

  /**
   * @param {LockInfo|null} info null = no lock file
   * @param {{now: number, mtimeMs: number, pidAlive?: (pid: number) => boolean, host?: string}} opts
   *   a process lock is judged by its pid only when it is from `host` and pidAlive is given
   * @returns {LockVerdict} "free" and "stale" may both be taken over
   */
  function classifyLock(info, { now, mtimeMs, pidAlive, host } = {}) {
    if (!info || info.kind === "released") return "free";
    const age = (t) => (Number.isFinite(t) ? now - t : Infinity);
    if (info.kind === "holder") {
      const t = info.time !== null && Number.isFinite(info.time) ? Math.max(info.time, mtimeMs ?? -Infinity) : mtimeMs;
      return age(t) > ttlMs ? "stale" : "held";
    }
    if (info.kind === "process" && host && info.host === host && typeof pidAlive === "function") {
      return pidAlive(info.pid) ? "held" : "stale";
    }
    return age(mtimeMs) > unparseableStaleMs ? "stale" : "held";
  }

  return { ownerName, ttlMs, unparseableStaleMs, releasedMarker, makeHolderRecord, makeProcessRecord, parseLock, classifyLock };
}
