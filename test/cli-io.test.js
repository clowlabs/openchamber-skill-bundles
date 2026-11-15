// In-process CLI tests: runCli with an injected io layer, for faults, races and retargeting
// that a subprocess cannot reach. Real behaviour without injection is covered by cli.test.js.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, createNodeIO } from "../src/cli.js";
import { faultyIO, boom, isTemp, isTarget } from "../shared/test/fault-io.js";
import * as core from "../src/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");

const tempDirs = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeHome() {
  const home = tmpDir("skills-io-");
  fs.cpSync(path.join(FIX, "home"), home, { recursive: true });
  fs.copyFileSync(path.join(FIX, "skill-bundles.json"), path.join(home, ".config/opencode/skill-bundles.json"));
  return home;
}
const oc = (h) => path.join(h, ".config/opencode");
const read = (h, rel) => fs.readFileSync(path.join(oc(h), rel), "utf8");
const lockPath = (h) => path.join(oc(h), ".skill-bundles.lock");
function snapshot(dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) { const p = path.join(e.parentPath ?? e.path, e.name); out[p] = fs.readFileSync(p, "utf8"); }
  }
  return out;
}
const noTmp = (h) => {
  for (const d of [oc(h), ...fs.readdirSync(path.join(oc(h), "skills")).map((x) => path.join(oc(h), "skills", x))]) {
    if (fs.statSync(d).isDirectory()) assert.ok(!fs.readdirSync(d).some((f) => f.endsWith(".tmp") || f.includes(".reclaim-")), d);
  }
};
const withoutBackups = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !/\.skill-bundles-\d{8}$/.test(k)));


function cli(home, argv, io) {
  let out = "", err = "";
  const code = runCli([...argv, "--home", home], {
    io,
    env: {},
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

test("io: runCli without injection behaves like the binary", () => {
  const h = makeHome();
  const r = cli(h, ["set", "beta", "called"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /beta: called → called — 3 files changed/);
  assert.match(read(h, "skills/beta/SKILL.md"), /opencode\/autoinvoke: false/);
  assert.ok(!fs.existsSync(lockPath(h)));
  assert.equal(cli(h, ["nope"]).code, 1);
});

// R6
test("io: failure before renaming publishes nothing (backup, each temp)", () => {
  const cases = [
    ["backup temp", { writeNew: (a, n) => { if (n === 1) boom("injected backup failure"); } }, { writeNew: (p) => p.includes(".skill-bundles-") || isTemp(p) }],
    ...[0, 1, 2].map((i) => [`temp ${i}`, { writeNew: (a, n) => { if (n === i + 1) boom(`injected temp ${i}`); } }, { writeNew: (p) => isTemp(p) }]),
  ];
  for (const [label, on, match] of cases) {
    const h = makeHome();
    const snap = snapshot(h);
    const r = cli(h, ["set", "beta", "called"], faultyIO(on, match));
    assert.notEqual(r.code, 0, label);
    assert.match(r.err, /injected/, label);
    assert.deepEqual(withoutBackups(snapshot(h)), snap, label);
    // a backup, if made, is the untouched original
    for (const [k, v] of Object.entries(snapshot(h))) if (/\.skill-bundles-\d{8}$/.test(k)) assert.equal(v, snap[path.join(oc(h), "opencode.json")]);
    noTmp(h);
    assert.ok(!fs.existsSync(lockPath(h)), label);
  }
});

test("io: rename failure partway restores already-renamed files", () => {
  // publish order: skills/beta/SKILL.md (0), opencode.json (1), skill-bundles.json (2)
  for (const failAt of [1, 2]) {
    const h = makeHome();
    const snap = snapshot(h);
    const io = faultyIO({ rename: (a, n) => { if (n === failAt) boom(`injected rename ${failAt}`); } }, { rename: (a, b) => isTemp(a) && isTarget(a, b) });
    const r = cli(h, ["set", "beta", "called"], io);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /injected rename .*earlier files restored/);
    assert.deepEqual(withoutBackups(snapshot(h)), snap, `fail at ${failAt}`);
    noTmp(h);
  }
});

test("io: skill-bundles.json is renamed last (fixed order)", () => {
  const h = makeHome();
  const order = [];
  const io = faultyIO({ rename: ([, b]) => order.push(path.relative(oc(h), b)) }, { rename: (a, b) => isTemp(a) && isTarget(a, b) });
  assert.equal(cli(h, ["set", "beta", "called"], io).code, 0);
  assert.deepEqual(order, ["skills/beta/SKILL.md", "opencode.json", "skill-bundles.json"]);
  const before = read(makeHome(), "skill-bundles.json");
  const h2 = makeHome();
  const io2 = faultyIO({ rename: (a, n) => { if (n === 2) boom("injected"); } }, { rename: (a, b) => isTemp(a) && isTarget(a, b) });
  assert.notEqual(cli(h2, ["set", "beta", "called"], io2).code, 0);
  assert.equal(read(h2, "skill-bundles.json"), before);
});

// conflict + RC
test("io: any input changed on disk after load aborts with nothing published", () => {
  for (const rel of ["opencode.json", "skill-bundles.json", "skills/alpha/SKILL.md", "skills/beta/SKILL.md"]) {
    const h = makeHome();
    const target = path.join(oc(h), rel);
    const snap = snapshot(h);
    let done = false;
    // after the temps are written, someone appends to `rel`
    const io = faultyIO({ writeNew: ([p]) => {
      if (!done && p.includes(".skill-bundles.json.")) { done = true; fs.appendFileSync(target, " "); }
    } }, { writeNew: isTemp });
    const r = cli(h, ["set", "beta", "called"], io);
    assert.equal(r.code, 1, `${rel}: ${r.err}`);
    assert.match(r.err, new RegExp(`${rel.replace(/[./]/g, "\\$&")}: file changed on disk, re-run`));
    const after = withoutBackups(snapshot(h));
    assert.equal(after[target], snap[target] + " ");
    delete after[target];
    const expect = { ...snap };
    delete expect[target];
    assert.deepEqual(after, expect, rel);
    noTmp(h);
  }
});

// RA
test("io: lock released after success and after failure", () => {
  const h = makeHome();
  assert.equal(cli(h, ["list"]).code, 0);
  assert.ok(!fs.existsSync(lockPath(h)));
  const io = faultyIO({ rename: (a, n) => { if (n === 1) boom("injected"); } }, { rename: (a, b) => isTemp(a) && isTarget(a, b) });
  assert.notEqual(cli(h, ["set", "beta", "called"], io).code, 0);
  assert.ok(!fs.existsSync(lockPath(h)));
});

test("io: rollback never overwrites newer foreign content; original rescued", () => {
  const h = makeHome();
  const ocp = path.join(oc(h), "opencode.json");
  const orig = read(h, "opencode.json");
  // opencode.json goes out at rename 1; someone writes it; rename 2 fails → rollback
  const io = faultyIO({ rename: (a, n) => {
    if (n === 2) { fs.appendFileSync(ocp, "clobbered"); boom("injected rename 2"); }
  } }, { rename: (a, b) => isTemp(a) && isTarget(a, b) });
  const r = cli(h, ["set", "beta", "called"], io);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /changed by someone else, not restored: .*opencode\.json \(original kept in .*rescue-/);
  assert.ok(read(h, "opencode.json").endsWith("clobbered"));
  const rescue = fs.readdirSync(oc(h)).find((f) => f.startsWith("opencode.json.skill-bundles-rescue-"));
  assert.equal(read(h, rescue), orig);
  assert.doesNotMatch(read(h, "skills/beta/SKILL.md"), /autoinvoke/); // ours, rolled back
});

// R3-7
test("io: rescue names are unique; an existing name is retried, never overwritten", () => {
  const h = makeHome();
  const ocp = path.join(oc(h), "opencode.json");
  const orig = read(h, "opencode.json");
  const base = createNodeIO();
  let ids = 0;
  const makeIO = (randomId) => ({
    ...faultyIO({ rename: (a, n) => { if (n === 2) { fs.appendFileSync(ocp, "clobbered"); boom("injected"); } } }, { rename: (a, b) => isTemp(a) && isTarget(a, b) }),
    now: () => Date.UTC(2026, 10, 14, 12, 0, 0), // same second every time
    randomId,
  });
  const io = makeIO(() => (ids++ === 0 ? "fixed" : `r${ids}`));
  const fixedName = `${ocp}.skill-bundles-rescue-20261114T120000-${base.pid}-fixed`;
  fs.writeFileSync(fixedName, "someone else's rescue");
  const r = cli(h, ["set", "beta", "called"], io);
  assert.notEqual(r.code, 0);
  const rescues = fs.readdirSync(oc(h)).filter((f) => f.startsWith("opencode.json.skill-bundles-rescue-")).sort();
  assert.equal(rescues.length, 2, rescues.join());
  assert.equal(fs.readFileSync(fixedName, "utf8"), "someone else's rescue");
  const mine = rescues.find((f) => !f.endsWith("-fixed"));
  assert.match(mine, /^opencode\.json\.skill-bundles-rescue-20261114T120000-\d+-[a-z0-9]+$/);
  assert.equal(read(h, mine), orig);
  assert.match(r.err, new RegExp(mine.replace(/[.]/g, "\\.")));
  // two rescues in the same second from separate runs also get distinct names
  fs.writeFileSync(ocp, orig);
  const r2 = cli(h, ["set", "beta", "called"], makeIO(() => `x${ids++}`));
  assert.notEqual(r2.code, 0);
  assert.equal(fs.readdirSync(oc(h)).filter((f) => f.startsWith("opencode.json.skill-bundles-rescue-")).length, 3);
});

// RD
test("io: backup interrupted mid-write never gets the final name; temp removed", () => {
  const h = makeHome();
  const real = createNodeIO();
  const io = {
    ...real,
    writeNew: (p, text, mode) => {
      if (p.includes("opencode.json.skill-bundles-") && isTemp(p)) {
        fs.writeFileSync(p, text.slice(0, text.length >> 1), { flag: "wx", mode });
        boom("injected failure while writing backup");
      }
      return real.writeNew(p, text, mode);
    },
  };
  const r = cli(h, ["set", "beta", "called"], io);
  assert.notEqual(r.code, 0);
  const files = fs.readdirSync(oc(h));
  assert.ok(!files.some((f) => /^opencode\.json\.skill-bundles-\d{8}$/.test(f)), files.join());
  noTmp(h);
  assert.equal(cli(h, ["set", "beta", "called"]).code, 0);
  assert.equal(read(h, core.backupName()), fs.readFileSync(path.join(FIX, "home/.config/opencode/opencode.json"), "utf8"));
});

// R3-5
test("io: symlink retargeted between snapshot and rename aborts", () => {
  const h = makeHome();
  const realDir = tmpDir("skills-io-rt-");
  const ocp = path.join(oc(h), "opencode.json");
  const a = path.join(realDir, "a.json"), b = path.join(realDir, "b.json");
  fs.copyFileSync(ocp, a);
  fs.copyFileSync(ocp, b);
  fs.unlinkSync(ocp);
  fs.symlinkSync(a, ocp);
  const aBefore = fs.readFileSync(a, "utf8");
  const io = faultyIO({ rename: (args, n) => {
    if (n === 0) { fs.unlinkSync(ocp); fs.symlinkSync(b, ocp); }
  } }, { rename: (x, y) => isTemp(x) && isTarget(x, y) });
  const r = cli(h, ["set", "beta", "called"], io);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /symlink now points elsewhere/);
  assert.equal(fs.readFileSync(a, "utf8"), aBefore);
  assert.equal(fs.readFileSync(b, "utf8"), aBefore);
  assert.doesNotMatch(read(h, "skills/beta/SKILL.md"), /autoinvoke/); // renamed first, then rolled back
});

// F4
test("io: released marker is replaced by a CLI-shaped lock and removed after the run", () => {
  const h = makeHome();
  fs.writeFileSync(lockPath(h), core.RELEASED_MARKER);
  let held = null;
  const io = faultyIO({ readdir: () => { held ??= fs.readFileSync(lockPath(h), "utf8"); } });
  const r = cli(h, ["set", "beta", "called"], io);
  assert.equal(r.code, 0, r.err);
  const info = core.parseLock(held);
  assert.equal(info.kind, "cli");
  assert.equal(info.host, os.hostname());
  assert.equal(info.pid, process.pid);
  assert.ok(!fs.existsSync(lockPath(h)));
  noTmp(h);
});

test("io: panel re-acquires between judging and reclaiming → CLI backs off, panel lock kept", () => {
  const h = makeHome();
  fs.writeFileSync(lockPath(h), core.RELEASED_MARKER);
  const snap = snapshot(h);
  const io = faultyIO({ rename: () => { fs.writeFileSync(lockPath(h), core.panelLockRecord("race", Date.now())); } }, { rename: (a, b) => b.includes(".reclaim-") });
  const r = cli(h, ["set", "beta", "called"], io);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /held by the panel/);
  assert.equal(core.parseLock(fs.readFileSync(lockPath(h), "utf8")).token, "race");
  noTmp(h);
  const after = snapshot(h);
  delete after[lockPath(h)];
  delete snap[lockPath(h)];
  assert.deepEqual(after, snap);
});

test("io: lock reclaim fault (rename aside fails) surfaces and writes nothing", () => {
  const h = makeHome();
  const dead = { pid: 2 ** 22 + 1, host: os.hostname(), time: 0, token: "t" };
  fs.writeFileSync(lockPath(h), JSON.stringify(dead));
  const snap = snapshot(h);
  const io = faultyIO({ rename: () => boom("injected reclaim failure") }, { rename: (a, b) => b.includes(".reclaim-") });
  const r = cli(h, ["set", "beta", "called"], io);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /injected reclaim failure/);
  assert.deepEqual(snapshot(h), snap);
});

// ---------- per-project bundles (v0.2) ----------

function projHome() {
  const h = makeHome();
  const proj = tmpDir("skills-io-proj-");
  return { h, proj, pfile: path.join(proj, ".opencode/opencode.json") };
}

test("io: project file written in order skill → project → opencode → bundles", () => {
  const { h, proj } = projHome();
  // docs on in proj, plus beta "called" so all four kinds change
  assert.equal(cli(h, ["on", "docs", "--project", proj]).code, 0);
  const order = [];
  const io = faultyIO({ rename: ([, b]) => order.push(b.startsWith(proj) ? "project" : path.relative(oc(h), b)) }, { rename: (a, b) => isTemp(a) && isTarget(a, b) });
  fs.writeFileSync(path.join(proj, ".opencode/opencode.json"), '{"permissions":[]}\n');
  const r = cli(h, ["set", "beta", "called"], io);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(order, ["skills/beta/SKILL.md", "project", "opencode.json", "skill-bundles.json"]);
});

test("io: fault in the project write rolls everything back (new and existing project files)", () => {
  for (const existing of [false, true]) {
    for (const failAt of ["temp", "rename-after"]) {
      const { h, proj, pfile } = projHome();
      if (existing) {
        fs.mkdirSync(path.dirname(pfile));
        fs.writeFileSync(pfile, '{\n  "model": "m",\n  "permissions": [{ "action": "bash", "resource": "*", "effect": "ask" }]\n}\n');
      }
      const snapH = snapshot(h);
      const projBefore = existing ? fs.readFileSync(pfile, "utf8") : null;
      // "on docs --project" + global "on docs" in one run so SKILL.md-free kinds all change:
      const io =
        failAt === "temp"
          ? faultyIO({ writeNew: ([p]) => { if (p.startsWith(proj)) boom("injected project temp"); } }, { writeNew: isTemp })
          : faultyIO({ rename: (a, n) => { if (n === 1) boom("injected rename after project"); } }, { rename: (a, b) => isTemp(a) && isTarget(a, b) });
      const r = cli(h, ["on", "docs", "--project", proj], io);
      assert.notEqual(r.code, 0, `${existing} ${failAt}`);
      assert.match(r.err, /injected/);
      assert.deepEqual(withoutBackups(snapshot(h)), snapH, `${existing} ${failAt}`);
      if (existing) assert.equal(fs.readFileSync(pfile, "utf8"), projBefore);
      else assert.ok(!fs.existsSync(pfile), "created project file removed on rollback");
      assert.ok(!fs.readdirSync(proj, { recursive: true }).some((f) => String(f).endsWith(".tmp")));
      noTmp(h);
    }
  }
});

test("io: project file changed on disk after load aborts; foreign write during rollback is rescued", () => {
  const { h, proj, pfile } = projHome();
  fs.mkdirSync(path.dirname(pfile));
  fs.writeFileSync(pfile, '{"permissions":[]}\n');
  const snap = snapshot(h);
  let done = false;
  const io = faultyIO({ writeNew: ([p]) => { if (!done && p.includes(".skill-bundles.json.")) { done = true; fs.appendFileSync(pfile, " "); } } }, { writeNew: isTemp });
  let r = cli(h, ["on", "docs", "--project", proj], io);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /\.opencode\/opencode\.json: file changed on disk, re-run/);
  assert.equal(fs.readFileSync(pfile, "utf8"), '{"permissions":[]}\n ');
  assert.deepEqual(withoutBackups(snapshot(h)), snap);

  fs.writeFileSync(pfile, '{"permissions":[]}\n');
  // project goes out at rename 0; someone rewrites it; rename 1 fails → rescue, theirs kept
  const io2 = faultyIO({ rename: (a, n) => { if (n === 1) { fs.writeFileSync(pfile, "theirs"); boom("injected"); } } }, { rename: (a, b) => isTemp(a) && isTarget(a, b) });
  r = cli(h, ["on", "docs", "--project", proj], io2);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /changed by someone else, not restored: .*\.opencode\/opencode\.json \(original kept in .*rescue-/);
  assert.equal(fs.readFileSync(pfile, "utf8"), "theirs");
  const rescue = fs.readdirSync(path.dirname(pfile)).find((f) => f.includes("rescue-"));
  assert.equal(fs.readFileSync(path.join(path.dirname(pfile), rescue), "utf8"), '{"permissions":[]}\n');
  // no daily backup is made for project files
  assert.ok(!fs.readdirSync(path.dirname(pfile)).some((f) => /skill-bundles-\d{8}$/.test(f)));
});
