// bun test shared/test/panel-txn.test.js
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createFakeHost } from "./fake-host.js";
import { backupOnce, rescueName, runTxn, TxnConflictError } from "../panel/txn.ts";

let fx;
let conflicts;
beforeEach(() => {
  fx = createFakeHost();
  conflicts = [];
});
afterEach(() => fx.cleanup());

const hooks = () => ({ tag: "demo", onConflict: (p, r) => conflicts.push([p, r]) });
// A "shared" file format: lines; ours are lines starting with "+".
const ours = (text) => (text ?? "").split("\n").filter((l) => l.startsWith("+"));
const mergeOurs = (lines) => (fresh) => [...(fresh ?? "").split("\n").filter((l) => l && !l.startsWith("+")), ...lines].join("\n");

test("writes run in order", async () => {
  fx.put("~/a", "a0");
  fx.put("~/b", "b0");
  await runTxn(fx.host, [
    { path: "~/b", before: "b0", after: "b1" },
    { path: "~/a", before: "a0", after: "a1" },
  ], hooks());
  expect(fx.writes).toEqual(["~/b", "~/a"]);
  expect([fx.read("~/a"), fx.read("~/b")]).toEqual(["a1", "b1"]);
});

test("a failed write rolls back what was written, newest first", async () => {
  fx.put("~/a", "a0");
  fx.put("~/b", "b0");
  fx.failOn = (p, op) => op === "write" && p === "~/c";
  await expect(runTxn(fx.host, [
    { path: "~/a", before: "a0", after: "a1" },
    { path: "~/b", before: "b0", after: "b1" },
    { path: "~/c", before: null, after: "c1" },
  ], hooks())).rejects.toThrow("refused ~/c");
  expect([fx.read("~/a"), fx.read("~/b")]).toEqual(["a0", "b0"]);
  expect(fx.writes).toEqual(["~/a", "~/b", "~/b", "~/a"]);
});

test("beforeWrite runs right before its write (daily backup)", async () => {
  fx.put("~/cfg", "old");
  await runTxn(fx.host, [{ path: "~/cfg", before: "old", after: "new", beforeWrite: () => backupOnce(fx.host, "~/cfg.bak", "old") }], hooks());
  await runTxn(fx.host, [{ path: "~/cfg", before: "new", after: "newer", beforeWrite: () => backupOnce(fx.host, "~/cfg.bak", "new") }], hooks());
  expect(fx.read("~/cfg.bak")).toBe("old"); // written once
  expect(fx.writes).toEqual(["~/cfg.bak", "~/cfg", "~/cfg"]);
});

test("shared file changed since planning: merged onto the fresh text", async () => {
  fx.put("~/s", "user1");
  fx.put("~/s", "user1\nuser2"); // edited after we planned from "user1"
  await runTxn(fx.host, [{ path: "~/s", before: "user1", after: "user1\n+x", shared: true, merge: mergeOurs(["+x"]) }], hooks());
  expect(fx.read("~/s")).toBe("user1\nuser2\n+x");
});

test("shared file changed and no merge given: aborts with TxnConflictError", async () => {
  fx.put("~/s", "changed");
  await expect(runTxn(fx.host, [{ path: "~/s", before: "orig", after: "mine", shared: true }], hooks())).rejects.toBeInstanceOf(TxnConflictError);
  expect(fx.read("~/s")).toBe("changed");
});

test("merge giving null or the fresh text skips the write", async () => {
  fx.put("~/s", "fresh");
  await runTxn(fx.host, [{ path: "~/s", before: "old", after: "x", shared: true, merge: () => "fresh" }], hooks());
  expect(fx.writes).toEqual([]);
});

test("rollback restores a shared file only if it is still ours; otherwise rescues the original", async () => {
  fx.put("~/s", "orig");
  fx.put("~/t", "t0");
  const orig = fx.host.writeFile;
  fx.host.writeFile = async (p, c) => {
    if (p === "~/t") {
      fx.put("~/s", "orig\n+x\nuser edit"); // user edits ~/s after our write
      throw Object.assign(new Error("refused ~/t"), { code: "DENIED" });
    }
    return orig(p, c);
  };
  await expect(runTxn(fx.host, [
    { path: "~/s", before: "orig", after: "orig\n+x", shared: true, merge: mergeOurs(["+x"]) },
    { path: "~/t", before: "t0", after: "t1" },
  ], hooks())).rejects.toThrow("refused ~/t");
  expect(fx.read("~/s")).toBe("orig\n+x\nuser edit"); // left as is
  expect(conflicts.length).toBe(1);
  const [p, rescued] = conflicts[0];
  expect(p).toBe("~/s");
  expect(rescued).toMatch(/^~\/s\.demo-rescue-\d{8}-\d{6}-[a-z0-9]+$/);
  expect(fx.read(rescued)).toBe("orig");
});

test("rollback of a file we created: neutralize if still ours, else leave it", async () => {
  fx.failOn = (p, op) => op === "write" && p === "~/z";
  await expect(runTxn(fx.host, [
    { path: "~/new", before: null, after: "+x\nschema", shared: true, merge: mergeOurs(["+x"]), neutralize: (w) => w.split("\n").filter((l) => !l.startsWith("+")).join("\n") },
    { path: "~/z", before: "z0", after: "z1" },
  ], hooks())).rejects.toThrow();
  expect(fx.read("~/new")).toBe("schema");
  expect(ours(fx.read("~/new"))).toEqual([]);
});

test("rescueName shape", () => {
  const n = rescueName("/p/f.json", "tool", new Date("2026-01-02T03:04:05Z"));
  expect(n).toMatch(/^\/p\/f\.json\.tool-rescue-20260102-030405-[a-z0-9]+$/);
});
