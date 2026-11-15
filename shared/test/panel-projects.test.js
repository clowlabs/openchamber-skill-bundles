// bun test shared/test/panel-projects.test.js
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createFakeHost } from "./fake-host.js";
import { createProjectList, filterProjects, homeFromDirs, isChatsDir, shortenDir } from "../panel/projects.ts";

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
