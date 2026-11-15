// bun test shared/test/panel-queue.test.js
import { expect, test } from "bun:test";
import { createQueue } from "../panel/queue.ts";

test("tasks run one at a time, in order, none dropped", async () => {
  const q = createQueue();
  const log = [];
  let running = 0;
  const task = (n, ms) => async () => {
    running++;
    expect(running).toBe(1);
    log.push(`start ${n}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end ${n}`);
    running--;
  };
  const all = [q.enqueue(task(1, 15)), q.enqueue(task(2, 1)), q.enqueue(task(3, 5))];
  expect(q.pending).toBe(3);
  expect(await Promise.all(all)).toEqual([true, true, true]);
  await q.idle();
  expect(log).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  expect(q.pending).toBe(0);
});

test("a throwing task reports onError, resolves false, and the queue keeps going", async () => {
  const errors = [];
  const q = createQueue({ onError: (e) => errors.push(e.message) });
  const a = q.enqueue(async () => { throw new Error("boom"); });
  const b = q.enqueue(async () => {});
  expect(await a).toBe(false);
  expect(await b).toBe(true);
  expect(errors).toEqual(["boom"]);
});

test("hooks: onQueued synchronously, onSettled after each task", async () => {
  const log = [];
  const q = createQueue({ onQueued: () => log.push(`queued ${q.pending}`), onSettled: () => log.push(`settled ${q.pending}`) });
  q.enqueue(async () => { log.push("run"); });
  expect(log).toEqual(["queued 1"]);
  await q.idle();
  expect(log).toEqual(["queued 1", "run", "settled 0"]);
});

test("enqueueAccepted runs onAccepted only when the task returns true", async () => {
  const q = createQueue();
  const accepted = [];
  expect(await q.enqueueAccepted(async () => true, () => accepted.push("yes"))).toBe(true);
  expect(await q.enqueueAccepted(async () => false, () => accepted.push("no"))).toBe(false);
  expect(await q.enqueueAccepted(async () => { throw new Error("x"); }, () => accepted.push("err"))).toBe(false);
  expect(accepted).toEqual(["yes"]);
});
