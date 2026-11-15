import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin", "skills");
const FIX = path.join(here, "fixtures");
const core = await import("../src/core.js");
const { backupName } = core;

const tempDirs = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
after(() => {
  for (const d of tempDirs) {
    try { fs.chmodSync(path.join(d, ".config/opencode"), 0o755); } catch {}
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeHome({ bundles = true } = {}) {
  const home = tmpDir("skills-cli-");
  fs.cpSync(path.join(FIX, "home"), home, { recursive: true });
  if (bundles) fs.copyFileSync(path.join(FIX, "skill-bundles.json"), path.join(home, ".config/opencode/skill-bundles.json"));
  return home;
}
const oc = (h) => path.join(h, ".config/opencode");
const read = (h, rel) => fs.readFileSync(path.join(oc(h), rel), "utf8");
const json = (h, rel) => JSON.parse(read(h, rel));
function run(home, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--home", home], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function snapshot(dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) { const p = path.join(e.parentPath ?? e.path, e.name); out[p] = fs.readFileSync(p, "utf8"); }
  }
  return out;
}
const skillRules = (h) => json(h, "opencode.json").permissions.filter((r) => r.action === "skill");

test("help exits 0", () => {
  const r = spawnSync(process.execPath, [BIN, "help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skills list/);
});

test("list shows bundles, counts and totals", () => {
  const h = makeHome();
  const r = run(h, "list");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^on\s+dev\s+2\/2 on/m);
  assert.match(r.out, /^off\s+docs\s+0\/1 on/m);
  assert.match(r.out, /__unbundled/);
  // alpha auto + gamma called = 2 on; only alpha advertised -> 180
  assert.match(r.out, /2\/5 skills on \(1 auto, 1 called\) · ~180 prompt chars/);
  assert.ok(!r.out.includes(".hidden"));
});

test("on writes permissions, preserves other rules/keys, backs up", () => {
  const h = makeHome();
  const before = json(h, "opencode.json");
  const r = run(h, "on", "docs");
  assert.equal(r.code, 0, r.err);
  const after = json(h, "opencode.json");
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual(after.mcp, before.mcp);
  assert.deepEqual(after.permissions.filter((x) => x.action !== "skill"), before.permissions.filter((x) => x.action !== "skill"));
  assert.deepEqual(skillRules(h).map((x) => [x.resource, x.effect]), [["*", "deny"], ["alpha", "allow"], ["beta", "allow"], ["gamma", "allow"]]);
  assert.ok(read(h, "opencode.json").endsWith("}\n"));
  const baks = fs.readdirSync(oc(h)).filter((f) => f.startsWith("opencode.json.skill-bundles-"));
  assert.equal(baks.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(oc(h), baks[0]), "utf8")), before);
  assert.equal(json(h, "skill-bundles.json").bundles.find((b) => b.id === "docs").enabled, true);
  assert.ok(!fs.readdirSync(oc(h)).some((f) => f.endsWith(".tmp")));
});

test("set called edits nested-metadata SKILL.md surgically; auto reverts", () => {
  const h = makeHome();
  const orig = read(h, "skills/alpha/SKILL.md");
  assert.equal(run(h, "set", "alpha", "called").code, 0);
  const t = read(h, "skills/alpha/SKILL.md");
  assert.match(t, /metadata:\n  opencode\/autoinvoke: false\n  info:\n    tags:/);
  assert.equal(t.replace("  opencode/autoinvoke: false\n", ""), orig);
  assert.equal(run(h, "set", "alpha", "auto").code, 0);
  assert.equal(read(h, "skills/alpha/SKILL.md"), orig);
});

test("called on skill without metadata adds block", () => {
  const h = makeHome();
  assert.equal(run(h, "set", "beta", "called").code, 0);
  assert.match(read(h, "skills/beta/SKILL.md"), /metadata:\n  opencode\/autoinvoke: false\n---/);
  assert.ok(skillRules(h).some((x) => x.resource === "beta"));
});

test("clear override returns to bundle state", () => {
  const h = makeHome();
  assert.equal(run(h, "set", "gamma", "clear").code, 0);
  assert.ok(!("gamma" in (json(h, "skill-bundles.json").overrides ?? {})));
  assert.doesNotMatch(read(h, "skills/gamma/SKILL.md"), /autoinvoke/);
});

test("dry-run prints diff and writes nothing", () => {
  const h = makeHome();
  const snap = snapshot(h);
  const r = run(h, "off", "dev", "--dry-run");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^--- .*opencode\.json$/m);
  assert.match(r.out, /^-.*"alpha"/m);
  assert.match(r.out, /skill-bundles\.json/);
  assert.deepEqual(snapshot(h), snap);
});

test("unknown bundle/skill/command: non-zero with suggestions", () => {
  const h = makeHome();
  let r = run(h, "on", "dvv");
  assert.notEqual(r.code, 0);
  assert.match(r.err, /unknown bundle "dvv".*dev/);
  r = run(h, "set", "alhpa", "auto");
  assert.notEqual(r.code, 0);
  assert.match(r.err, /unknown skill "alhpa".*alpha/);
  r = run(h, "set", "alpha", "maybe");
  assert.notEqual(r.code, 0);
  r = run(h, "lsit");
  assert.notEqual(r.code, 0);
  assert.match(r.err, /list/);
});

test("new, move, copy, rename, rm", () => {
  const h = makeHome();
  assert.equal(run(h, "new", "Extra stuff").code, 0);
  let s = json(h, "skill-bundles.json");
  const nb = s.bundles.find((b) => b.name === "Extra stuff");
  assert.ok(nb);
  assert.equal(run(h, "move", "beta", nb.id).code, 0);
  s = json(h, "skill-bundles.json");
  assert.deepEqual(s.bundles.find((b) => b.id === "docs").skills, []);
  assert.ok(s.bundles.find((b) => b.id === nb.id).skills.includes("beta"));
  assert.equal(run(h, "move", "alpha", "docs", "--copy").code, 0);
  s = json(h, "skill-bundles.json");
  assert.ok(s.bundles.find((b) => b.id === "dev").skills.includes("alpha"));
  assert.ok(s.bundles.find((b) => b.id === "docs").skills.includes("alpha"));
  assert.equal(run(h, "rename", "docs", "Documentation").code, 0);
  assert.equal(json(h, "skill-bundles.json").bundles.find((b) => b.id === "docs").name, "Documentation");
  assert.equal(run(h, "rm", nb.id).code, 0);
  assert.ok(!json(h, "skill-bundles.json").bundles.some((b) => b.id === nb.id));
  assert.ok(fs.existsSync(path.join(oc(h), "skills/beta/SKILL.md")));
});

test("show and status", () => {
  const h = makeHome();
  let r = run(h, "show", "dev");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /called\s+gamma \(override\)/);
  r = run(h, "status");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /auto\s+alpha/);
  assert.match(r.out, /off\s+beta/);
});

test("missing skill-bundles.json is seeded from defaults and synced", () => {
  const h = makeHome({ bundles: false });
  const dry = run(h, "list", "--dry-run");
  assert.equal(dry.code, 0, dry.err);
  assert.ok(!fs.existsSync(path.join(oc(h), "skill-bundles.json")));
  const r = run(h, "list");
  assert.equal(r.code, 0, r.err);
  const seed = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "default-bundles.json"), "utf8"));
  assert.deepEqual(json(h, "skill-bundles.json").bundles.map((b) => b.id), seed.bundles.map((b) => b.id));
  assert.equal(skillRules(h)[0].resource, "*");
});

test("sync is idempotent", () => {
  const h = makeHome();
  assert.equal(run(h, "sync").code, 0);
  const snap = snapshot(h);
  const r = run(h, "sync");
  assert.match(r.out, /0 files changed/);
  assert.deepEqual(snapshot(h), snap);
});

// ---------- regression tests (review round 1) ----------

const mode = (p) => fs.statSync(p).mode & 0o777;
const noTmp = (h) => {
  for (const d of [oc(h), ...fs.readdirSync(path.join(oc(h), "skills")).map((x) => path.join(oc(h), "skills", x))])
    if (fs.statSync(d).isDirectory()) assert.ok(!fs.readdirSync(d).some((f) => f.endsWith(".tmp")), d);
};

test("R1 written files and backup keep the original mode (600 stays 600)", () => {
  const h = makeHome();
  const ocp = path.join(oc(h), "opencode.json");
  const md = path.join(oc(h), "skills/beta/SKILL.md");
  fs.chmodSync(ocp, 0o600);
  fs.chmodSync(md, 0o640);
  fs.chmodSync(path.join(oc(h), "skill-bundles.json"), 0o600);
  assert.equal(run(h, "set", "beta", "called").code, 0);
  assert.equal(mode(ocp), 0o600);
  assert.equal(mode(md), 0o640);
  assert.equal(mode(path.join(oc(h), "skill-bundles.json")), 0o600);
  const bak = fs.readdirSync(oc(h)).find((f) => f.startsWith("opencode.json.skill-bundles-"));
  assert.equal(mode(path.join(oc(h), bak)), 0o600);
});

test("R1 newly created skill-bundles.json defaults to 0600", () => {
  const h = makeHome({ bundles: false });
  assert.equal(run(h, "list").code, 0);
  assert.equal(mode(path.join(oc(h), "skill-bundles.json")), 0o600);
});

test("R9 symlinked targets stay symlinks; the real file is updated", () => {
  const h = makeHome();
  const realDir = tmpDir("skills-real-");
  const ocp = path.join(oc(h), "opencode.json");
  const real = path.join(realDir, "opencode.json");
  fs.renameSync(ocp, real);
  fs.chmodSync(real, 0o600);
  fs.symlinkSync(real, ocp);
  const md = path.join(oc(h), "skills/beta/SKILL.md");
  const realMd = path.join(realDir, "beta.md");
  fs.renameSync(md, realMd);
  fs.symlinkSync(realMd, md);
  assert.equal(run(h, "set", "beta", "called").code, 0);
  assert.ok(fs.lstatSync(ocp).isSymbolicLink());
  assert.ok(fs.lstatSync(md).isSymbolicLink());
  assert.ok(JSON.parse(fs.readFileSync(real, "utf8")).permissions.some((p) => p.resource === "beta"));
  assert.match(fs.readFileSync(realMd, "utf8"), /opencode\/autoinvoke: false/);
  assert.equal(mode(real), 0o600);
  assert.ok(!fs.readdirSync(realDir).some((f) => f.endsWith(".tmp")));
});

test("unsupported SKILL.md layout aborts cleanly", () => {
  const h = makeHome();
  const md = path.join(oc(h), "skills/beta/SKILL.md");
  fs.writeFileSync(md, "---\nname: beta\nmetadata: {a: 1}\n---\nbody\n");
  const snap = snapshot(h);
  const r = run(h, "set", "beta", "called");
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /beta\/SKILL\.md.*not supported/);
  assert.deepEqual(snapshot(h), snap);
});

// ---------- regression tests (review round 2) ----------

const lockPath = (h) => path.join(oc(h), ".skill-bundles.lock");

test("RA live lock blocks a second writer; nothing written", () => {
  const h = makeHome();
  fs.writeFileSync(lockPath(h), JSON.stringify({ pid: process.pid, time: Date.now() }));
  const snap = snapshot(h);
  const r = run(h, "set", "beta", "called");
  assert.equal(r.code, 1);
  assert.match(r.err, /another skills process/);
  assert.deepEqual(snapshot(h), snap);
});

test("R3-1 lock is reclaimed only from a dead owner or an old unparseable lock", () => {
  const host = os.hostname();
  const dead = 2 ** 22 + 12345;
  const old = (p) => { const t = new Date(Date.now() - 11 * 60_000); fs.utimesSync(p, t, t); };
  const cases = [
    // [lock body, make it old?, expect reclaimed]
    [{ pid: process.pid, host, time: Date.now() - 60 * 60_000 }, true, false], // live owner, hour old: kept
    [{ pid: dead, host, time: Date.now() }, false, true], // dead owner: reclaimed
    ["garbage", false, false], // unparseable but fresh: kept
    ["garbage", true, true], // unparseable and > 10 min: reclaimed
    [{ pid: process.pid, time: Date.now() }, false, false], // no host, fresh: kept
    [{ pid: process.pid, host: "other-host", time: 0 }, true, true], // other host, old: reclaimed
  ];
  for (const [body, makeOld, reclaimed] of cases) {
    const h = makeHome();
    fs.writeFileSync(lockPath(h), typeof body === "string" ? body : JSON.stringify(body));
    if (makeOld) old(lockPath(h));
    const snap = snapshot(h);
    const r = run(h, "set", "beta", "called");
    if (reclaimed) {
      assert.equal(r.code, 0, `${JSON.stringify(body)}: ${r.err}`);
      assert.ok(!fs.existsSync(lockPath(h)));
    } else {
      assert.equal(r.code, 1, JSON.stringify(body));
      assert.match(r.err, /another skills process/);
      assert.deepEqual(snapshot(h), snap);
    }
  }
});

test("RD existing backup is never replaced", () => {
  const h = makeHome();
  const bak = path.join(oc(h), backupName());
  fs.writeFileSync(bak, "earlier");
  assert.equal(run(h, "set", "beta", "called").code, 0);
  assert.equal(fs.readFileSync(bak, "utf8"), "earlier");
});

test("RE __proto__ skill id works end to end", () => {
  const h = makeHome();
  const dir = path.join(oc(h), "skills/__proto__");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: __proto__\ndescription: weird\n---\nbody\n");
  let r = run(h, "set", "__proto__", "called");
  assert.equal(r.code, 0, r.err);
  assert.match(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), /metadata:\n  opencode\/autoinvoke: false/);
  assert.ok(skillRules(h).some((x) => x.resource === "__proto__"));
  assert.equal(json(h, "skill-bundles.json").overrides.__proto__, "called");
  r = run(h, "status");
  assert.match(r.out, /called\s+__proto__ \(override\)/);
  assert.equal(run(h, "set", "__proto__", "auto").code, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), /autoinvoke/);
});

test("RG symlink cycles and dangling chains with missing parent fail before publishing", () => {
  let h = makeHome();
  const md = path.join(oc(h), "skills/beta/SKILL.md");
  const snap0 = snapshot(h);
  // cycle on opencode.json
  const ocp = path.join(oc(h), "opencode.json");
  const text = fs.readFileSync(ocp, "utf8");
  fs.unlinkSync(ocp);
  fs.symlinkSync(path.join(oc(h), "loop-b"), ocp);
  fs.symlinkSync(ocp, path.join(oc(h), "loop-b"));
  let r = run(h, "set", "beta", "called");
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /symlink cycle/);
  assert.equal(fs.readFileSync(md, "utf8"), snap0[md]);

  // dangling chain (a -> b -> missing/dir/file) on skill-bundles.json via 2 hops
  h = makeHome();
  const bp = path.join(oc(h), "skill-bundles.json");
  const orig = fs.readFileSync(bp, "utf8");
  const realDir = tmpDir("skills-chain-");
  fs.writeFileSync(path.join(realDir, "real.json"), orig);
  fs.symlinkSync(path.join(realDir, "real.json"), path.join(realDir, "hop2"));
  fs.unlinkSync(bp);
  fs.symlinkSync(path.join(realDir, "hop2"), bp);
  assert.equal(run(h, "set", "beta", "called").code, 0);
  assert.ok(fs.lstatSync(bp).isSymbolicLink() && fs.lstatSync(path.join(realDir, "hop2")).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(path.join(realDir, "real.json"), "utf8")).overrides.beta, "called");

  h = makeHome();
  const bp2 = path.join(oc(h), "skill-bundles.json");
  const ocBefore = read(h, "opencode.json");
  fs.unlinkSync(bp2);
  fs.symlinkSync(path.join(oc(h), "nope/dir/real.json"), bp2);
  r = run(h, "set", "beta", "called");
  assert.notEqual(r.code, 0);
  assert.match(r.err, /symlink target directory .* does not exist/);
  assert.equal(read(h, "opencode.json"), ocBefore);
  assert.doesNotMatch(read(h, "skills/beta/SKILL.md"), /autoinvoke/);
});

// ---------- regression tests (review round 3) ----------

test("R3-4 dry-run performs zero writes: no lock, no mkdir (read-only config dir)", () => {
  const h = makeHome();
  const dir = oc(h);
  const snap = snapshot(h);
  fs.chmodSync(dir, 0o555);
  try {
    const r = run(h, "on", "docs", "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /would change/);
    assert.ok(!fs.existsSync(lockPath(h)));
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  assert.deepEqual(snapshot(h), snap);
  // missing config dir is not created by a dry run
  const empty = tmpDir("skills-empty-");
  run(empty, "list", "--dry-run");
  assert.ok(!fs.existsSync(path.join(empty, ".config")));
});

test("R3-6 dangling or non-regular backup path aborts before publishing", () => {
  const name = backupName();
  for (const make of [
    (p) => fs.symlinkSync(p + ".nowhere", p),
    (p) => fs.mkdirSync(p),
    (p) => { fs.writeFileSync(p, "x"); fs.chmodSync(p, 0o000); },
  ]) {
    const h = makeHome();
    const bak = path.join(oc(h), name);
    make(bak);
    const ocBefore = read(h, "opencode.json");
    const r = run(h, "set", "beta", "called");
    try { fs.chmodSync(bak, 0o644); } catch {}
    if (process.getuid?.() === 0 && fs.lstatSync(bak).isFile()) continue; // root can read 000 files
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /existing backup is not (a regular file|readable)/);
    assert.equal(read(h, "opencode.json"), ocBefore);
    assert.doesNotMatch(read(h, "skills/beta/SKILL.md"), /autoinvoke/);
  }
});

test("R3-8 auto skill with unsupported SKILL.md is skipped, others still saved", () => {
  const h = makeHome();
  const md = path.join(oc(h), "skills/beta/SKILL.md");
  const weird = "---\nname: beta\nmetadata: {info: 1}\n---\nbody\n";
  fs.writeFileSync(md, weird);
  let r = run(h, "set", "beta", "auto");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /skipped skills\/beta\/SKILL\.md .*flow-style/);
  assert.equal(fs.readFileSync(md, "utf8"), weird);
  assert.ok(skillRules(h).some((x) => x.resource === "beta"));
  r = run(h, "set", "beta", "called");
  assert.equal(r.code, 1);
  assert.match(r.err, /beta\/SKILL\.md.*not supported/);
  fs.writeFileSync(md, "---\nname: beta\nmetadata: {opencode/autoinvoke: false}\n---\n");
  r = run(h, "set", "beta", "auto");
  assert.equal(r.code, 1);
});

// ---------- regression tests (final review) ----------

test("F1 dangling symlink under skills/ is skipped with a warning; other skills stay on", () => {
  const h = makeHome();
  fs.symlinkSync(path.join(oc(h), "skills/does-not-exist"), path.join(oc(h), "skills/broken"));
  const r = run(h, "sync");
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /warning: skipping .*broken \(dangling symlink\)/);
  assert.deepEqual(skillRules(h).map((x) => x.resource), ["*", "alpha", "gamma"]);
  assert.doesNotMatch(run(h, "status").out, /broken/);
});

test("F1 missing skills dir itself means no skills", () => {
  const h = makeHome();
  fs.rmSync(path.join(oc(h), "skills"), { recursive: true });
  const r = run(h, "status");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /0\/2 skills on|\/2 skills on/);
});

test("F2 fresh panel lock blocks the CLI", () => {
  const h = makeHome();
  fs.writeFileSync(lockPath(h), JSON.stringify({ owner: "panel", host: "panel", pid: 0, token: "t", time: Date.now() - 50_000 }));
  const snap = snapshot(h);
  const r = run(h, "set", "beta", "called");
  assert.equal(r.code, 1);
  assert.match(r.err, /held by the panel/);
  assert.deepEqual(snapshot(h), snap);
});

test("F2 stale panel lock (>60s) is reclaimed", () => {
  for (const host of ["panel", os.hostname()]) {
    const h = makeHome();
    fs.writeFileSync(lockPath(h), JSON.stringify({ owner: "panel", host, pid: 0, token: "t", time: Date.now() - 61_000 }));
    const t = new Date(Date.now() - 61_000);
    fs.utimesSync(lockPath(h), t, t);
    const r = run(h, "set", "beta", "called");
    assert.equal(r.code, 0, r.err);
    assert.ok(!fs.existsSync(lockPath(h)));
  }
});

test("F2 panel lock with old time but fresh mtime is still live", () => {
  const h = makeHome();
  fs.writeFileSync(lockPath(h), JSON.stringify({ owner: "panel", host: "panel", pid: 0, token: "t", time: 0 }));
  assert.equal(run(h, "set", "beta", "called").code, 1);
});

const RELEASED = '{"owner":"panel","released":true,"time":0}';

test("F4 panel released marker does not block", () => {
  const h = makeHome();
  fs.writeFileSync(lockPath(h), RELEASED);
  const r = run(h, "set", "beta", "called");
  assert.equal(r.code, 0, r.err);
  assert.ok(skillRules(h).some((x) => x.resource === "beta"));
});

test("C7 unreadable lock surfaces a clear error", { skip: process.getuid?.() === 0 }, () => {
  const h = makeHome();
  fs.writeFileSync(lockPath(h), "{}");
  fs.chmodSync(lockPath(h), 0o000);
  const r = run(h, "set", "beta", "called");
  fs.chmodSync(lockPath(h), 0o600);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /cannot read lock .*EACCES/);
});

// ---------- R1: planChange + fake executor reproduces the CLI ----------

function loadFixtureHome(h) {
  const dir = path.join(oc(h), "skills");
  const ids = fs.readdirSync(dir).filter((d) => !d.startsWith("."));
  const skillMds = Object.create(null);
  for (const id of ids) skillMds[id] = fs.readFileSync(path.join(dir, id, "SKILL.md"), "utf8");
  return {
    allIds: [...new Set([...ids, ...core.BUILTIN_SKILLS])].sort(),
    prev: { bundlesText: read(h, "skill-bundles.json"), opencodeText: read(h, "opencode.json"), skillMds },
  };
}
// Fake executor: applies writes, in plan order, to an in-memory file map keyed like the CLI's paths.
function execute(plan, files) {
  const out = { ...files };
  const seen = [];
  for (const w of plan.writes) {
    const key = w.kind === "skill" ? `skills/${w.id}/SKILL.md` : w.kind === "opencode" ? "opencode.json" : "skill-bundles.json";
    assert.equal(out[key] ?? null, w.before, `before mismatch for ${key}`);
    out[key] = w.after;
    seen.push(w.kind);
  }
  return { out, seen };
}
const homeFiles = (h) => {
  const f = { "opencode.json": read(h, "opencode.json"), "skill-bundles.json": read(h, "skill-bundles.json") };
  for (const id of fs.readdirSync(path.join(oc(h), "skills")).filter((d) => !d.startsWith("."))) {
    f[`skills/${id}/SKILL.md`] = read(h, `skills/${id}/SKILL.md`);
  }
  return f;
};

test("R1 planChange + fake executor matches real CLI writes for each command", () => {
  const cases = [
    [["on", "docs"], (s) => core.setBundleEnabled(s, "docs", true)],
    [["off", "dev"], (s) => core.setBundleEnabled(s, "dev", false)],
    [["set", "beta", "called"], (s) => core.setOverride(s, "beta", "called")],
    [["set", "gamma", "clear"], (s) => core.setOverride(s, "gamma", null)],
    [["set", "alpha", "called"], (s) => core.setOverride(s, "alpha", "called")],
    [["move", "beta", "dev"], (s) => core.moveSkill(s, "beta", "docs", "dev")],
    [["rename", "docs", "Documentation"], (s) => core.renameBundle(s, "docs", "Documentation")],
    [["rm", "docs"], (s) => core.deleteBundle(s, "docs")],
    [["sync"], (s) => s],
  ];
  for (const [argv, mutate] of cases) {
    const h = makeHome();
    const { allIds, prev } = loadFixtureHome(h);
    const plan = core.planChange(prev, mutate(core.parseBundles(prev.bundlesText)), allIds);
    const { out, seen } = execute(plan, homeFiles(h));
    // order: every skill before opencode before bundles
    const rank = seen.map((k) => plan.order.indexOf(k));
    assert.deepEqual(rank, [...rank].sort((a, b) => a - b), argv.join(" "));
    const r = run(h, ...argv);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(homeFiles(h), out, argv.join(" "));
    assert.match(r.out, new RegExp(`— ${plan.writes.length} files? changed`), argv.join(" "));
  }
});
