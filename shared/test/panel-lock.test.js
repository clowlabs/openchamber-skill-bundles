// bun test shared/test/panel-lock.test.js
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createFakeHost } from "./fake-host.js";
import { createPanelLock, LockedError } from "../panel/panel-lock.ts";

// A tiny protocol: {"owner":"panel","token":…} is ours; {"released":true,"owner":"panel"} is free.
const PATH = "~/app/.lock";
const RELEASED = '{"owner":"panel","released":true}';
const protocol = {
  path: PATH,
  parse: (t) => { try { return JSON.parse(t); } catch { return { invalid: true }; } },
  classify: (info) => (!info || (info.owner === "panel" && info.released) ? "free" : "held"),
  isOwn: (info, token) => info.owner === "panel" && info.token === token,
  needsMtime: (info) => !info.released,
  record: (token, now) => JSON.stringify({ owner: "panel", token, time: now }),
  releasedMarker: RELEASED,
};

let fx;
beforeEach(() => { fx = createFakeHost(); });
afterEach(() => fx.cleanup());

const make = (extra = {}) => createPanelLock({ ...protocol, host: fx.host, timing: { pollMs: 5, waitMs: 40 }, ...extra });

test("acquire writes the record, confirms the token, release writes the marker", async () => {
  const lock = make({ token: () => "t1" });
  const token = await lock.acquire();
  expect(token).toBe("t1");
  expect(JSON.parse(fx.read(PATH))).toMatchObject({ owner: "panel", token: "t1" });
  await lock.release(token);
  expect(fx.read(PATH)).toBe(RELEASED);
});

test("a released marker is free; withLock always releases", async () => {
  fx.put(PATH, RELEASED);
  const lock = make();
  await expect(lock.withLock(async () => { throw new Error("inside"); })).rejects.toThrow("inside");
  expect(fx.read(PATH)).toBe(RELEASED);
});

test("a held lock times out with the hook's message and is left alone", async () => {
  const held = JSON.stringify({ owner: "cli", pid: 1 });
  fx.put(PATH, held);
  const lock = make({ timeoutMessage: (mtimeMs) => (mtimeMs > 0 ? "busy (dated)" : "busy") });
  await expect(lock.acquire()).rejects.toBeInstanceOf(LockedError);
  await expect(lock.acquire()).rejects.toThrow("busy (dated)");
  expect(fx.read(PATH)).toBe(held);
  expect(fx.writes).toEqual([]);
});

test("losing the write race (token read back differs) waits and times out", async () => {
  const lock = make();
  const orig = fx.host.writeFile;
  fx.host.writeFile = async (p, c) => {
    await orig(p, c);
    // another writer overwrites right after us
    fx.put(PATH, JSON.stringify({ owner: "panel", token: "someone-else" }));
  };
  await expect(lock.acquire()).rejects.toBeInstanceOf(LockedError);
});

test("release never touches a lock that isn't ours", async () => {
  const lock = make({ token: () => "mine" });
  const token = await lock.acquire();
  const theirs = JSON.stringify({ owner: "panel", token: "theirs" });
  fx.put(PATH, theirs);
  await lock.release(token);
  expect(fx.read(PATH)).toBe(theirs);
});

test("a release error goes to onReleaseError, not the caller", async () => {
  const errors = [];
  const lock = make({ token: () => "t", onReleaseError: (e) => errors.push(e.code) });
  const token = await lock.acquire();
  fx.failOn = (p, op) => op === "write" && p === PATH;
  await lock.release(token);
  expect(errors).toEqual(["DENIED"]);
});

test("timing is read live (tests can shorten it after creation)", async () => {
  fx.put(PATH, JSON.stringify({ owner: "cli" }));
  const timing = { pollMs: 1000, waitMs: 10_000 };
  const lock = createPanelLock({ ...protocol, host: fx.host, timing });
  timing.pollMs = 2;
  timing.waitMs = 10;
  const t0 = Date.now();
  await expect(lock.acquire()).rejects.toBeInstanceOf(LockedError);
  expect(Date.now() - t0).toBeLessThan(500);
});
