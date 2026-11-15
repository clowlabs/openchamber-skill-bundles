// Panel I/O (panel/io.ts) against a filesystem-backed fake host. Needs bun (it imports TS):
//   bun test test/panel-io.test.js
// Under `node --test test/` it registers one skipped test, so the CLI/core suite stays green.
import fs from "node:fs";

const isBun = typeof globalThis.Bun !== "undefined";
if (!isBun) {
  const { test: nodeTest } = await import("node:test");
  nodeTest("panel-io (run with: bun test test/panel-io.test.js)", { skip: "needs bun" }, () => {});
}
const { afterEach, beforeEach, expect, test } = isBun ? await import("bun:test") : { afterEach() {}, beforeEach() {}, expect() {}, test() {} };
const { HostRequestError } = await import("@openchamber/sdk");
const core = await import("../src/core.js");
const io = isBun ? await import("../panel/io.ts") : null;

const { createFakeHost } = await import("../shared/test/fake-host.js");

// Shared fake host (shared/test/fake-host.js); these names keep the tests below unchanged.
let fx;
let home;
const real = (p) => fx.real(p);
const put = (p, text) => fx.put(p, text);
const read = (p) => fx.read(p);
/** A fresh host object on the same fixture (tests wrap its methods). */
const fakeHost = () => ({ ...fx.host });
// writes / toasts / failOn are live views of the fixture
let writes, toasts, failOn;
const skillMd = (desc) => `---\nname: x\ndescription: ${desc}\n---\nBody\n`;
// Let the queue (and its render hooks) settle.
const settle = async () => {
  await io.enqueue(async () => {});
};

beforeEach(async () => {
  fx = createFakeHost({ makeError: (code, msg) => new HostRequestError(code, msg) });
  home = fx.home;
  writes = fx.writes;
  toasts = fx.toasts;
  failOn = () => false;
  fx.failOn = (p, op) => op === "write" && failOn(p);
  io.lockTiming.pollMs = 10;
  io.lockTiming.waitMs = 60;
  put("~/.config/opencode/opencode.json", JSON.stringify({ $schema: "x", permissions: [] }, null, 2) + "\n");
  put("~/.config/opencode/skills/alpha/SKILL.md", skillMd("Alpha"));
  put("~/.config/opencode/skills/beta/SKILL.md", skillMd("Beta"));
  put("~/.config/opencode/skill-bundles.json", core.serializeBundles(core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [{ id: "b", name: "B", enabled: false, skills: ["alpha", "beta"] }],
    overrides: {},
  }))));
  io.setHost(fakeHost());
  io.S.homeDerived = false;
  io.S.home = undefined;
  await io.load();
  fx.writes.length = 0;
});

afterEach(() => {
  fx.cleanup();
});

test("save writes files in PUBLISH_ORDER and releases the lock", async () => {
  // "called" needs a SKILL.md edit, an opencode.json allow rule and a bundles override.
  expect(await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setOverride(core.setBundleEnabled(s, "b", true), "alpha", "called"))).toBe(true);
  })).toBe(true);
  await settle();
  const kinds = writes
    .filter((p) => p !== core.LOCK_PATH && !p.includes(".skill-bundles-"))
    .map((p) => (p.endsWith("SKILL.md") ? "skill" : p === core.OPENCODE_PATH ? "opencode" : p === core.BUNDLES_PATH ? "bundles" : p));
  expect(kinds).toEqual(["skill", "opencode", "bundles"]);
  // first write is the lock, last is its release
  expect(writes[0]).toBe(core.LOCK_PATH);
  expect(read(core.LOCK_PATH)).toBe(core.RELEASED_MARKER);
  // backup written once, before opencode.json
  const bak = writes.findIndex((p) => p.includes(".skill-bundles-"));
  expect(bak).toBeGreaterThan(-1);
  expect(bak).toBeLessThan(writes.indexOf(core.OPENCODE_PATH));
  expect(read("~/.config/opencode/skills/alpha/SKILL.md")).toContain("opencode/autoinvoke: false");
  expect(read(core.OPENCODE_PATH)).toContain('"resource": "alpha"');
  expect(core.parseBundles(read(core.BUNDLES_PATH)).overrides.alpha).toBe("called");
});

test("a failed write rolls back what was already written", async () => {
  const before = {
    md: read("~/.config/opencode/skills/alpha/SKILL.md"),
    oc: read(core.OPENCODE_PATH),
    b: read(core.BUNDLES_PATH),
  };
  failOn = (p) => p === core.BUNDLES_PATH;
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setOverride(core.setBundleEnabled(s, "b", true), "alpha", "called"))).toBe(false);
  });
  await settle();
  failOn = () => false;
  expect(read("~/.config/opencode/skills/alpha/SKILL.md")).toBe(before.md);
  expect(read(core.OPENCODE_PATH)).toBe(before.oc);
  expect(read(core.BUNDLES_PATH)).toBe(before.b);
  expect(read(core.LOCK_PATH)).toBe(core.RELEASED_MARKER);
  expect(toasts.some((t) => t.kind === "error")).toBe(true);
});

test("a held CLI lock blocks: 'CLI is writing', nothing written", async () => {
  const lock = JSON.stringify({ pid: 4242, host: "box", token: "t", time: Date.now() });
  put(core.LOCK_PATH, lock);
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setBundleEnabled(s, "b", true))).toBe(false);
  });
  await settle();
  expect(writes).toEqual([]);
  expect(read(core.LOCK_PATH)).toBe(lock);
  expect(toasts.map((t) => t.message)).toContain("CLI is writing — try again");
});

test("a panel released marker is free", async () => {
  put(core.LOCK_PATH, core.RELEASED_MARKER);
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setBundleEnabled(s, "b", true))).toBe(true);
  });
  await settle();
  expect(core.parseBundles(read(core.BUNDLES_PATH)).bundles[0].enabled).toBe(true);
});

test('{"released":true} without owner is NOT free', async () => {
  const lock = JSON.stringify({ released: true, time: 0 });
  put(core.LOCK_PATH, lock);
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setBundleEnabled(s, "b", true))).toBe(false);
  });
  await settle();
  expect(writes).toEqual([]);
  expect(read(core.LOCK_PATH)).toBe(lock);
  expect(toasts.map((t) => t.message)).toContain("CLI is writing — try again");
});

test("release never touches a lock that isn't ours", async () => {
  // Another writer replaces the lock while we hold it; our release must leave theirs alone.
  const theirs = JSON.stringify({ owner: "panel", host: "panel", pid: 0, token: "someone-else", time: Date.now() });
  const host = fakeHost();
  const origWrite = host.writeFile;
  host.writeFile = async (p, c) => {
    const r = await origWrite(p, c);
    if (p === core.BUNDLES_PATH) fs.writeFileSync(real(core.LOCK_PATH), theirs);
    return r;
  };
  io.setHost(host);
  await io.enqueue(async () => {
    await io.applyChange((s) => core.setBundleEnabled(s, "b", true));
  });
  await settle();
  expect(read(core.LOCK_PATH)).toBe(theirs);
});

test("a description edit is based on a fresh read", async () => {
  // The CLI changed beta's SKILL.md after the panel loaded it.
  const cliText = `---\nname: x\ndescription: Beta\nmetadata:\n  opencode/autoinvoke: false\n---\nBody\n`;
  put("~/.config/opencode/skills/beta/SKILL.md", cliText);
  io.saveDescription("beta", "New description");
  await settle();
  await settle();
  const now = read("~/.config/opencode/skills/beta/SKILL.md");
  expect(now).toContain("description: New description");
  expect(now).toContain("opencode/autoinvoke: false");
  expect(io.S.skillMds.beta).toBe(now);
  expect(read(core.LOCK_PATH)).toBe(core.RELEASED_MARKER);
});

// ---------- per-project bundles (v0.2) ----------

const PROJ = "~/work/app";
const projFile = core.projectConfigPath(PROJ);

test("a save with a project writes <dir>/.opencode/opencode.json in PUBLISH_ORDER", async () => {
  fs.mkdirSync(real(PROJ), { recursive: true });
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setOverride(core.addBundleProject(s, "b", PROJ), "alpha", "called"))).toBe(true);
  });
  await settle();
  const kinds = writes
    .filter((p) => p !== core.LOCK_PATH && !p.includes(".skill-bundles-"))
    .map((p) => (p.endsWith("SKILL.md") ? "skill" : p === projFile ? "project" : p === core.OPENCODE_PATH ? "opencode" : p === core.BUNDLES_PATH ? "bundles" : p));
  expect(kinds).toEqual(["skill", "project", "opencode", "bundles"]);
  const pj = JSON.parse(read(projFile));
  const allowed = pj.permissions.filter((r) => r.action === "skill").map((r) => r.resource);
  expect(allowed).toEqual(["alpha", "beta"]);
  expect(pj.permissions.some((r) => r.resource === "*")).toBe(false);
  const saved = core.parseBundles(read(core.BUNDLES_PATH));
  expect(saved.managedProjects).toEqual([PROJ]);
  expect(io.S.state.managedProjects).toEqual([PROJ]); // adopted plan.state
});

test("removing the project removes its skill rules and keeps other rules", async () => {
  fs.mkdirSync(real(PROJ), { recursive: true });
  await io.enqueue(async () => { await io.applyChange((s) => core.addBundleProject(s, "b", PROJ)); });
  await settle();
  // the user adds an unrelated rule in the project file
  const pj = JSON.parse(read(projFile));
  pj.permissions.unshift({ action: "bash", resource: "*", effect: "allow" });
  put(projFile, JSON.stringify(pj, null, 2) + "\n");
  writes.length = 0;
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.removeBundleProject(s, "b", PROJ))).toBe(true);
  });
  await settle();
  const after = JSON.parse(read(projFile));
  expect(after.permissions.filter((r) => r.action === "skill")).toEqual([]);
  expect(after.permissions).toEqual([{ action: "bash", resource: "*", effect: "allow" }]);
  expect(writes).toContain(projFile);
});

test("rollback when the project write fails", async () => {
  fs.mkdirSync(real(PROJ), { recursive: true });
  const existing = JSON.stringify({ $schema: "https://opencode.ai/config.json", permissions: [] }, null, 2) + "\n";
  put(projFile, existing);
  // make alpha "called" so a SKILL.md is written before the project file
  const md = read("~/.config/opencode/skills/alpha/SKILL.md");
  const oc = read(core.OPENCODE_PATH);
  const b = read(core.BUNDLES_PATH);
  failOn = (p) => p === projFile;
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setOverride(core.addBundleProject(s, "b", PROJ), "alpha", "called"))).toBe(false);
  });
  await settle();
  failOn = () => false;
  expect(read("~/.config/opencode/skills/alpha/SKILL.md")).toBe(md);
  expect(read(projFile)).toBe(existing);
  expect(read(core.OPENCODE_PATH)).toBe(oc);
  expect(read(core.BUNDLES_PATH)).toBe(b);
  expect(read(core.LOCK_PATH)).toBe(core.RELEASED_MARKER);
});

// ---------- project files edited by someone else mid-save ----------

const lockedByPanel = () => {
  try { return core.parseLock(fs.readFileSync(real(core.LOCK_PATH), "utf8")).kind === "panel"; } catch { return false; }
};
const userRule = { action: "bash", resource: "*", effect: "allow" };
const withUserRule = (text) => {
  const j = JSON.parse(text);
  j.permissions.unshift(userRule);
  return JSON.stringify(j, null, 2) + "\n";
};

test("an edit to the project file during the SKILL.md refresh is merged, not erased", async () => {
  fs.mkdirSync(real(PROJ), { recursive: true });
  put(projFile, JSON.stringify({ $schema: "https://opencode.ai/config.json", permissions: [] }, null, 2) + "\n");
  const h = fakeHost();
  const origRead = h.readFile;
  let edited = false;
  h.readFile = async (p) => {
    // The locked SKILL.md refresh runs after the project files were re-read under the lock.
    if (!edited && p.endsWith("/alpha/SKILL.md") && lockedByPanel()) {
      edited = true;
      fs.writeFileSync(real(projFile), withUserRule(fs.readFileSync(real(projFile), "utf8")));
    }
    return origRead(p);
  };
  io.setHost(h);
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setOverride(core.addBundleProject(s, "b", PROJ), "alpha", "called"))).toBe(true);
  });
  await settle();
  expect(edited).toBe(true);
  const pj = JSON.parse(read(projFile));
  expect(pj.permissions).toContainEqual(userRule);
  expect(pj.permissions.filter((r) => r.action === "skill").map((r) => r.resource)).toEqual(["alpha", "beta"]);
});

test("an edit after the project write survives a failed bundles write; original is rescued", async () => {
  fs.mkdirSync(real(PROJ), { recursive: true });
  const original = JSON.stringify({ $schema: "https://opencode.ai/config.json", permissions: [] }, null, 2) + "\n";
  put(projFile, original);
  const h = fakeHost();
  const origWrite = h.writeFile;
  h.writeFile = async (p, c) => {
    if (p === core.BUNDLES_PATH) {
      // The user edits the project file after our write, then the bundles write fails.
      fs.writeFileSync(real(projFile), withUserRule(fs.readFileSync(real(projFile), "utf8")));
      throw new HostRequestError("DENIED", "refused bundles");
    }
    return origWrite(p, c);
  };
  io.setHost(h);
  const oc = read(core.OPENCODE_PATH);
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.addBundleProject(s, "b", PROJ))).toBe(false);
  });
  await settle();
  const now = JSON.parse(read(projFile));
  expect(now.permissions).toContainEqual(userRule); // their edit kept
  const rescue = fs.readdirSync(real(`${PROJ}/.opencode`)).filter((n) => n.startsWith("opencode.json.skill-bundles-rescue-"));
  expect(rescue.length).toBe(1);
  expect(fs.readFileSync(real(`${PROJ}/.opencode/${rescue[0]}`), "utf8")).toBe(original);
  expect(read(core.OPENCODE_PATH)).toBe(oc);
  expect(toasts.some((t) => t.message.includes("edited meanwhile"))).toBe(true);
});

test("a failed save after creating a project file leaves no skill allows behind", async () => {
  fs.mkdirSync(real(PROJ), { recursive: true }); // folder exists, opencode.json does not
  failOn = (p) => p === core.BUNDLES_PATH;
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.addBundleProject(s, "b", PROJ))).toBe(false);
  });
  await settle();
  failOn = () => false;
  const pj = JSON.parse(read(projFile));
  expect(pj.$schema).toBe("https://opencode.ai/config.json");
  expect(pj.permissions).toEqual([]);
  expect(read(core.LOCK_PATH)).toBe(core.RELEASED_MARKER);
});

// ---------- home dir and project-dir aliases ----------

test("homeFromDirs: chats dir first, then a shared /home or /Users prefix, else undefined", () => {
  expect(io.homeFromDirs(["/srv/x", "/home/u/.config/openchamber/chats/2026/s"])).toBe("/home/u");
  expect(io.homeFromDirs(["/home/u/a", "/home/u/b"])).toBe("/home/u");
  expect(io.homeFromDirs(["/Users/m/code"])).toBe("/Users/m");
  expect(io.homeFromDirs(["/home/a/x", "/home/b/y"])).toBe(undefined);
  expect(io.homeFromDirs(["/srv/x"])).toBe(undefined);
  expect(io.homeFromDirs([])).toBe(undefined);
});

test("load derives home from the chats dir", () => {
  expect(io.S.home).toBe(home);
});

test("an absolute path under home and its ~/ alias produce ONE project write with the union", async () => {
  fs.mkdirSync(real(PROJ), { recursive: true });
  // a second bundle, enabled through the project under its absolute spelling
  const abs = `${home}/${PROJ.slice(2)}`;
  put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [
      { id: "b", name: "B", enabled: false, skills: ["alpha"], projects: [PROJ] },
      { id: "c", name: "C", enabled: false, skills: ["beta"], projects: [abs] },
    ],
    overrides: {},
  }))));
  await io.load();
  writes.length = 0;
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setBundleEnabled(s, "b", false))).toBe(true);
  });
  await settle();
  const projWrites = writes.filter((p) => p.endsWith("/.opencode/opencode.json") && p !== core.OPENCODE_PATH);
  expect(projWrites).toEqual([projFile]);
  const pj = JSON.parse(read(projFile));
  expect(pj.permissions.filter((r) => r.action === "skill").map((r) => r.resource)).toEqual(["alpha", "beta"]);
  const saved = core.parseBundles(read(core.BUNDLES_PATH));
  expect(saved.bundles.map((b) => b.projects)).toEqual([[PROJ], [PROJ]]);
  expect(saved.managedProjects).toEqual([PROJ]);
});

// ---------- Work Status counts (status/counts.ts) ----------

const counts = isBun ? await import("../status/counts.ts") : null;

/** 210 skill folders (+2 built-ins = 212); 35 of them in the "dev" bundle. */
function installMany() {
  fs.rmSync(real("~/.config/opencode/skills"), { recursive: true, force: true });
  const ids = Array.from({ length: 210 }, (_, i) => `s${String(i).padStart(3, "0")}`);
  for (const id of ids) put(`~/.config/opencode/skills/${id}/SKILL.md`, skillMd(id));
  fs.mkdirSync(real("~/.config/opencode/skills/.hidden"), { recursive: true }); // dotfiles don't count
  return ids;
}

test("status counts: 35 live / 212 installed from skill-bundles.json", async () => {
  const ids = installMany();
  put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [
      { id: "dev", name: "Dev", enabled: true, skills: ids.slice(0, 34) },
      { id: "plan", name: "Plan", enabled: true, skills: ["opencode"] },
      { id: "media", name: "Media", enabled: false, skills: ids.slice(100, 150), projects: ["~/work/a", "~/work/b"] },
    ],
    overrides: {},
  }))));
  const c = await counts.readCounts(fx.host);
  expect([c.live, c.installed]).toEqual([35, 212]);
  expect(c.fromOpencode).toBe(false);
  expect(c.bundlesOn).toEqual(["dev", "plan"]);
  expect(c.chars).toBe(35 * core.CHARS_PER_SKILL);
  expect(fx.writes).toEqual([]); // read-only
});

test("status counts: falls back to opencode.json skill rules when skill-bundles.json is missing", async () => {
  const ids = installMany();
  fs.rmSync(real(core.BUNDLES_PATH));
  const rules = [
    { action: "bash", resource: "*", effect: "allow" },
    { action: "skill", resource: "*", effect: "deny" },
    ...ids.slice(0, 34).map((id) => ({ action: "skill", resource: id, effect: "allow" })),
    { action: "skill", resource: "report", effect: "allow" },
  ];
  put(core.OPENCODE_PATH, JSON.stringify({ $schema: "x", permissions: rules }, null, 2) + "\n");
  const c = await counts.readCounts(fx.host);
  expect([c.live, c.installed]).toEqual([35, 212]);
  expect(c.fromOpencode).toBe(true);
  expect(c.bundlesOn).toBe(null);
  // no skill rules at all: everything is live
  put(core.OPENCODE_PATH, JSON.stringify({ permissions: [] }) + "\n");
  expect((await counts.readCounts(fx.host)).live).toBe(212);
});

// ---------- hot-swap toggles (rail panel compact view) ----------

test("toggleBundle (compact row) flips enabled through the locked save path", async () => {
  expect(io.S.state.bundles[0].enabled).toBe(false);
  io.toggleBundle("b");
  await settle();
  expect(core.parseBundles(read(core.BUNDLES_PATH)).bundles[0].enabled).toBe(true);
  expect(io.S.state.bundles[0].enabled).toBe(true);
  // lock taken first, released last, opencode.json rewritten with the bundle's allows
  expect(writes[0]).toBe(core.LOCK_PATH);
  expect(read(core.LOCK_PATH)).toBe(core.RELEASED_MARKER);
  expect(read(core.OPENCODE_PATH)).toContain('"resource": "alpha"');
  io.toggleBundle("b");
  await settle();
  expect(core.parseBundles(read(core.BUNDLES_PATH)).bundles[0].enabled).toBe(false);
});

test("toggleBundle with a held CLI lock writes nothing and shows the lock toast", async () => {
  put(core.LOCK_PATH, JSON.stringify({ pid: 4242, host: "box", token: "t", time: Date.now() }));
  io.toggleBundle("b");
  await settle();
  expect(writes).toEqual([]);
  expect(core.parseBundles(read(core.BUNDLES_PATH)).bundles[0].enabled).toBe(false);
  expect(toasts.map((t) => t.message)).toContain("CLI is writing — try again");
});

test("panel lock: an orphaned panel lock past its TTL is reclaimed; a CLI lock is not", async () => {
  put(core.LOCK_PATH, core.panelLockRecord("orphan", Date.now() - core.PANEL_LOCK_TTL_MS - 5_000));
  // the file's mtime must be old too (classifyLock uses the later of time and mtime)
  const old = new Date(Date.now() - core.PANEL_LOCK_TTL_MS - 5_000);
  fs.utimesSync(real(core.LOCK_PATH), old, old);
  io.toggleBundle("b");
  await settle();
  expect(core.parseBundles(read(core.BUNDLES_PATH)).bundles[0].enabled).toBe(true);
  expect(read(core.LOCK_PATH)).toBe(core.RELEASED_MARKER);

  const cli = JSON.stringify({ pid: 4242, host: "box", token: "t", time: Date.now() - 3_600_000 });
  put(core.LOCK_PATH, cli);
  const older = new Date(Date.now() - 3_600_000);
  fs.utimesSync(real(core.LOCK_PATH), older, older);
  writes.length = 0;
  io.toggleBundle("b");
  await settle();
  expect(writes).toEqual([]);
  expect(read(core.LOCK_PATH)).toBe(cli);
});

// ---------- meter: pct and tokens ----------

test("meter: 35 live / 211 installed → 17%, ~1.6k tokens", async () => {
  const ids = installMany(); // 210 folders + 2 built-ins = 212
  fs.rmSync(real(`~/.config/opencode/skills/${ids[209]}`), { recursive: true }); // 211 installed
  put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [
      { id: "dev", name: "Dev", enabled: true, skills: [...ids.slice(0, 34), "ghost"] }, // ghost: not installed
      { id: "plan", name: "Plan", enabled: true, skills: ["opencode"] },
    ],
    overrides: {},
  }))));
  const c = await counts.readCounts(fx.host);
  expect([c.live, c.installed]).toEqual([35, 211]);
  expect(counts.livePct(c)).toBe(17);
  expect(c.chars).toBe(6300);
  expect(counts.formatTokens(counts.tokensOf(c.chars))).toBe("1.6k");
});

test("counts: 0 live → 0%, ~0 tokens; nothing installed → 0%", async () => {
  const c = counts.countsFromState(core.parseBundles(JSON.stringify({
    version: 1, bundles: [{ id: "x", name: "X", enabled: false, skills: ["alpha"] }], overrides: {},
  })), ["alpha", "beta", "opencode", "report"], null);
  expect(c.live).toBe(0);
  expect(counts.livePct(c)).toBe(0);
  expect(counts.formatTokens(counts.tokensOf(c.chars))).toBe("0");
  expect(counts.livePct({ live: 0, installed: 0 })).toBe(0);
  expect([950, 1000, 1600, 9999, 12345, 1250000].map(counts.formatTokens)).toEqual(["950", "1k", "1.6k", "10k", "12k", "1.3M"]);
});
