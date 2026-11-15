import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./core.js";

const UNBUNDLED = core.UNBUNDLED_ID;
const MODES = core.MODES;

const HELP = `skills — turn OpenCode skills on/off in bundles

Usage:
  skills list                          bundles with on/off + counts, totals, est. prompt chars
  skills show <bundle>                 skills in a bundle with their modes
  skills on <bundle...>                enable bundles
  skills off <bundle...>               disable bundles
  skills on|off <bundle...> --project <dir>
                                       allow/stop allowing a bundle in one project only
  skills projects [<bundle>]           project dirs per bundle
  skills set <skill> auto|called|off|clear
                                       per-skill override (clear removes it)
  skills move <skill> <toBundle> [--from <bundle>] [--copy]
  skills new <name>                    create a bundle
  skills rename <bundle> <name>        rename a bundle
  skills rm <bundle>                   delete a bundle (skills are kept)
  skills sync                          re-apply files from skill-bundles.json
  skills status                        mode of every skill, grouped
  skills help                          this text

Options:
  --dry-run       print a diff of every file that would change, write nothing
  --home <dir>    use <dir> instead of ~
`;

class CliError extends Error {}

/**
 * Every persistence primitive the CLI uses. Tests wrap it to inject faults and races.
 * Paths are absolute; errors are Node fs errors (with .code).
 */
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

// Set for the duration of one (synchronous) runCli call.
let io = null;
let print = (s) => process.stdout.write(s + "\n");
let warn = (s) => process.stderr.write(s + "\n");

function parseArgs(argv) {
  const opts = { dryRun: false, home: null, from: null, copy: false, project: null };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--copy") opts.copy = true;
    else if (a === "--home" || a === "--from" || a === "--project") {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith("--home=")) opts.home = a.slice(7);
    else if (a.startsWith("--from=")) opts.from = a.slice(7);
    else if (a.startsWith("--project=")) opts.project = a.slice(10);
    else if (a === "-h" || a === "--help") pos.unshift("help");
    else if (a.startsWith("--")) throw new CliError(`unknown option ${a}`);
    else pos.push(a);
  }
  return { opts, pos };
}

function lev(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

function suggest(word, candidates) {
  const w = word.toLowerCase();
  const scored = candidates
    .map((c) => {
      const l = c.toLowerCase();
      const s = l.includes(w) || w.includes(l) ? 0 : lev(w, l);
      return [c, s];
    })
    .filter(([c, s]) => s <= Math.max(2, Math.floor(c.length / 3)))
    .sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0]));
  const names = scored.slice(0, 3).map(([c]) => c);
  return names.length ? ` Did you mean: ${names.join(", ")}?` : "";
}

function makeEnv(opts, homeDefault) {
  const home = path.resolve(opts.home ?? homeDefault);
  // project dirs stored as given form: "~/…" stays "~/…" (expanded against home only for I/O)
  const expand = (p) => (p.startsWith("~") ? path.join(home, p.slice(1)) : p);
  return {
    home,
    bundlesPath: expand(core.BUNDLES_PATH),
    opencodePath: expand(core.OPENCODE_PATH),
    skillsDir: expand(core.SKILLS_DIR),
    expand,
  };
}

function readOrNull(p) {
  try {
    return io.readFile(p);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    if (e.code === "ELOOP") throw new CliError(`${p}: symlink cycle`);
    throw e;
  }
}

function loadAll(env) {
  let entries = [];
  try {
    entries = io.readdir(env.skillsDir);
  } catch (e) {
    if (e.code !== "ENOENT") throw e; // only a missing skills dir itself means "no skills"
  }
  const ids = [];
  for (const d of entries) {
    if (d.name.startsWith(".")) continue;
    if (d.isDirectory()) { ids.push(d.name); continue; }
    if (!d.isSymbolicLink()) continue;
    try {
      if (io.stat(path.join(env.skillsDir, d.name)).isDirectory()) ids.push(d.name);
    } catch (e) {
      warn(`skills: warning: skipping ${path.join(env.skillsDir, d.name)} (${e.code === "ENOENT" ? "dangling symlink" : e.code}); not a skill`);
    }
  }
  const allIds = [...new Set([...ids, ...core.BUILTIN_SKILLS])].sort();
  const skillMds = Object.create(null);
  const inputs = new Map(); // every file read → text as read (null = absent)
  for (const id of ids) {
    const p = path.join(env.skillsDir, id, "SKILL.md");
    const t = readOrNull(p);
    inputs.set(p, t);
    if (t !== null) skillMds[id] = t;
  }
  let bundlesText = readOrNull(env.bundlesPath);
  inputs.set(env.bundlesPath, bundlesText);
  let seeded = false;
  if (bundlesText === null) {
    const seedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "default-bundles.json");
    bundlesText = io.readFile(seedPath);
    seeded = true;
  }
  let state;
  try {
    state = core.parseBundles(bundlesText, { home: env.home });
  } catch (e) {
    throw new CliError(`${seeded ? "seed" : env.bundlesPath}: ${e.message}`);
  }
  return { allIds, skillMds, state, seeded, inputs, originalBundlesText: seeded ? null : bundlesText };
}

function diff(file, oldText, newText) {
  const a = oldText === null ? [] : oldText.split("\n");
  const b = newText.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ctx = 3;
  const out = [`--- ${oldText === null ? "/dev/null" : file}`, `+++ ${file}`];
  const cs = Math.max(0, s - ctx);
  out.push(`@@ -${cs + 1} +${cs + 1} @@`);
  for (let i = cs; i < s; i++) out.push(" " + a[i]);
  // inner LCS for modest hunks so moved lines read sensibly
  const A = a.slice(s, ea), B = b.slice(s, eb);
  if (A.length * B.length <= 4e6) {
    const n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { out.push(" " + A[i]); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) out.push("+" + B[j++]);
      else out.push("-" + A[i++]);
    }
  } else {
    for (const l of A) out.push("-" + l);
    for (const l of B) out.push("+" + l);
  }
  for (let i = ea; i < Math.min(a.length, ea + ctx); i++) out.push(" " + a[i]);
  return out.join("\n");
}

const MAX_HOPS = 40;

// Follows a symlink chain to the file that should actually be written.
// A path whose parent dirs do not exist yet (e.g. a project's new .opencode/): realpath the deepest
// existing ancestor and append the missing tail, so the identity stays the same once it is created.
function resolveMissing(p) {
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

function realTarget(p) {
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
        if (!viaLink) return resolveMissing(cur);
        throw new CliError(`${p}: symlink target directory ${parent} does not exist`);
      }
      return path.join(realParent, path.basename(cur));
    }
    if (!st.isSymbolicLink()) return io.realpath(cur);
    if (hops >= MAX_HOPS) throw new CliError(`${p}: too many symlink hops (>${MAX_HOPS})`);
    if (seen.has(cur)) throw new CliError(`${p}: symlink cycle at ${cur}`);
    seen.add(cur);
    viaLink = true;
    cur = path.resolve(path.dirname(cur), io.readlink(cur));
  }
}

function modeOf(p) {
  try {
    return io.stat(p).mode & 0o777;
  } catch (e) {
    if (e.code === "ENOENT") return 0o600;
    throw e;
  }
}

const writeNew = (p, text, mode) => io.writeNew(p, text, mode);

let tmpSeq = 0;
function tempPath(real) {
  return path.join(path.dirname(real), `.${path.basename(real)}.${io.pid}.${io.now()}.${tmpSeq++}.tmp`);
}


// Physical identity of a project dir: realpath when it exists, else the expanded path.
function physicalDir(env, dir) {
  const p = env.expand(dir);
  try {
    return io.realpath(p);
  } catch (e) {
    if (e.code === "ENOENT") return path.resolve(p);
    throw new CliError(`${dir}: ${e.code === "ELOOP" ? "symlink cycle" : e.message}`);
  }
}

// Canonical dirs that are the same physical folder (symlinks, bind spellings) are merged under
// the spelling listed first: stored spellings in bundle order, then managedProjects.
function mergePhysicalAliases(env, state) {
  const order = [];
  for (const d of [...state.bundles.flatMap((b) => b.projects ?? []), ...(state.managedProjects ?? [])]) {
    if (!order.includes(d)) order.push(d);
  }
  const first = new Map();
  const aliases = Object.create(null);
  for (const d of order) {
    const key = physicalDir(env, d);
    if (first.has(key)) aliases[d] = first.get(key);
    else first.set(key, d);
  }
  if (!Object.keys(aliases).length) return state;
  for (const [a, b] of Object.entries(aliases)) warn(`skills: note: ${a} and ${b} are the same folder; using ${b}`);
  return core.mergeProjectDirs(state, aliases);
}

// Plans every file change with core.planChange, then writes them (or prints diffs).
function commit(env, ctx, state, opts) {
  for (const t of [env.opencodePath, env.bundlesPath]) realTarget(t); // clean errors for bad symlinks
  const ocOld = readOrNull(env.opencodePath);
  ctx.inputs.set(env.opencodePath, ocOld);
  if (ocOld === null) throw new CliError(`${env.opencodePath} not found`);
  state = mergePhysicalAliases(env, state);
  // every project target is an input: read it (missing → null) and snapshot it like any other
  const projectTexts = Object.create(null);
  for (const dir of core.projectTargets(state, { home: env.home })) {
    const file = env.expand(core.projectConfigPath(dir));
    realTarget(file);
    const t = ctx.inputs.has(file) ? ctx.inputs.get(file) : readOrNull(file);
    ctx.inputs.set(file, t);
    projectTexts[dir] = t;
  }
  let plan;
  try {
    plan = core.planChange({ bundlesText: ctx.originalBundlesText, opencodeText: ocOld, skillMds: ctx.skillMds }, state, ctx.allIds, projectTexts, { home: env.home });
  } catch (e) {
    throw new CliError(e.file === "opencode" ? `${env.opencodePath}: ${e.message}` : e.message);
  }
  for (const { id, reason } of plan.skipped) {
    print(`skipped skills/${id}/SKILL.md (left unchanged; allow rule still applied): ${reason}`);
  }
  const where = (w) =>
    w.kind === "skill" ? path.join(env.skillsDir, w.id, "SKILL.md")
    : w.kind === "project" ? env.expand(w.path)
    : w.kind === "opencode" ? env.opencodePath
    : env.bundlesPath;
  const writes = plan.writes.map((w) => ({ ...w, file: where(w) }));
  if (opts.dryRun) {
    if (!writes.length) print("(dry run) no changes");
    for (const w of writes) print(diff(w.file, w.before, w.after));
    return writes.length;
  }
  publish(env, writes, ctx.inputs);
  // keep ctx in step with disk, so later commits in this run start from what was written
  for (const w of writes) {
    ctx.inputs.set(w.file, w.after);
    if (w.kind === "skill") ctx.skillMds[w.id] = w.after;
    if (w.kind === "bundles") ctx.originalBundlesText = w.after;
  }
  ctx.state = plan.state;
  return writes.length;
}

class Conflict extends CliError {}

function stamp() {
  return new Date(io.now()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
}

// Unique rescue copy: <file>.skill-bundles-rescue-<ts>-<pid>-<random>, exclusive create, retry on clash.
function writeRescue(real, text, mode) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const p = `${real}.skill-bundles-rescue-${stamp()}-${io.pid}-${io.randomId()}`;
    try {
      writeNew(p, text, mode);
      return p;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new Error(`could not create a unique rescue file for ${real}`);
}

// Daily backup: temp (exclusive, fsynced) then link() so a half-written backup never gets the final name.
function backupOnce(bak, text, mode) {
  const checkExisting = () => {
    let st;
    try {
      st = io.lstat(bak);
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
    if (!st.isFile()) throw new CliError(`${bak}: existing backup is not a regular file; move it away and re-run`);
    try {
      io.readFile(bak);
    } catch (e) {
      throw new CliError(`${bak}: existing backup is not readable (${e.code}); move it away and re-run`);
    }
    return true;
  };
  if (checkExisting()) return;
  const tmp = tempPath(bak);
  try {
    writeNew(tmp, text, mode);
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

// All-or-nothing publish (caller holds the writer lock): verify inputs, backup, temps for
// every file, renames in core.PUBLISH_ORDER (SKILL.md, opencode.json, skill-bundles.json last),
// rollback on failure that never clobbers someone else's newer content.
function publish(env, writes, inputs) {
  // planChange already returns writes in PUBLISH_ORDER; keep that order.
  const items = writes.map((w) => {
    const real = realTarget(w.file);
    return { p: w.file, kind: w.kind, real, old: w.before, next: w.after, mode: modeOf(real), tmp: null };
  });

  const verifyTarget = (it) => {
    let now;
    try {
      now = realTarget(it.p);
    } catch (e) {
      throw new Conflict(`${it.p}: target changed on disk (${e.message}), re-run`);
    }
    if (now !== it.real) throw new Conflict(`${it.p}: symlink now points elsewhere (${it.real} → ${now}), re-run`);
  };
  // One read per file per pass: an output whose real path is its own path and that is already
  // checked as an input (same expected text) is not read a second time.
  const verifyInputs = () => {
    for (const it of items) verifyTarget(it);
    for (const [p, text] of inputs) {
      if (readOrNull(p) !== text) throw new Conflict(`${p}: file changed on disk, re-run`);
    }
    for (const it of items) {
      if (it.real === it.p && inputs.has(it.p) && inputs.get(it.p) === it.old) continue;
      if (readOrNull(it.real) !== it.old) throw new Conflict(`${it.p}: file changed on disk, re-run`);
    }
  };

  verifyInputs();
  const oc = items.find((it) => it.kind === "opencode");
  // named after the real file (it may sit behind a symlink): <real>.skill-bundles-YYYYMMDD
  if (oc && oc.old !== null) backupOnce(oc.real + core.backupName(new Date(io.now())).slice("opencode.json".length), oc.old, oc.mode);

  try {
    for (const it of items) {
      io.mkdirp(path.dirname(it.real));
      const tmp = tempPath(it.real);
      writeNew(tmp, it.next, it.mode);
      it.tmp = tmp;
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
        if (readOrNull(it.real) !== it.next) {
          // someone else wrote after us: leave theirs, keep our original aside
          if (it.old !== null) {
            const rescue = writeRescue(it.real, it.old, it.mode);
            rescued.push(`${it.p} (original kept in ${rescue})`);
          } else rescued.push(`${it.p} (left as is)`);
          continue;
        }
        if (it.old === null) io.unlink(it.real);
        else {
          const t = tempPath(it.real);
          writeNew(t, it.old, it.mode);
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
    throw new CliError(`${e.message}${msg}`);
  }
}

// ---------- writer lock ----------

// Reads and judges the lock with core.parseLock / core.classifyLock. `stale` covers both
// "free" (released marker) and "stale"; either may be reclaimed.
function lockIsStale(lockPath) {
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
    throw new CliError(`cannot read lock ${lockPath} (${e.code}); check its permissions`);
  }
  const info = core.parseLock(text);
  const verdict = core.classifyLock(info, { now: io.now(), mtimeMs: st.mtimeMs, pidAlive: io.pidAlive, host: io.hostname() });
  return { stale: verdict !== "held", info, text };
}

function acquireLock(lockPath) {
  const token = io.randomId() + io.randomId();
  const body = JSON.stringify({ pid: io.pid, host: io.hostname(), time: io.now(), token }) + "\n";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeNew(lockPath, body, 0o600);
      return () => {
        try {
          if (io.readFile(lockPath) === body) io.unlink(lockPath);
        } catch {}
      };
    } catch (e) {
      if (e.code === "ENOENT") throw new CliError(`${path.dirname(lockPath)} does not exist`);
      if (e.code !== "EEXIST") throw e;
    }
    const { stale, info, text } = lockIsStale(lockPath);
    const busy = (who) =>
      new CliError(`another skills process is writing (lock ${lockPath}, ${who?.kind === "panel" ? "held by the panel" : `pid ${who?.pid ?? "?"}`}); try again`);
    if (!stale) throw busy(info);
    if (text === null) continue; // vanished (or unreadable): just retry O_EXCL
    // Reclaim atomically: move the judged lock aside, and only discard it if it is still exactly
    // what we judged free/stale. If the panel (or anyone) re-acquired in between, put theirs back.
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
      const who = grabbed === null ? null : core.parseLock(grabbed);
      if (!restored) throw new CliError(`lock ${lockPath} changed while reclaiming; try again`);
      throw busy(who);
    }
    try { io.unlink(grab); } catch {}
  }
  throw new CliError(`could not take lock ${lockPath}; try again`);
}

function resolveBundle(state, ref, { allowUnbundled = false } = {}) {
  if (allowUnbundled && (ref === UNBUNDLED || ref.toLowerCase() === "unbundled")) return UNBUNDLED;
  const bs = state.bundles;
  const hit = bs.find((b) => b.id === ref) ?? bs.find((b) => b.name.toLowerCase() === ref.toLowerCase());
  if (hit) return hit.id;
  throw new CliError(`unknown bundle "${ref}".${suggest(ref, bs.map((b) => b.id))}`);
}

function resolveSkill(ctx, ref) {
  if (ctx.allIds.includes(ref)) return ref;
  throw new CliError(`unknown skill "${ref}".${suggest(ref, ctx.allIds)}`);
}

function need(pos, n, usage) {
  if (pos.length < n) throw new CliError(`usage: skills ${usage}`);
}

function bundleLine(g, state) {
  const on = g.skills.filter((id) => core.effectiveMode(state, id) !== "off").length;
  const flag = g.synthetic ? "   " : g.enabled ? "on " : "off";
  const n = state.bundles.find((b) => b.id === g.id)?.projects?.length ?? 0;
  const proj = n ? ` +${n} project${n === 1 ? "" : "s"}` : "";
  return `${flag}  ${g.id.padEnd(16)} ${`${on}/${g.skills.length} on`.padEnd(11)} ${g.name}${proj}`;
}

// "--project <dir>": absolute stays, "~"/"~/…" stays "~/…", anything else is resolved against cwd.
function projectArg(dir) {
  if (dir === "~" || dir === "~/") throw new CliError("--project: use a project directory, not your home directory");
  if (dir.startsWith("~/") || path.isAbsolute(dir)) return dir;
  return path.resolve(process.cwd(), dir);
}

function totals(state, allIds) {
  const t = core.summary(state, allIds);
  return `${t.on}/${allIds.length} skills on (${t.auto} auto, ${t.called} called) · ~${t.chars.toLocaleString("en-US")} prompt chars`;
}

function main(argv, homeDefault) {
  const { opts, pos } = parseArgs(argv);
  const cmd = pos.shift() ?? "help";
  if (cmd === "help") { print(HELP.replace(/\n$/, "")); return 0; }
  const env = makeEnv(opts, homeDefault);
  if (opts.dryRun) return run(env, opts, pos, cmd); // zero writes: no lock, no mkdir
  io.mkdirp(path.dirname(env.bundlesPath));
  const release = acquireLock(path.join(path.dirname(env.bundlesPath), ".skill-bundles.lock"));
  try {
    return run(env, opts, pos, cmd);
  } finally {
    release();
  }
}

function run(env, opts, pos, cmd) {
  const ctx = loadAll(env);
  let state = ctx.state;
  const dry = opts.dryRun ? " (dry run)" : "";

  const mutate = (next, summary) => {
    const n = commit(env, ctx, next, opts);
    print(`${summary}${dry} — ${n} file${n === 1 ? "" : "s"} ${opts.dryRun ? "would change" : "changed"}`);
    return 0;
  };

  // A missing skill-bundles.json gets seeded and synced before anything else.
  if (ctx.seeded && !opts.dryRun) {
    commit(env, ctx, state, opts); // updates ctx in place
    ctx.seeded = false;
    print(`seeded ${env.bundlesPath} from defaults`);
  }

  // Stored spellings of one physical folder are merged before any mutation, so `off --project`
  // removes the assignment whichever spelling it was stored under.
  if (cmd === "on" || cmd === "off") state = mergePhysicalAliases(env, state);

  switch (cmd) {
    case "list": {
      if (ctx.seeded && opts.dryRun) commit(env, ctx, state, opts);
      for (const g of core.groups(state, ctx.allIds)) print(bundleLine(g, state));
      print(totals(state, ctx.allIds));
      return 0;
    }
    case "status": {
      if (ctx.seeded && opts.dryRun) commit(env, ctx, state, opts);
      for (const g of core.groups(state, ctx.allIds)) {
        print(`${g.name} [${g.id}]${g.synthetic ? "" : g.enabled ? " on" : " off"}`);
        for (const id of g.skills) {
          const ov = state.overrides?.[id] ? " (override)" : "";
          print(`  ${core.effectiveMode(state, id).padEnd(6)} ${id}${ov}`);
        }
      }
      print(totals(state, ctx.allIds));
      return 0;
    }
    case "show": {
      need(pos, 1, "show <bundle>");
      const id = resolveBundle(state, pos[0], { allowUnbundled: true });
      const g = core.groups(state, ctx.allIds).find((x) => x.id === id);
      print(bundleLine(g, state));
      for (const s of g.skills) {
        const ov = state.overrides?.[s] ? " (override)" : "";
        print(`  ${core.effectiveMode(state, s).padEnd(6)} ${s}${ov}`);
      }
      return 0;
    }
    case "on":
    case "off": {
      need(pos, 1, `${cmd} <bundle...>`);
      const ids = pos.map((r) => resolveBundle(state, r));
      if (opts.project !== null) {
        let dir;
        try {
          dir = core.normalizeProjectDir(projectArg(opts.project), { home: env.home });
          if (dir === "~") throw new Error("--project: use a project directory, not your home directory");
          if (cmd === "on") {
            let st = null;
            try { st = io.stat(env.expand(dir)); } catch {}
            if (!st?.isDirectory()) throw new Error(`project directory ${dir} does not exist`);
          }
          // an alias of a dir already stored is the same project: use the stored spelling
          const key = physicalDir(env, dir);
          const stored = [...state.bundles.flatMap((b) => b.projects ?? []), ...(state.managedProjects ?? [])]
            .find((d) => d !== dir && physicalDir(env, d) === key);
          if (stored) dir = stored;
          for (const id of ids) state = cmd === "on" ? core.addBundleProject(state, id, dir, { home: env.home }) : core.removeBundleProject(state, id, dir, { home: env.home });
        } catch (e) {
          throw new CliError(e.message);
        }
        return mutate(state, `${cmd === "on" ? "allowed" : "stopped allowing"} ${ids.join(", ")} in ${dir}`);
      }
      for (const id of ids) state = core.setBundleEnabled(state, id, cmd === "on");
      return mutate(state, `${cmd === "on" ? "enabled" : "disabled"} ${ids.join(", ")}; ${totals(state, ctx.allIds)}`);
    }
    case "set": {
      need(pos, 2, "set <skill> auto|called|off|clear");
      const id = resolveSkill(ctx, pos[0]);
      const m = pos[1];
      if (m !== "clear" && !MODES.includes(m)) throw new CliError(`unknown mode "${m}" (use auto, called, off or clear)`);
      state = core.setOverride(state, id, m === "clear" ? null : m);
      return mutate(state, `${id}: ${m === "clear" ? "override cleared" : m} → ${core.effectiveMode(state, id)}`);
    }
    case "move": {
      need(pos, 2, "move <skill> <toBundle> [--from <bundle>] [--copy]");
      const id = resolveSkill(ctx, pos[0]);
      const to = resolveBundle(state, pos[1]);
      let from;
      if (opts.from) from = resolveBundle(state, opts.from, { allowUnbundled: true });
      else from = state.bundles.find((b) => b.skills.includes(id))?.id ?? UNBUNDLED;
      if (from !== UNBUNDLED && !state.bundles.find((b) => b.id === from).skills.includes(id))
        throw new CliError(`skill "${id}" is not in bundle "${from}"`);
      state = core.moveSkill(state, id, from === UNBUNDLED ? null : from, to, { copy: opts.copy });
      return mutate(state, `${opts.copy ? "copied" : "moved"} ${id} ${from} → ${to}`);
    }
    case "new": {
      need(pos, 1, "new <name>");
      const name = pos.join(" ");
      const before = new Set(state.bundles.map((b) => b.id));
      state = core.createBundle(state, name);
      const nb = state.bundles.find((b) => !before.has(b.id));
      return mutate(state, `created bundle ${nb ? nb.id : name}`);
    }
    case "rename": {
      need(pos, 2, "rename <bundle> <name>");
      const id = resolveBundle(state, pos[0]);
      const name = pos.slice(1).join(" ");
      state = core.renameBundle(state, id, name);
      return mutate(state, `renamed ${id} → "${name}"`);
    }
    case "rm": {
      need(pos, 1, "rm <bundle>");
      const id = resolveBundle(state, pos[0]);
      state = core.deleteBundle(state, id);
      return mutate(state, `deleted bundle ${id}`);
    }
    case "sync":
      return mutate(state, `synced; ${totals(state, ctx.allIds)}`);
    case "projects": {
      const bs = pos.length ? pos.map((r) => state.bundles.find((b) => b.id === resolveBundle(state, r))) : state.bundles;
      let any = false;
      for (const b of bs) {
        if (!pos.length && !b.projects?.length) continue;
        any = true;
        print(`${b.id}${b.projects?.length ? "" : " (no projects)"}`);
        for (const d of b.projects ?? []) print(`  ${d}`);
      }
      if (!any) print("no bundle has projects");
      const orphan = (state.managedProjects ?? []).filter((d) => !state.bundles.some((b) => (b.projects ?? []).includes(d)));
      if (!pos.length && orphan.length) print(`pending rule removal: ${orphan.join(", ")} (run "skills sync")`);
      return 0;
    }
    default:
      throw new CliError(`unknown command "${cmd}".${suggest(cmd, ["list", "show", "on", "off", "set", "move", "new", "rename", "rm", "sync", "status", "projects", "help"])} Run "skills help".`);
  }
}

/**
 * Runs one CLI invocation in-process and returns its exit code (0 ok, 1 user error, 2 bug).
 * options.io: persistence layer (default createNodeIO()); options.env: environment (HOME);
 * options.stdout / options.stderr: { write(text) } sinks (default the process streams).
 */
export function runCli(argv, options = {}) {
  const prev = { io, print, warn };
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  io = options.io ?? createNodeIO();
  print = (s) => stdout.write(s + "\n");
  warn = (s) => stderr.write(s + "\n");
  const env = options.env ?? process.env;
  try {
    return main(argv, env.HOME || os.homedir());
  } catch (e) {
    warn(`skills: ${e instanceof CliError ? e.message : e.stack || e.message}`);
    return e instanceof CliError ? 1 : 2;
  } finally {
    ({ io, print, warn } = prev);
  }
}
