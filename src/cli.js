import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./core.js";
import * as discover from "./discover.js";
import * as fsSafe from "../shared/node/fs-safe.js";
import { createNodeIO, SafeFsError } from "../shared/node/fs-safe.js";

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

export { createNodeIO };

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

const readOrNull = (p) => fsSafe.readOrNull(io, p);

function toSkillPath(refPath, home) {
  if (refPath === "~" || refPath.startsWith("~/")) return refPath;
  if (home !== "/" && (refPath === home || refPath.startsWith(home + "/"))) {
    return "~" + refPath.slice(home.length);
  }
  return refPath;
}

// Walks one source. Cycles are cut per branch (a directory that is its own ancestor), so two
// symlinks to the same folder still count as two path-derived ids, as in OpenCode.
function walkSkillRoot(env, root, problems) {
  const rootAbs = env.expand(root);
  const refs = [];
  let left = discover.SKILL_SCAN_BUDGET;
  const queue = [{ rel: "", ancestors: new Set() }];
  while (queue.length) {
    const { rel, ancestors } = queue.shift();
    const dirAbs = rel ? path.join(rootAbs, rel) : rootAbs;
    let realDir;
    try {
      realDir = io.realpath(dirAbs);
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
        warn(`skills: warning: skipping ${dirAbs} (${e.code === "ELOOP" ? "symlink cycle" : e.code})`);
        if (e.code !== "ELOOP") problems.push(`${dirAbs} (${e.code})`);
      }
      continue;
    }
    if (ancestors.has(realDir)) continue;
    if (left-- <= 0) {
      warn(`skills: warning: stopped scanning ${rootAbs} after ${discover.SKILL_SCAN_BUDGET} folders; some skills may be missing`);
      problems.push(`${rootAbs} (stopped after ${discover.SKILL_SCAN_BUDGET} folders)`);
      break;
    }
    let raw;
    try {
      raw = io.readdir(dirAbs);
    } catch (e) {
      if (e.code !== "ENOENT") {
        warn(`skills: warning: skipping ${dirAbs} (${e.code})`);
        problems.push(`${dirAbs} (${e.code})`);
      }
      continue;
    }
    const entries = [];
    for (const d of raw) {
      if (discover.skipName(d.name)) continue;
      if (d.isDirectory()) { entries.push({ name: d.name, kind: "directory" }); continue; }
      if (d.isFile()) { entries.push({ name: d.name, kind: "file" }); continue; }
      if (!d.isSymbolicLink()) continue;
      const ep = path.join(dirAbs, d.name);
      try {
        const st = io.stat(ep);
        if (st.isDirectory()) entries.push({ name: d.name, kind: "directory" });
        else if (st.isFile()) entries.push({ name: d.name, kind: "file" });
      } catch (e) {
        warn(`skills: warning: skipping ${ep} (${e.code === "ENOENT" ? "dangling symlink" : e.code === "ELOOP" ? "symlink cycle" : e.code}); not a skill`);
        // OpenCode ignores broken and looping links too; anything else may hide a skill.
        if (e.code !== "ENOENT" && e.code !== "ELOOP") problems.push(`${ep} (${e.code})`);
      }
    }
    const { skills, subdirs } = discover.classifySkillDir(root, rel, entries, { home: env.home });
    refs.push(...skills);
    const next = new Set(ancestors).add(realDir);
    for (const s of subdirs) queue.push({ rel: s, ancestors: next });
  }
  return refs;
}

function loadAll(env) {
  const inputs = new Map(); // every file read → text as read (null = absent)
  const opencodeText = readOrNull(env.opencodePath);
  inputs.set(env.opencodePath, opencodeText);

  const problems = []; // folders that could not be scanned: which file each id uses is then unknown
  const perRoot = discover.skillRoots(opencodeText, { home: env.home }).map((r) => walkSkillRoot(env, r, problems));
  const byId = discover.mergeSkillRefs(perRoot);
  const ids = Object.keys(byId);
  const allIds = [...new Set([...ids, ...core.BUILTIN_SKILLS])].sort();
  const skillMds = Object.create(null);
  const skillPaths = Object.create(null);
  const unreadable = [];
  for (const id of ids) {
    const ref = byId[id];
    skillPaths[id] = toSkillPath(ref.path, env.home);
    const abs = env.expand(ref.path);
    let t;
    try {
      t = readOrNull(abs);
    } catch (e) {
      if (e.code !== "EACCES" && e.code !== "EPERM" && e.code !== "EISDIR") throw e;
      warn(`skills: warning: cannot read ${abs} (${e.code})`);
      unreadable.push(id);
      continue;
    }
    inputs.set(abs, t);
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
  return { allIds, skillMds, skillPaths, problems, unreadable, state, seeded, inputs, originalBundlesText: seeded ? null : bundlesText };
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

const realTarget = (p) => fsSafe.realTarget(io, p);

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
  if (ocOld === null) throw new CliError(`${env.opencodePath} not found`);
  // Skill paths came from the config read at load; a changed `skills` list could move an id.
  const seen = ctx.inputs.get(env.opencodePath) ?? null;
  if (JSON.stringify(discover.skillRoots(seen, { home: env.home })) !== JSON.stringify(discover.skillRoots(ocOld, { home: env.home }))) {
    throw new CliError(`${env.opencodePath}: its "skills" sources changed while this command ran; nothing written, run it again`);
  }
  ctx.inputs.set(env.opencodePath, ocOld);
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
    plan = core.planChange(
      { bundlesText: ctx.originalBundlesText, opencodeText: ocOld, skillMds: ctx.skillMds, skillPaths: ctx.skillPaths, unreadable: ctx.unreadable, incomplete: ctx.problems.length > 0 },
      state,
      ctx.allIds,
      projectTexts,
      { home: env.home },
    );
  } catch (e) {
    throw new CliError(e.file === "opencode" ? `${env.opencodePath}: ${e.message}` : e.message);
  }
  for (const { id, reason } of plan.skipped) {
    const p = env.expand(ctx.skillPaths?.[id] ?? `${core.SKILLS_DIR}/${id}/SKILL.md`);
    print(`skipped ${p} (left unchanged; allow rule still applied): ${reason}`);
  }
  const where = (w) =>
    w.kind === "skill" ? env.expand(w.path)
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

// Daily backup of the global opencode.json, named after the real file (it may sit behind a
// symlink): <real>.skill-bundles-YYYYMMDD. Project files get no backup (see SPEC).
function publish(env, writes, inputs) {
  fsSafe.publish(io, writes, {
    inputs,
    rescueTag: "skill-bundles",
    backupPath: (it) => (it.kind === "opencode" ? it.real + core.backupName(new Date(io.now())).slice("opencode.json".length) : null),
  });
}

const LOCK_PROTOCOL = { parseLock: core.parseLock, classifyLock: core.classifyLock };

function acquireLock(lockPath) {
  return fsSafe.acquireLock(io, lockPath, {
    protocol: LOCK_PROTOCOL,
    busyMessage: (who) =>
      `another skills process is writing (lock ${lockPath}, ${who?.kind === "panel" ? "held by the panel" : `pid ${who?.pid ?? "?"}`}); try again`,
  });
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
    const user = e instanceof CliError || e instanceof SafeFsError;
    warn(`skills: ${user ? e.message : e.stack || e.message}`);
    return user ? 1 : 2;
  } finally {
    ({ io, print, warn } = prev);
  }
}
