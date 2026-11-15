import { test } from "node:test";
import assert from "node:assert/strict";
import { createLockProtocol } from "../core/lock.js";

const P = createLockProtocol({ ownerName: "ui", ttlMs: 1000, unparseableStaleMs: 5000 });

test("config is validated", () => {
  assert.throws(() => createLockProtocol({ ownerName: "", ttlMs: 1, unparseableStaleMs: 1 }), /ownerName/);
  assert.throws(() => createLockProtocol({ ownerName: "x", ttlMs: 0, unparseableStaleMs: 1 }), /positive/);
});

test("records: exact wire text; round-trip", () => {
  assert.equal(P.releasedMarker, '{"owner":"ui","released":true,"time":0}');
  assert.equal(P.makeHolderRecord("t", 5), '{"owner":"ui","host":"ui","pid":0,"token":"t","time":5}');
  assert.equal(P.makeProcessRecord({ pid: 7, host: "h", time: 9, token: "k" }), '{"pid":7,"host":"h","time":9,"token":"k"}\n');
  assert.deepEqual(P.parseLock(P.makeHolderRecord("t", 5)), { kind: "holder", token: "t", time: 5, host: "ui" });
  assert.deepEqual(P.parseLock(P.makeProcessRecord({ pid: 7, host: "h", time: 9, token: "k" })), { kind: "process", pid: 7, host: "h", token: "k", time: 9 });
  assert.deepEqual(P.parseLock(P.releasedMarker), { kind: "released" });
});

test("parseLock: owner must match for holder/released; invalid shapes", () => {
  assert.equal(P.parseLock('{"owner":"other","released":true}').kind, "invalid");
  assert.equal(P.parseLock('{"released":true}').kind, "invalid");
  assert.equal(P.parseLock('{"owner":"ui","released":"true"}').kind, "holder");
  for (const t of ["", "x", "[]", "null", '{"pid":0,"host":"h"}', '{"pid":1}', '{"pid":1.5,"host":"h"}']) {
    assert.equal(P.parseLock(t).kind, "invalid", t);
  }
  const other = createLockProtocol({ ownerName: "panel", ttlMs: 1, unparseableStaleMs: 1 });
  assert.equal(other.parseLock(P.releasedMarker).kind, "invalid"); // owners don't mix
});

test("classifyLock matrix", () => {
  const T = 1e9;
  const c = (text, opts) => P.classifyLock(text === null ? null : P.parseLock(text), { now: T, ...opts });
  const proc = P.makeProcessRecord({ pid: 7, host: "h", time: 0, token: "k" });
  assert.equal(c(null, { mtimeMs: T }), "free");
  assert.equal(c(P.releasedMarker, { mtimeMs: T }), "free");
  // process: pid probe on the same host, never times out while alive
  assert.equal(c(proc, { mtimeMs: 0, host: "h", pidAlive: () => true }), "held");
  assert.equal(c(proc, { mtimeMs: T, host: "h", pidAlive: () => false }), "stale");
  // other host or no probe → unparseable rule
  assert.equal(c(proc, { mtimeMs: T - 4999, host: "x", pidAlive: () => false }), "held");
  assert.equal(c(proc, { mtimeMs: T - 5001, host: "x", pidAlive: () => true }), "stale");
  assert.equal(c(proc, { mtimeMs: T - 5001 }), "stale");
  // holder: ttl from max(time, mtime)
  assert.equal(c(P.makeHolderRecord("t", T - 1000), { mtimeMs: 0 }), "held");
  assert.equal(c(P.makeHolderRecord("t", T - 1001), { mtimeMs: 0 }), "stale");
  assert.equal(c(P.makeHolderRecord("t", 0), { mtimeMs: T - 10 }), "held");
  assert.equal(c('{"owner":"ui","token":"t"}', { mtimeMs: T - 1001 }), "stale");
  // garbage
  assert.equal(c("garbage", { mtimeMs: T - 4999 }), "held");
  assert.equal(c("garbage", { mtimeMs: T - 5001 }), "stale");
  assert.equal(c("garbage", { mtimeMs: undefined }), "stale");
});
