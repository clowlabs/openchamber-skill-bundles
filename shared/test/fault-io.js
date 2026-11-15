/**
 * @module shared/test/fault-io
 * Fault-injecting wrapper around an `io` object (shared/node/fs-safe.js IO). Lets tests make one
 * specific call fail, or change the disk at an exact moment to simulate a concurrent writer,
 * without any test hooks in production code.
 */
import { createNodeIO } from "../node/fs-safe.js";

/**
 * Wraps `base` (default: the real Node io). `on` maps an io method name to a hook
 * `(args, nth, real)` that runs before the real method; `nth` counts the calls of that method
 * that pass `match[name](...args)` (default: every call), starting at 0. A hook may throw to
 * inject a fault, or mutate the disk to simulate another writer.
 * @param {Record<string, (args: any[], nth: number, real: object) => void>} [on]
 * @param {Record<string, (...args: any[]) => boolean>} [match]
 * @param {object} [base]
 */
export function faultyIO(on = {}, match = {}, base = createNodeIO()) {
  const counts = {};
  const io = { ...base };
  for (const [name, hook] of Object.entries(on)) {
    if (typeof base[name] !== "function") throw new Error(`faultyIO: io has no method ${name}`);
    io[name] = (...args) => {
      if (!match[name] || match[name](...args)) {
        counts[name] = (counts[name] ?? 0) + 1;
        hook(args, counts[name] - 1, base);
      }
      return base[name](...args);
    };
  }
  return io;
}

/** Throws an fs-like error (default code EIO). */
export function boom(msg, code = "EIO") {
  throw Object.assign(new Error(msg), { code });
}

/** True for the temp files fs-safe writes (`.<name>.<pid>.<ms>.<n>.tmp`). */
export const isTemp = (p) => p.endsWith(".tmp");
/** rename(a, b) matcher: a publish rename onto a real target (not a lock reclaim, not to a temp). */
export const isTarget = (_a, b) => !b.includes(".reclaim-") && !isTemp(b);
