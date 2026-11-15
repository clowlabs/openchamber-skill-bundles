import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createNodeIO, readOrNull, resolveMissing, realTarget, modeOf, tempPath, writeRescue, backupOnce,
  publish, inspectLock, acquireLock, SafeFsError, ConflictError,
} from "../node/fs-safe.js";
import { createLockProtocol } from "../core/lock.js";
import { faultyIO, boom, isTemp, isTarget } from "./fault-io.js";

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const io = createNodeIO();
const list = (d) => fs.readdirSync(d).sort();

test("readOrNull / modeOf / tempPath", () => {
  const d = tmp();
  assert.equal(readOrNull(io, path.join(d, "x")), null);
  fs.writeFileSync(path.join(d, "a"), "A", { mode: 0o640 });
  fs.chmodSync(path.join(d, "a"), 0o640);
  assert.equal(readOrNull(io, path.join(d, "a")), "A");
  assert.equal(modeOf(io, path.join(d, "a")), 0o640);
  assert.equal(modeOf(io, path.join(d, "nope")), 0o600);
  fs.symlinkSync(path.join(d, "l2"), path.join(d, "l1"));
  fs.symlinkSync(path.join(d, "l1"), path.join(d, "l2"));
  assert.throws(() => readOrNull(io, path.join(d, "l1")), SafeFsError);
  const t1 = tempPath(io, path.join(d, "f.json")), t2 = tempPath(io, path.join(d, "f.json"));
  assert.notEqual(t1, t2);
  assert.equal(path.dirname(t1), d);
  assert.match(path.basename(t1), /^\.f\.json\.\d+\.\d+\.\d+\.tmp$/);
});

test("realTarget / resolveMissing: chains, cycles, hop limit, dangling, missing parents", () => {
  const d = fs.realpathSync(tmp());
  fs.writeFileSync(path.join(d, "real"), "x");
  fs.symlinkSync(path.join(d, "real"), path.join(d, "a"));
  fs.symlinkSync("a", path.join(d, "b"));
  assert.equal(realTarget(io, path.join(d, "b")), path.join(d, "real"));
  assert.equal(realTarget(io, path.join(d, "new")), path.join(d, "new"));
  fs.symlinkSync(path.join(d, "later"), path.join(d, "dangling"));
  assert.equal(realTarget(io, path.join(d, "dangling")), path.join(d, "later"));
  fs.symlinkSync(path.join(d, "no/dir/f"), path.join(d, "bad"));
  assert.throws(() => realTarget(io, path.join(d, "bad")), /symlink target directory .* does not exist/);
  fs.symlinkSync(path.join(d, "c2"), path.join(d, "c1"));
  fs.symlinkSync(path.join(d, "c1"), path.join(d, "c2"));
  assert.throws(() => realTarget(io, path.join(d, "c1")), /symlink cycle/);
  assert.throws(() => realTarget(io, path.join(d, "b"), { maxHops: 1 }), /too many symlink hops/);
  // missing parents through a symlinked ancestor: identity is the real path + tail
  const real = fs.realpathSync(tmp());
  fs.symlinkSync(real, path.join(d, "proj"));
  const want = path.join(real, ".cfg/file.json");
  assert.equal(realTarget(io, path.join(d, "proj/.cfg/file.json")), want);
  assert.equal(resolveMissing(io, path.join(d, "proj/x/y/z")), path.join(real, "x/y/z"));
  fs.mkdirSync(path.join(real, ".cfg"));
  assert.equal(realTarget(io, path.join(d, "proj/.cfg/file.json")), want);
});

test("writeRescue: unique, exclusive, retried on clash", () => {
  const d = tmp();
  const f = path.join(d, "f");
  let n = 0;
  const fixed = { ...io, now: () => Date.UTC(2026, 0, 2, 3, 4, 5), randomId: () => (n++ === 0 ? "dup" : `r${n}`) };
  fs.writeFileSync(`${f}.tag-rescue-20260102T030405-${io.pid}-dup`, "theirs");
  const p = writeRescue(fixed, f, "ours", 0o600, { tag: "tag" });
  assert.equal(p, `${f}.tag-rescue-20260102T030405-${io.pid}-r2`);
  assert.equal(fs.readFileSync(p, "utf8"), "ours");
  assert.equal(fs.readFileSync(`${f}.tag-rescue-20260102T030405-${io.pid}-dup`, "utf8"), "theirs");
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

test("backupOnce: link-published, kept when present, refused when not a readable file", () => {
  const d = tmp();
  const b = path.join(d, "f.bak");
  backupOnce(io, b, "v1", 0o640);
  assert.equal(fs.readFileSync(b, "utf8"), "v1");
  assert.equal(fs.statSync(b).mode & 0o777, 0o640);
  backupOnce(io, b, "v2", 0o600);
  assert.equal(fs.readFileSync(b, "utf8"), "v1");
  assert.deepEqual(list(d), ["f.bak"]);
  // interrupted mid-write: never gets the final name
  const b2 = path.join(d, "g.bak");
  const half = { ...io, writeNew: (p, t, m) => { fs.writeFileSync(p, t.slice(0, 1)); boom("mid"); } };
  assert.throws(() => backupOnce(half, b2, "full", 0o600), /mid/);
  assert.deepEqual(list(d), ["f.bak"]);
  const b3 = path.join(d, "h.bak");
  fs.symlinkSync(path.join(d, "nowhere"), b3);
  assert.throws(() => backupOnce(io, b3, "x", 0o600), /not a regular file/);
  fs.mkdirSync(path.join(d, "i.bak"));
  assert.throws(() => backupOnce(io, path.join(d, "i.bak"), "x", 0o600), /not a regular file/);
});

function setup() {
  const d = fs.realpathSync(tmp());
  const f = (n) => path.join(d, n);
  fs.writeFileSync(f("a"), "A0", { mode: 0o640 });
  fs.chmodSync(f("a"), 0o640);
  fs.writeFileSync(f("b"), "B0");
  const writes = [
    { file: f("a"), before: "A0", after: "A1", tag: "a" },
    { file: f("b"), before: "B0", after: "B1" },
    { file: f("sub/c"), before: null, after: "C1" },
  ];
  const inputs = new Map([[f("a"), "A0"], [f("b"), "B0"], [f("sub/c"), null], [f("in"), null]]);
  return { d, f, writes, inputs };
}
const snap = (d) => Object.fromEntries(fs.readdirSync(d, { recursive: true }).filter((x) => fs.statSync(path.join(d, x)).isFile()).map((x) => [x, fs.readFileSync(path.join(d, x), "utf8")]));

test("publish: success writes all in order, keeps modes, makes requested backups", () => {
  const { d, f, writes, inputs } = setup();
  const order = [];
  const spy = faultyIO({ rename: ([, b]) => order.push(path.basename(b)) }, { rename: isTarget });
  publish(spy, writes, { inputs, rescueTag: "t", backupPath: (it) => (it.tag === "a" ? it.real + ".bak" : null) });
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(snap(d), { a: "A1", "a.bak": "A0", b: "B1", "sub/c": "C1" });
  assert.equal(fs.statSync(f("a")).mode & 0o777, 0o640);
  assert.equal(fs.statSync(f("sub/c")).mode & 0o777, 0o600);
});

test("publish: conflicts abort with nothing published", () => {
  for (const [label, mutate] of [
    ["target", (f) => fs.writeFileSync(f("b"), "X")],
    ["input-only", (f) => fs.writeFileSync(f("in"), "X")],
    ["created", (f) => { fs.mkdirSync(f("sub")); fs.writeFileSync(f("sub/c"), "X"); }],
  ]) {
    const { d, f, writes, inputs } = setup();
    let once = false;
    const racy = faultyIO({ writeNew: () => { if (!once) { once = true; mutate(f); } } }, { writeNew: isTemp });
    const before = snap(d);
    assert.throws(() => publish(racy, writes, { inputs, rescueTag: "t" }), (e) => e instanceof ConflictError && /file changed on disk, re-run/.test(e.message), label);
    const now = snap(d);
    for (const k of Object.keys(before)) if (!(label === "target" && k === "b")) assert.equal(now[k], before[k], `${label} ${k}`);
    assert.ok(!Object.keys(now).some((k) => k.endsWith(".tmp")), label);
  }
});

test("publish: temp failure → nothing published, temps removed", () => {
  const { d, writes, inputs } = setup();
  const before = snap(d);
  const bad = faultyIO({ writeNew: (a, n) => { if (n === 2) boom("disk full"); } }, { writeNew: isTemp });
  assert.throws(() => publish(bad, writes, { inputs, rescueTag: "t" }), /disk full/);
  assert.deepEqual(snap(d), before);
});

test("publish: rename failure rolls back; foreign content is kept and ours rescued", () => {
  const { d, f, writes, inputs } = setup();
  const before = snap(d);
  const bad = faultyIO({ rename: (a, n) => { if (n === 2) boom("rename failed"); } }, { rename: (a, b) => isTemp(a) && isTarget(a, b) });
  assert.throws(() => publish(bad, writes, { inputs, rescueTag: "t" }), (e) => e instanceof SafeFsError && /rename failed; earlier files restored$/.test(e.message));
  assert.deepEqual(snap(d), before);
  assert.equal(fs.statSync(f("a")).mode & 0o777, 0o640);

  const s2 = setup();
  const bad2 = faultyIO({ rename: (a, n) => { if (n === 2) { fs.writeFileSync(s2.f("a"), "THEIRS"); boom("rename failed"); } } }, { rename: (a, b) => isTemp(a) && isTarget(a, b) });
  assert.throws(() => publish(bad2, s2.writes, { inputs: s2.inputs, rescueTag: "t" }), /changed by someone else, not restored: .*\/a \(original kept in .*a\.t-rescue-/);
  const out = snap(s2.d);
  assert.equal(out.a, "THEIRS");
  assert.equal(out.b, "B0");
  assert.equal(Object.entries(out).find(([k]) => k.startsWith("a.t-rescue-"))[1], "A0");
});

test("publish: symlinked target written through; retarget before rename aborts", () => {
  const { d, f } = setup();
  const r1 = path.join(d, "r1"), r2 = path.join(d, "r2");
  fs.writeFileSync(r1, "R");
  fs.writeFileSync(r2, "R");
  fs.symlinkSync(r1, f("link"));
  publish(io, [{ file: f("link"), before: "R", after: "R1" }], { rescueTag: "t" });
  assert.ok(fs.lstatSync(f("link")).isSymbolicLink());
  assert.equal(fs.readFileSync(r1, "utf8"), "R1");
  // the link is retargeted while the first file is being renamed: the second rename must refuse
  const racy = faultyIO({ rename: (a, n) => { if (n === 0) { fs.unlinkSync(f("link")); fs.symlinkSync(r2, f("link")); } } }, { rename: isTarget });
  assert.throws(
    () => publish(racy, [{ file: f("b"), before: "B0", after: "B1" }, { file: f("link"), before: "R1", after: "R2" }], { rescueTag: "t" }),
    /symlink now points elsewhere.*earlier files restored/,
  );
  assert.equal(fs.readFileSync(f("b"), "utf8"), "B0");
  assert.equal(fs.readFileSync(r1, "utf8"), "R1");
  assert.equal(fs.readFileSync(r2, "utf8"), "R");
});

const P = createLockProtocol({ ownerName: "ui", ttlMs: 60_000, unparseableStaleMs: 600_000 });
const busyMessage = (who) => `busy: ${who?.kind ?? "?"}`;

test("acquireLock: exclusive, released only if ours, live owners block", () => {
  const d = tmp();
  const lock = path.join(d, ".lock");
  const release = acquireLock(io, lock, { protocol: P, busyMessage });
  const rec = JSON.parse(fs.readFileSync(lock, "utf8"));
  assert.equal(rec.pid, process.pid);
  assert.equal(fs.statSync(lock).mode & 0o777, 0o600);
  assert.throws(() => acquireLock(io, lock, { protocol: P, busyMessage }), /^Error: busy: process$/);
  release();
  assert.ok(!fs.existsSync(lock));
  fs.writeFileSync(lock, P.makeHolderRecord("t", Date.now()));
  assert.throws(() => acquireLock(io, lock, { protocol: P, busyMessage }), /busy: holder/);
  const rel = acquireLock(io, path.join(d, ".lock2"), { protocol: P, busyMessage });
  fs.writeFileSync(path.join(d, ".lock2"), "someone else");
  rel();
  assert.equal(fs.readFileSync(path.join(d, ".lock2"), "utf8"), "someone else");
  assert.throws(() => acquireLock(io, path.join(d, "missing/.lock"), { protocol: P, busyMessage }), /does not exist/);
});

test("acquireLock: free/stale reclaimed; re-acquire race backs off and keeps theirs", () => {
  const d = tmp();
  const lock = path.join(d, ".lock");
  for (const text of [P.releasedMarker, JSON.stringify({ pid: 2 ** 22 + 3, host: os.hostname(), time: 0, token: "x" })]) {
    fs.writeFileSync(lock, text);
    const rel = acquireLock(io, lock, { protocol: P, busyMessage });
    assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
    rel();
    assert.deepEqual(list(d), []);
  }
  fs.writeFileSync(lock, P.releasedMarker);
  const racy = faultyIO({ rename: () => fs.writeFileSync(lock, P.makeHolderRecord("race", Date.now())) }, { rename: (a, b) => b.includes(".reclaim-") });
  assert.throws(() => acquireLock(racy, lock, { protocol: P, busyMessage }), /busy: holder/);
  assert.equal(P.parseLock(fs.readFileSync(lock, "utf8")).token, "race");
  assert.deepEqual(list(d), [".lock"]);
  // inspectLock surfaces unreadable locks
  if (process.getuid?.() !== 0) {
    fs.chmodSync(lock, 0);
    assert.throws(() => inspectLock(io, lock, P), /cannot read lock .*EACCES/);
    fs.chmodSync(lock, 0o600);
  }
  assert.deepEqual(inspectLock(io, path.join(d, "none"), P), { stale: true, info: null, text: null });
});

test("faultyIO validates method names and counts only matching calls", () => {
  assert.throws(() => faultyIO({ nope: () => {} }), /no method nope/);
  const seen = [];
  const w = faultyIO({ readFile: ([p], n) => seen.push([path.basename(p), n]) }, { readFile: (p) => p.endsWith(".x") }, { ...io, readFile: () => "ok" });
  w.readFile("/a.x");
  w.readFile("/b.y");
  w.readFile("/c.x");
  assert.deepEqual(seen, [["a.x", 0], ["c.x", 1]]);
});

test("publish refuses two writes to the same physical file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-dup-"));
  try {
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "old");
    fs.symlinkSync(f, path.join(dir, "link.txt"));
    const io = createNodeIO();
    assert.throws(
      () => publish(io, [
        { file: f, before: "old", after: "one" },
        { file: path.join(dir, "link.txt"), before: "old", after: "two" },
      ], { rescueTag: "t" }),
      /same file/,
    );
    assert.equal(fs.readFileSync(f, "utf8"), "old");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a temp write that fails halfway is removed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-tmp-"));
  try {
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "old");
    const base = createNodeIO();
    const io = { ...base, writeNew(p, text, mode) { fs.writeFileSync(p, text.slice(0, 2)); throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
    assert.throws(() => publish(io, [{ file: f, before: "old", after: "new" }], { rescueTag: "t" }), /disk full/);
    assert.deepEqual(fs.readdirSync(dir), ["a.txt"]);
    assert.equal(fs.readFileSync(f, "utf8"), "old");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
