// bun test shared/test/panel-projects.test.js
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createFakeHost } from "./fake-host.js";
import {
  createHomeDeriver,
  createProjectList,
  deriveHomeFromHost,
  filterProjects,
  homeFromDirs,
  isChatsDir,
  shortenDir,
} from "../panel/projects.ts";

let fx;
beforeEach(() => { fx = createFakeHost(); });
afterEach(() => fx.cleanup());

test("homeFromDirs: chats dir, then a shared /home|/Users prefix, else undefined", () => {
  expect(homeFromDirs(["/srv/x", "/home/u/.config/openchamber/chats/2026/s"])).toBe("/home/u");
  expect(homeFromDirs(["/home/u/.config/openchamber/chats"])).toBe("/home/u");
  expect(homeFromDirs(["/home/u/.config/openchamber/chatsX/a"])).toBe("/home/u"); // falls through to prefix
  expect(homeFromDirs(["/home/u/a", "/home/u/b"])).toBe("/home/u");
  expect(homeFromDirs(["/Users/m/code"])).toBe("/Users/m");
  expect(homeFromDirs(["/home/a/x", "/home/b/y"])).toBe(undefined);
  expect(homeFromDirs(["/srv/x"])).toBe(undefined);
  expect(homeFromDirs(["/data/me/.app/chats/1"], { chatsSuffix: "/.app/chats" })).toBe("/data/me");
});

test("isChatsDir / shortenDir / filterProjects", () => {
  expect(isChatsDir("/home/u/.config/openchamber/chats/2026/s1")).toBe(true);
  expect(isChatsDir("/home/u/Projects/chats")).toBe(false);
  expect(shortenDir("/home/u/Projects/x", "/home/u")).toBe("~/Projects/x");
  expect(shortenDir("/home/u", "/home/u")).toBe("~");
  expect(shortenDir("/srv/a/b/c")).toBe("…/b/c");
  const ps = [{ id: "1", name: "Alpha", directory: "/a" }, { id: "2", name: "Beta", directory: "/srv/alpha2" }];
  expect(filterProjects(ps, "ALPHA").map((p) => p.id)).toEqual(["1", "2"]);
  expect(filterProjects(ps, "").length).toBe(2);
});

test("project list: skips chats, sorts, notifies watchers, shares one subscription", async () => {
  fx.projects = [
    { id: "c", name: "chats", directory: `${fx.home}/.config/openchamber/chats/x` },
    { id: "2", name: "Zed", directory: `${fx.home}/z` },
    { id: "1", name: "Alpha", directory: `${fx.home}/a` },
  ];
  let listCalls = 0;
  const orig = fx.host.listProjects;
  fx.host.listProjects = async () => { listCalls++; return orig(); };
  const list = createProjectList({ host: fx.host, home: () => fx.home });
  let seen = 0;
  const un1 = list.watch(() => seen++);
  list.watch(() => {});
  expect(list.state).toBe("loading");
  expect(list.note(0, "")).toBe("Loading projects…");
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(1);
  expect(list.projects.map((p) => p.name)).toEqual(["Alpha", "Zed"]);
  expect(list.state).toBe("ready");
  expect(list.note(0, "q")).toBe("No matching projects");
  expect(list.note(2, "")).toBe(null);
  expect(list.shortDir(`${fx.home}/a/b`)).toBe("~/a/b");
  // live update through onProjects
  fx.projects = [...fx.projects, { id: "3", name: "Mid", directory: "/srv/m" }];
  fx.emitProjects();
  expect(list.projects.map((p) => p.name)).toEqual(["Alpha", "Mid", "Zed"]);
  un1();
  const before = seen;
  fx.emitProjects();
  expect(seen).toBe(before);
});

test("project list: NOT_GRANTED gives the injected message", async () => {
  fx.host.listProjects = async () => { throw Object.assign(new Error("no"), { code: "NOT_GRANTED" }); };
  const list = createProjectList({ host: fx.host, notGrantedMessage: "Approve sessions please" });
  list.watch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  expect(list.state).toBe("error");
  expect(list.note(0, "")).toBe("Approve sessions please");
});

test("deriveHomeFromHost: caches once ready or once home is found", async () => {
  let calls = 0;
  const host = {
    listProjects: async () => {
      calls++;
      return { state: "ready", projects: [{ id: "1", name: "a", directory: "/home/alice/a" }] };
    },
  };
  const state = { home: undefined, homeDerived: false };
  expect(await deriveHomeFromHost(host, state)).toBe("/home/alice");
  expect(state).toEqual({ home: "/home/alice", homeDerived: true });
  expect(await deriveHomeFromHost(host, state)).toBe("/home/alice");
  expect(calls).toBe(1);

  // Ready snapshot with no derivable home still marks homeDerived = true so we don't re-poll.
  let emptyCalls = 0;
  const noHomeHost = {
    listProjects: async () => {
      emptyCalls++;
      return { state: "ready", projects: [{ id: "1", name: "srv", directory: "/srv/app" }] };
    },
  };
  const noHomeState = { home: undefined, homeDerived: false };
  expect(await deriveHomeFromHost(noHomeHost, noHomeState)).toBe(undefined);
  expect(noHomeState).toEqual({ home: undefined, homeDerived: true });
  expect(await deriveHomeFromHost(noHomeHost, noHomeState)).toBe(undefined);
  expect(emptyCalls).toBe(1);
});

test("createHomeDeriver: retries while loading without home, caches when found, and supports reset", async () => {
  const snapshots = [
    { state: "loading", projects: [] },
    { state: "loading", projects: [{ id: "1", name: "a", directory: "/Users/bob/proj" }] },
    { state: "ready", projects: [{ id: "2", name: "b", directory: "/Users/carol/proj" }] },
  ];
  let calls = 0;
  const host = {
    listProjects: async () => snapshots[Math.min(calls++, snapshots.length - 1)],
  };
  const deriver = createHomeDeriver(host);
  expect(deriver.get()).toBe(undefined);

  // First call: loading with empty projects -> not derived yet.
  expect(await deriver.derive()).toBe(undefined);
  expect(deriver.get()).toBe(undefined);
  expect(calls).toBe(1);

  // Second call: retries while still loading, derives home from projects, and caches it.
  expect(await deriver.derive()).toBe("/Users/bob");
  expect(deriver.get()).toBe("/Users/bob");
  expect(calls).toBe(2);

  // Third call: cached, does not hit host again.
  expect(await deriver.derive()).toBe("/Users/bob");
  expect(calls).toBe(2);

  // Reset clears cached state and re-queries host.
  deriver.reset();
  expect(deriver.get()).toBe(undefined);
  expect(await deriver.derive()).toBe("/Users/carol");
  expect(deriver.get()).toBe("/Users/carol");
  expect(calls).toBe(3);
});

test("createHomeDeriver / deriveHomeFromHost: reports errors via onError and retries later", async () => {
  const errors = [];
  let shouldFail = true;
  let calls = 0;
  const host = {
    listProjects: async () => {
      calls++;
      if (shouldFail) throw new Error("boom");
      return { state: "ready", projects: [{ id: "1", name: "a", directory: "/home/dev/work" }] };
    },
  };
  const deriver = createHomeDeriver(host, (e) => errors.push(e));

  expect(await deriver.derive()).toBe(undefined);
  expect(deriver.get()).toBe(undefined);
  expect(errors.length).toBe(1);
  expect(errors[0].message).toBe("boom");

  // Retry succeeds because failed attempt did not mark homeDerived.
  shouldFail = false;
  expect(await deriver.derive()).toBe("/home/dev");
  expect(deriver.get()).toBe("/home/dev");
  expect(calls).toBe(2);
});
