/**
 * @module shared/node/fs-safe
 * File safety for Node CLIs. Everything takes an injected `io` (createNodeIO() for real disks;
 * tests wrap it to inject faults and races), so no function touches `fs` directly.
 * - realTarget: follow a symlink chain (cycle/hop limits) to the file that should be written; a
 *   path whose parents don't exist yet resolves through its deepest existing ancestor.
 * - publish: all-or-nothing multi-file write. Snapshot check of every input, optional once-a-day
 *   backup, exclusive mode-preserving temps, renames in the given order, rollback that never
 *   overwrites someone else's newer content (their file stays; ours goes to a rescue file).
 * - acquireLock: exclusive-create lock with reclaim of free/stale locks via rename-aside, judged
 *   by an injected protocol (see shared/core/lock.js).
 * Errors meant for the user are SafeFsError (ConflictError when a file changed under us);
 * anything else is an unexpected fs error and propagates as is.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A user-facing failure (bad symlink, conflict, lock busy, failed publish). */
export class SafeFsError extends Error {}
/** A file changed on disk since it was read; re-running is the fix. */
export class ConflictError extends SafeFsError {}

/**
 * @typedef {object} IO every persistence primitive; paths are absolute; errors are Node fs errors (with .code)
 * @property {(p: string) => string} readFile utf8
 * @property {(p: string) => import("node:fs").Dirent[]} readdir withFileTypes
 * @property {(p: string) => import("node:fs").Stats} stat
 * @property {(p: string) => import("node:fs").Stats} lstat
 * @property {(p: string) => string} realpath
 * @property {(p: string) => string} readlink
 * @property {(p: string) => void} mkdirp
 * @property {(p: string, text: string, mode: number) => void} writeNew exclusive create, exact mode, fsynced
 * @property {(a: string, b: string) => void} rename
 * @property {(a: string, b: string) => void} link
 * @property {(p: string) => void} unlink
 * @property {(pid: number) => boolean} pidAlive
 * @property {() => string} hostname
 * @property {number} pid
 * @property {() => number} now
 * @property {() => string} randomId
 */

/** @returns {IO} */
export function createNodeIO() {
  return {
    readFile: (p) => fs.readFileSync(p, "utf8"),
    readdir: (p) => fs.readdirSync(p, { withFileTypes: true }),
    stat: (p) => fs.statSync(p),
    lstat: (p) => fs.lstatSync(p),
    realpath: (p) => fs.realpathSync(p),
    readlink: (p) => fs.readlinkSync(p),
    mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
    // Exclusive create with exact mode (umask can only narrow it; fchmod pins it), fsynced.
    writeNew: (p, text, mode) => {
      const fd = fs.openSync(p, "wx", mode);
      try {
        fs.writeFileSync(fd, text);
        fs.fchmodSync(fd, mode);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    rename: (a, b) => fs.renameSync(a, b),
    link: (a, b) => fs.linkSync(a, b),
    unlink: (p) => fs.unlinkSync(p),
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return e.code === "EPERM";
      }
    },
    hostname: () => os.hostname(),
    pid: process.pid,
    now: () => Date.now(),
    randomId: () => Math.random().toString(36).slice(2, 10),
  };
}

/** File text, or null when missing. A symlink cycle is a SafeFsError. */
export function readOrNull(io, p) {
  try {
    return io.readFile(p);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    if (e.code === "ELOOP") throw new SafeFsError(`${p}: symlink cycle`);
    throw e;
  }
}

/**
 * For a path whose parent dirs don't exist yet: realpath the deepest existing ancestor and append
 * the missing tail, so the identity stays the same once the dirs are created.
 */
export function resolveMissing(io, p) {
  const tail = [];
  let cur = p;
  for (;;) {
    const up = path.dirname(cur);
    tail.unshift(path.basename(cur));
    if (up === cur) return p;
    cur = up;
    try {
      return path.join(io.realpath(cur), ...tail);
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
    }
  }
}

/**
 * The file that writing `p` should actually replace: follows the symlink chain (so links stay
 * links). Throws SafeFsError on a cycle, too many hops, or a dangling link whose target dir is missing.
 */
export function realTarget(io, p, { maxHops = 40 } = {}) {
  const seen = new Set();
  let cur = path.resolve(p);
  let viaLink = false;
  for (let hops = 0; ; hops++) {
    let st;
    try {
      st = io.lstat(cur);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const parent = path.dirname(cur);
      let realParent;
      try {
        realParent = io.realpath(parent);
        if (!io.stat(realParent).isDirectory()) throw new Error("not a directory");
      } catch {
        if (!viaLink) return resolveMissing(io, cur);
        throw new SafeFsError(`${p}: symlink target directory ${parent} does not exist`);
      }
      return path.join(realParent, path.basename(cur));
    }
    if (!st.isSymbolicLink()) return io.realpath(cur);
    if (hops >= maxHops) throw new SafeFsError(`${p}: too many symlink hops (>${maxHops})`);
    if (seen.has(cur)) throw new SafeFsError(`${p}: symlink cycle at ${cur}`);
    seen.add(cur);
    viaLink = true;
    cur = path.resolve(path.dirname(cur), io.readlink(cur));
  }
}

/** Permission bits of `p`; 0o600 for a file that doesn't exist yet. */
export function modeOf(io, p) {
  try {
    return io.stat(p).mode & 0o777;
  } catch (e) {
    if (e.code === "ENOENT") return 0o600;
    throw e;
  }
}

let tmpSeq = 0;
/** A unique hidden temp name next to `real` (same dir, so rename is atomic). */
export function tempPath(io, real) {
  return path.join(path.dirname(real), `.${path.basename(real)}.${io.pid}.${io.now()}.${tmpSeq++}.tmp`);
}

function stamp(io) {
  return new Date(io.now()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
}

/**
 * Writes `text` to a new `<real>.<tag>-rescue-<UTC ts>-<pid>-<random>` (exclusive; retried on a
 * name clash). Returns its path.
 */
export function writeRescue(io, real, text, mode, { tag }) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const p = `${real}.${tag}-rescue-${stamp(io)}-${io.pid}-${io.randomId()}`;
    try {
      io.writeNew(p, text, mode);
      return p;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new Error(`could not create a unique rescue file for ${real}`);
}

/**
 * Creates backup `bak` once: temp (exclusive, fsynced), then link() so a half-written backup never
 * gets the final name. An existing backup is kept, but must be a readable regular file.
 */
export function backupOnce(io, bak, text, mode) {
  const checkExisting = () => {
    let st;
    try {
      st = io.lstat(bak);
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
    if (!st.isFile()) throw new SafeFsError(`${bak}: existing backup is not a regular file; move it away and re-run`);
    try {
      io.readFile(bak);
    } catch (e) {
      throw new SafeFsError(`${bak}: existing backup is not readable (${e.code}); move it away and re-run`);
    }
    return true;
  };
  if (checkExisting()) return;
  const tmp = tempPath(io, bak);
  try {
    io.writeNew(tmp, text, mode);
    try {
      io.link(tmp, bak);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      checkExisting();
    }
  } finally {
    try { io.unlink(tmp); } catch {}
  }
}

/**
 * @typedef {{file: string, before: string|null, after: string, [k: string]: any}} Write
 *   file: absolute path as the user names it (may be a symlink); before: text as read (null = absent)
 */

/**
 * All-or-nothing publish of `writes`, renamed in the given order. The caller holds the lock.
 * 1. every input (Map path → text as read, null = absent) and every target must be unchanged,
 *    and no target symlink may point elsewhere (ConflictError);
 * 2. optional backup of a target: backupPath(item) → path|null, item = {...write, real, mode};
 * 3. temps for every target (same mode as the file); any failure → temps removed, nothing published;
 * 4. inputs checked again; then renames, re-checking each target's real path first;
 * 5. a failed rename rolls back the targets already renamed: our content → original restored
 *    (a created file is removed); someone else's content → left, our original saved as a rescue.
 * The step-5 error is a SafeFsError summarizing what was restored and rescued.
 * @param {IO} io
 * @param {Write[]} writes
 * @param {{inputs?: Map<string, string|null>, backupPath?: (item: any) => string|null, rescueTag: string}} opts
 */
export function publish(io, writes, { inputs = new Map(), backupPath, rescueTag }) {
  const items = writes.map((w) => {
    const real = realTarget(io, w.file);
    return { ...w, p: w.file, real, old: w.before, next: w.after, mode: modeOf(io, real), tmp: null };
  });
  const seen = new Map();
  for (const it of items) {
    if (seen.has(it.real)) throw new SafeFsError(`${seen.get(it.real)} and ${it.p} are the same file; merge them into one write`);
    seen.set(it.real, it.p);
  }

  const verifyTarget = (it) => {
    let now;
    try {
      now = realTarget(io, it.p);
    } catch (e) {
      throw new ConflictError(`${it.p}: target changed on disk (${e.message}), re-run`);
    }
    if (now !== it.real) throw new ConflictError(`${it.p}: symlink now points elsewhere (${it.real} → ${now}), re-run`);
  };
  // One read per file per pass: an output whose real path is its own path and that is already
  // checked as an input (same expected text) is not read a second time.
  const verifyInputs = () => {
    for (const it of items) verifyTarget(it);
    for (const [p, text] of inputs) {
      if (readOrNull(io, p) !== text) throw new ConflictError(`${p}: file changed on disk, re-run`);
    }
    for (const it of items) {
      if (it.real === it.p && inputs.has(it.p) && inputs.get(it.p) === it.old) continue;
      if (readOrNull(io, it.real) !== it.old) throw new ConflictError(`${it.p}: file changed on disk, re-run`);
    }
  };

  verifyInputs();
  for (const it of items) {
    const bak = backupPath?.(it);
    if (bak && it.old !== null) backupOnce(io, bak, it.old, it.mode);
  }

  try {
    for (const it of items) {
      io.mkdirp(path.dirname(it.real));
      it.tmp = tempPath(io, it.real); // recorded first, so a write that fails halfway is cleaned up
      io.writeNew(it.tmp, it.next, it.mode);
    }
    verifyInputs();
  } catch (e) {
    for (const it of items) if (it.tmp) try { io.unlink(it.tmp); } catch {}
    throw e;
  }

  const done = [];
  try {
    for (const it of items) {
      verifyTarget(it); // realpath only; content was verified once just before this loop
      io.rename(it.tmp, it.real);
      it.tmp = null;
      done.push(it);
    }
  } catch (e) {
    const failed = [];
    const rescued = [];
    for (const it of done.reverse()) {
      try {
        if (readOrNull(io, it.real) !== it.next) {
          // someone else wrote after us: leave theirs, keep our original aside
          if (it.old !== null) {
            const rescue = writeRescue(io, it.real, it.old, it.mode, { tag: rescueTag });
            rescued.push(`${it.p} (original kept in ${rescue})`);
          } else rescued.push(`${it.p} (left as is)`);
          continue;
        }
        if (it.old === null) io.unlink(it.real);
        else {
          const t = tempPath(io, it.real);
          io.writeNew(t, it.old, it.mode);
          io.rename(t, it.real);
        }
      } catch {
        failed.push(it.p);
      }
    }
    for (const it of items) if (it.tmp) try { io.unlink(it.tmp); } catch {}
    let msg = "; earlier files restored";
    if (rescued.length) msg += `; changed by someone else, not restored: ${rescued.join(", ")}`;
    if (failed.length) msg += `; could not restore: ${failed.join(", ")}`;
    throw new SafeFsError(`${e.message}${msg}`);
  }
}

/**
 * Reads and judges a lock file. `stale` is true for both "free" and "stale" verdicts.
 * @param {IO} io
 * @param {string} lockPath
 * @param {{parseLock: (text: string) => any, classifyLock: (info: any, opts: object) => string}} protocol
 */
export function inspectLock(io, lockPath, protocol) {
  let st, text;
  try {
    st = io.lstat(lockPath);
  } catch (e) {
    if (e.code === "ENOENT") return { stale: true, info: null, text: null };
    throw e;
  }
  try {
    text = io.readFile(lockPath);
  } catch (e) {
    if (e.code === "ENOENT") return { stale: true, info: null, text: null };
    throw new SafeFsError(`cannot read lock ${lockPath} (${e.code}); check its permissions`);
  }
  const info = protocol.parseLock(text);
  const verdict = protocol.classifyLock(info, { now: io.now(), mtimeMs: st.mtimeMs, pidAlive: io.pidAlive, host: io.hostname() });
  return { stale: verdict !== "held", info, text };
}

/**
 * Takes `lockPath` by exclusive create, writing `{"pid","host","time","token"}\n` (mode 0600).
 * A free or stale lock is reclaimed atomically: renamed aside, and discarded only if it is still
 * exactly what was judged; if someone re-acquired in between, theirs is linked back (never
 * overwritten) and the lock counts as busy. Returns release(), which deletes the lock only if it
 * still holds our record.
 * @param {IO} io
 * @param {string} lockPath
 * @param {{protocol: {parseLock: Function, classifyLock: Function}, busyMessage: (info: any) => string}} opts
 * @returns {() => void}
 */
export function acquireLock(io, lockPath, { protocol, busyMessage }) {
  const token = io.randomId() + io.randomId();
  const body = JSON.stringify({ pid: io.pid, host: io.hostname(), time: io.now(), token }) + "\n";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      io.writeNew(lockPath, body, 0o600);
      return () => {
        try {
          if (io.readFile(lockPath) === body) io.unlink(lockPath);
        } catch {}
      };
    } catch (e) {
      if (e.code === "ENOENT") throw new SafeFsError(`${path.dirname(lockPath)} does not exist`);
      if (e.code !== "EEXIST") throw e;
    }
    const { stale, info, text } = inspectLock(io, lockPath, protocol);
    const busy = (who) => new SafeFsError(busyMessage(who));
    if (!stale) throw busy(info);
    if (text === null) continue; // vanished (or unreadable): just retry the exclusive create
    const grab = `${lockPath}.reclaim-${io.pid}-${token}`;
    try {
      io.rename(lockPath, grab);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    let grabbed = null;
    try { grabbed = io.readFile(grab); } catch {}
    if (grabbed !== text) {
      let restored = false;
      try { io.link(grab, lockPath); restored = true; } catch {}
      try { io.unlink(grab); } catch {}
      const who = grabbed === null ? null : protocol.parseLock(grabbed);
      if (!restored) throw new SafeFsError(`lock ${lockPath} changed while reclaiming; try again`);
      throw busy(who);
    }
    try { io.unlink(grab); } catch {}
  }
  throw new SafeFsError(`could not take lock ${lockPath}; try again`);
}
