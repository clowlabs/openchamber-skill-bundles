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
  io.S.createdBundles = [];
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

test("Page toggleBundle with an explicit value clears bundle overrides and can be undone", async () => {
  put(core.BUNDLES_PATH, core.serializeBundles({
    ...io.S.state,
    overrides: { alpha: "called", beta: "off", opencode: "off" },
  }));
  await io.load();
  io.toggleBundle("b", true);
  await settle();
  const saved = core.parseBundles(read(core.BUNDLES_PATH));
  expect(saved.bundles[0].enabled).toBe(true);
  expect(saved.overrides).toEqual({ opencode: "off" });
  expect(io.undoLabel()).toBe("toggle bundle");
  await io.undo();
  await settle();
  const restored = core.parseBundles(read(core.BUNDLES_PATH));
  expect(restored.bundles[0].enabled).toBe(false);
  expect(restored.overrides).toEqual({ alpha: "called", beta: "off", opencode: "off" });
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

// ---------- multi-root skill discovery ----------

test("discovery: all three roots, precedence, flat .md, nested, and symlinked skill dir", async () => {
  put("~/.claude/skills/claude-only/SKILL.md", skillMd("Claude only"));
  put("~/.claude/skills/flat-one.md", skillMd("Flat one"));
  put("~/.claude/skills/shared/SKILL.md", skillMd("From claude"));
  put("~/.agents/skills/shared/SKILL.md", skillMd("From agents"));
  put("~/.agents/skills/team/sub/nested-one/SKILL.md", skillMd("Nested"));
  put("~/.agents/skills/team/sub/nested-one/inner/SKILL.md", skillMd("Should not be a separate skill"));
  put("~/.config/opencode/skills/shared/SKILL.md", skillMd("From opencode"));
  put("~/custom-skills/extra/SKILL.md", skillMd("From config"));
  put(core.OPENCODE_PATH, JSON.stringify({ $schema: "x", skills: ["~/custom-skills"], permissions: [] }, null, 2) + "\n");

  // Real symlink in ~/.agents/skills pointing to an external skill folder.
  put("~/ext-store/linked-skill/SKILL.md", skillMd("Linked"));
  fs.mkdirSync(real("~/.agents/skills"), { recursive: true });
  fs.symlinkSync(real("~/ext-store/linked-skill"), real("~/.agents/skills/linked-skill"));

  await io.load();
  expect(io.S.unreachable).toEqual([]);
  for (const id of ["alpha", "beta", "claude-only", "flat-one", "nested-one", "shared", "extra", "linked-skill"]) {
    expect(io.S.allIds).toContain(id);
  }
  expect(io.S.allIds).not.toContain("inner");

  // Precedence: ~/.config/opencode/skills wins over ~/.agents/skills and ~/.claude/skills.
  expect(io.skillPath("shared")).toBe("~/.config/opencode/skills/shared/SKILL.md");
  expect(io.meta("shared").description).toBe("From opencode");

  // Flat .md has dir === null and real path.
  expect(io.S.skillRefs["flat-one"].dir).toBe(null);
  expect(io.skillPath("flat-one")).toBe("~/.claude/skills/flat-one.md");
  expect(io.S.skillRefs["nested-one"].dir).toBe("~/.agents/skills/team/sub/nested-one");
  expect(io.S.skillRefs["linked-skill"].dir).toBe("~/.agents/skills/linked-skill");

  // status/counts.ts sees the exact same discovered ids.
  const statusIds = await counts.listSkillIds(fx.host);
  expect(statusIds).toEqual(io.S.allIds);
  const c = await counts.readCounts(fx.host);
  expect(c.installed).toBe(io.S.allIds.length);
});

test("discovery: BAD_PATH on a custom root or symlink entry is collected in unreachable without throwing", async () => {
  put(core.OPENCODE_PATH, JSON.stringify({ $schema: "x", skills: ["/outside/skills"], permissions: [] }, null, 2) + "\n");
  put("~/ext-store/bad-target/SKILL.md", skillMd("Bad"));
  fs.mkdirSync(real("~/.agents/skills"), { recursive: true });
  fs.symlinkSync(real("~/ext-store/bad-target"), real("~/.agents/skills/bad-link"));

  const h = fakeHost();
  const origListDir = h.listDir;
  const origStat = h.stat;
  h.listDir = async (p) => {
    if (p === "/outside/skills") throw new HostRequestError("BAD_PATH", "outside declared globs");
    return origListDir(p);
  };
  h.stat = async (p) => {
    if (p === "~/.agents/skills/bad-link") throw new HostRequestError("BAD_PATH", "symlink outside globs");
    return origStat(p);
  };
  io.setHost(h);
  await io.load();
  expect(io.S.allIds).toContain("alpha");
  expect(io.S.allIds).not.toContain("bad-link");
  expect(io.S.unreachable).toEqual(
    expect.arrayContaining([
      { path: "/outside/skills", code: "BAD_PATH" },
      { path: "~/.agents/skills/bad-link", code: "BAD_PATH" },
    ]),
  );
});

test("saveDescription and applyChange write to a ~/.claude/skills file", async () => {
  put("~/.claude/skills/claude-only/SKILL.md", skillMd("Old claude desc"));
  await io.load();
  expect(io.skillPath("claude-only")).toBe("~/.claude/skills/claude-only/SKILL.md");

  io.saveDescription("claude-only", "Updated claude desc");
  await settle();
  await settle();
  expect(read("~/.claude/skills/claude-only/SKILL.md")).toContain("description: Updated claude desc");

  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setOverride(s, "claude-only", "called"))).toBe(true);
  });
  await settle();
  expect(read("~/.claude/skills/claude-only/SKILL.md")).toContain("opencode/autoinvoke: false");
});

test("discovery: a symlink loop is bounded and reported, other skills still load", async () => {
  fs.mkdirSync(real("~/.agents/skills"), { recursive: true });
  for (const n of ["l1", "l2", "l3", "l4"]) fs.symlinkSync(real("~/.agents/skills"), real(`~/.agents/skills/${n}`));
  const h = fakeHost();
  let lists = 0;
  const orig = h.listDir;
  h.listDir = async (p) => { lists++; return orig(p); };
  io.setHost(h);
  await io.load();
  expect(io.S.allIds).toContain("alpha");
  expect(lists).toBeLessThanOrEqual(2000 + 10);
  expect(io.S.unreachable.some((u) => u.code === "TRUNCATED")).toBe(true);
});

test("load: one unreadable SKILL.md is reported, the rest still loads", async () => {
  put("~/.agents/skills/locked/SKILL.md", skillMd("Locked"));
  const h = fakeHost();
  const orig = h.readFile;
  h.readFile = async (p) => {
    if (p === "~/.agents/skills/locked/SKILL.md") throw new HostRequestError("DENIED", "nope");
    return orig(p);
  };
  io.setHost(h);
  await io.load();
  expect(io.S.loaded).toBe(true);
  expect(io.S.allIds).toContain("locked");
  expect(io.S.allIds).toContain("alpha");
  expect(io.S.skillMds.locked).toBeUndefined();
  expect(io.S.unreachable).toContainEqual({ path: "~/.agents/skills/locked/SKILL.md", code: "DENIED" });
});

test("load: an unreadable SKILL.md blocks its mode controls and 'called' is refused", async () => {
  put("~/.agents/skills/locked/SKILL.md", skillMd("Locked"));
  const h = fakeHost();
  const orig = h.readFile;
  h.readFile = async (p) => {
    if (p === "~/.agents/skills/locked/SKILL.md") throw new HostRequestError("DENIED", "nope");
    return orig(p);
  };
  io.setHost(h);
  await io.load();
  expect(io.fmError("locked")).toContain("could not be read");
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setOverride(s, "locked", "called"))).toBe(false);
  });
  expect(read("~/.agents/skills/locked/SKILL.md")).not.toContain("autoinvoke");
});

test("load: incomplete discovery keeps unseen allow rules and blocks 'when called'", async () => {
  put(core.OPENCODE_PATH, JSON.stringify({ $schema: "x", skills: ["/outside/skills"], permissions: [
    { action: "skill", resource: "*", effect: "deny" }, { action: "skill", resource: "external", effect: "allow" },
  ] }, null, 2) + "\n");
  const h = fakeHost();
  const orig = h.listDir;
  h.listDir = async (p) => {
    if (p === "/outside/skills") throw new HostRequestError("BAD_PATH", "outside");
    return orig(p);
  };
  io.setHost(h);
  await io.load();
  expect(io.S.incomplete).toBe(true);
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setBundleEnabled(s, "b", true))).toBe(true);
  });
  const allows = JSON.parse(read(core.OPENCODE_PATH)).permissions.filter((r) => r.effect === "allow").map((r) => r.resource);
  expect(allows).toContain("external");
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setOverride(s, "alpha", "called"))).toBe(false);
  });
  expect(read("~/.config/opencode/skills/alpha/SKILL.md")).not.toContain("autoinvoke");
});

test("home: an absolute or ~/ config source makes discovery incomplete (home can't be verified)", async () => {
  put(core.OPENCODE_PATH, JSON.stringify({ $schema: "x", skills: ["/home/other/.config/opencode/skills", "~/"], permissions: [] }, null, 2) + "\n");
  fx.projects = [{ id: "p", name: "p", directory: "/home/other/proj" }];
  io.S.homeDerived = false;
  io.S.home = undefined;
  await io.load();
  expect(io.S.incomplete).toBe(true);
  expect(io.S.unreachable.filter((u) => u.code === "NO_HOME").map((u) => u.path).sort()).toEqual(["/home/other/.config/opencode/skills", "~"]);
});

test("home: stock and ~/x sources need no home and stay complete", async () => {
  put("~/team-skills/t1/SKILL.md", skillMd("T1"));
  put(core.OPENCODE_PATH, JSON.stringify({ $schema: "x", skills: ["~/team-skills"], permissions: [] }, null, 2) + "\n");
  await io.load();
  expect(io.S.incomplete).toBe(false);
  expect(io.S.allIds).toContain("t1");
});

// ---------- skill context menu (panel/send.ts) ----------

function installMenuDom() {
  class NodeEl {
    constructor(tag) {
      this.tag = tag.toUpperCase();
      this.className = "";
      this._text = "";
      this.title = "";
      this.value = "";
      this.placeholder = "";
      this.disabled = false;
      this.tabIndex = 0;
      this.dataset = {};
      this.style = {};
      this.attrs = {};
      this.children = [];
      this.parent = null;
      this.listeners = {};
      const syncCls = () => new Set(this.className.split(/\s+/).filter(Boolean));
      this.classList = {
        add: (c) => { const s = syncCls(); s.add(c); this.className = [...s].join(" "); },
        remove: (c) => { const s = syncCls(); s.delete(c); this.className = [...s].join(" "); },
        toggle: (c, on) => { const s = syncCls(); if (on ?? !s.has(c)) s.add(c); else s.delete(c); this.className = [...s].join(" "); },
        contains: (c) => syncCls().has(c),
      };
    }
    get textContent() { return this._text; }
    set textContent(v) {
      this._text = String(v ?? "");
      for (const c of this.children) c.parent = null;
      this.children = [];
    }
    get isConnected() {
      for (let n = this; n; n = n.parent) if (n === globalThis.document?.body) return true;
      return false;
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    appendChild(n) {
      if (n.parent) n.parent.children = n.parent.children.filter((x) => x !== n);
      n.parent = this;
      this.children.push(n);
      return n;
    }
    insertBefore(n, ref) {
      if (n.parent) n.parent.children = n.parent.children.filter((x) => x !== n);
      n.parent = this;
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(n);
      else this.children.splice(i, 0, n);
      return n;
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
      this.parent = null;
    }
    contains(other) {
      for (let n = other; n; n = n.parent) if (n === this) return true;
      return false;
    }
    addEventListener(t, fn) { (this.listeners[t] ??= new Set()).add(fn); }
    removeEventListener(t, fn) { this.listeners[t]?.delete(fn); }
    closest(sel) {
      const parts = sel.split(",").map((s) => s.trim()).filter(Boolean);
      const matchOne = (el, s) => {
        if (s.startsWith(".")) return el.classList.contains(s.slice(1));
        return el.tag === s.toUpperCase();
      };
      for (let n = this; n; n = n.parent) {
        if (parts.some((s) => matchOne(n, s))) return n;
      }
      return null;
    }
    dispatch(t, ev = {}) {
      let stopped = false;
      const event = {
        type: t,
        target: this,
        currentTarget: this,
        preventDefault() {},
        stopPropagation() { stopped = true; },
        ...ev,
      };
      for (const fn of [...(this.listeners[t] ?? [])]) fn(event);
      if (!stopped && this.parent && typeof this.parent.dispatch === "function" && ev._noBubble !== true) {
        this.parent.dispatch(t, { ...ev, target: event.target });
      }
    }
    click(ev = {}) { this.dispatch("click", { altKey: false, detail: 1, ...ev }); }
    focus() { if (globalThis.document) globalThis.document.activeElement = this; }
    getBoundingClientRect() { return { left: 10, top: 10, width: 120, height: 80 }; }
    querySelectorAll(sel) {
      const out = [];
      const parts = sel.split(",").map((s) => s.trim()).filter(Boolean);
      const matchOne = (el, s) => {
        if (s === "button.sb-ctx-item") return el.tag === "BUTTON" && el.classList.contains("sb-ctx-item");
        if (s === ".sb-ctx-icon") return el.classList.contains("sb-ctx-icon");
        if (s === ".sb-ctx-title") return el.classList.contains("sb-ctx-title");
        if (s === ".sb-ctx-filter") return el.classList.contains("sb-ctx-filter");
        if (s === ".sb-ctx-note") return el.classList.contains("sb-ctx-note");
        if (s === ".sb-ctx-confirm button") {
          if (el.tag !== "BUTTON") return false;
          for (let p = el.parent; p; p = p.parent) if (p.classList.contains("sb-ctx-confirm")) return true;
          return false;
        }
        const m = /^\[data-(pid|bid|confirm)="(.+)"\]$/.exec(s);
        if (m) return el.dataset[m[1]] === m[2];
        return false;
      };
      const match = (el) => parts.some((s) => matchOne(el, s));
      const walk = (n) => {
        for (const c of n.children) {
          if (match(c)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  }
  const savedGlobals = new Map();
  for (const k of ["document", "window", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "CSS"]) {
    savedGlobals.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
  }
  const docListeners = {};
  const body = new NodeEl("body");
  globalThis.HTMLElement = NodeEl;
  globalThis.HTMLInputElement = class extends NodeEl {};
  globalThis.HTMLButtonElement = class extends NodeEl {};
  globalThis.CSS = { escape: (s) => String(s) };
  globalThis.document = {
    body,
    activeElement: null,
    createElement: (t) => new NodeEl(t),
    addEventListener: (t, fn) => (docListeners[t] ??= new Set()).add(fn),
    removeEventListener: (t, fn) => docListeners[t]?.delete(fn),
    dispatchKey: (t, ev = {}) => {
      for (const fn of [...(docListeners[t] ?? [])]) {
        fn({ type: t, preventDefault() {}, stopPropagation() {}, ...ev });
      }
    },
  };
  globalThis.window = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return () => {
    for (const [k, desc] of savedGlobals) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  };
}

test("send menu lists newly created bundles automatically and moves/duplicates skills into them", async () => {
  const cleanupDom = installMenuDom();
  let send;
  const prevRender = io.hooks.render;
  try {
    const popup = await import("../panel/popup.ts");
    send = await import("../panel/send.ts");
    io.hooks.render = () => { prevRender(); send.refreshSendMenu(); };
    popup.initPopup(fx.host);
    popup.setHomeSource(() => io.S.home);
    send.initSend({
      host: fx.host,
      blockedReason: () => null,
      bundleBlockedReason: () => io.fmError("alpha"),
      skillRef: (id) => io.S.skillRefs[id],
      enqueue: io.enqueue,
      markMoved: (id, dir) => io.applyChange((s) => core.markMovedToProject(s, id, dir)),
      moveToBundle: (id, to, from, copy) => io.commit((s) => send.moveSkillToBundle(s, id, to, from, copy)),
      toastError: io.toastError,
    });

    // User creates a new bundle "clowbot"
    io.commit((s) => {
      const next = core.createBundle(s, "clowbot");
      io.noteCreatedBundle(next.bundles.at(-1).id);
      return next;
    });
    await settle();
    expect(io.S.state.bundles.map((b) => b.id)).toEqual(["b", "clowbot"]);

    // User clicks on skill "alpha" (currently in bundle "b") to open the "Move alpha to..." menu
    send.openSendMenu("alpha", 20, 20, false, null, "b");
    const menu = globalThis.document.body.children[0];
    expect(menu).toBeDefined();
    const bundleItems = menu.querySelectorAll("button.sb-ctx-item").filter((el) => el.dataset.bid);
    expect(bundleItems.map((el) => el.dataset.bid)).toEqual(["clowbot", core.UNBUNDLED_ID]);

    // Clicking "clowbot" moves "alpha" from "b" to "clowbot"
    bundleItems[0].click();
    await settle();
    expect(io.S.state.bundles.find((b) => b.id === "b").skills).toEqual(["beta"]);
    expect(io.S.state.bundles.find((b) => b.id === "clowbot").skills).toEqual(["alpha"]);
    expect(core.parseBundles(read(core.BUNDLES_PATH)).bundles.find((b) => b.id === "clowbot").skills).toEqual(["alpha"]);

    // Alt-clicking "b" duplicates "alpha" back into "b" while keeping it in "clowbot"
    send.openSendMenu("alpha", 20, 20, false, null, "clowbot");
    const menu2 = globalThis.document.body.children[0];
    const bItem = menu2.querySelector('[data-bid="b"]');
    expect(bItem).toBeDefined();
    bItem.click({ altKey: true });
    await settle();
    expect(io.S.state.bundles.find((b) => b.id === "clowbot").skills).toEqual(["alpha"]);
    expect(io.S.state.bundles.find((b) => b.id === "b").skills).toEqual(["beta", "alpha"]);

    // If a new bundle is created while the menu is open, io.hooks.render -> refreshSendMenu updates the list automatically
    send.openSendMenu("beta", 20, 20, false, null, "b");
    const menu3 = globalThis.document.body.children[0];
    io.commit((s) => {
      const next = core.createBundle(s, "fresh");
      io.noteCreatedBundle(next.bundles.at(-1).id);
      return next;
    });
    await settle();
    const bids = menu3.querySelectorAll("button.sb-ctx-item").filter((el) => el.dataset.bid).map((el) => el.dataset.bid);
    expect(bids).toEqual(["fresh", "clowbot", core.UNBUNDLED_ID]);
  } finally {
    io.hooks.render = prevRender;
    send?.closeSendMenu();
    cleanupDom();
  }
});

test("orderBundles: session-created (newest first), then empty bundles, then non-empty in stored order", () => {
  const bundles = [
    { id: "n1", name: "N1", enabled: false, skills: ["alpha"] },
    { id: "e1", name: "E1", enabled: false, skills: [] },
    { id: "c1", name: "C1", enabled: false, skills: ["beta"] },
    { id: "n2", name: "N2", enabled: true, skills: ["alpha"] },
    { id: "e2", name: "E2", enabled: false, skills: [] },
    { id: "c2", name: "C2", enabled: false, skills: [] },
  ];
  io.noteCreatedBundle("c1");
  io.noteCreatedBundle("c2");
  const ordered = io.orderBundles(bundles).map((b) => b.id);
  expect(ordered.slice(0, 2)).toEqual(["c2", "c1"]);
  expect(new Set(ordered.slice(2, 4))).toEqual(new Set(["e1", "e2"]));
  expect(ordered.slice(4)).toEqual(["n1", "n2"]);
});

test("moveSkillToBundle and openSendMenu in All skills view (from === undefined)", async () => {
  const cleanupDom = installMenuDom();
  let send;
  try {
    const popup = await import("../panel/popup.ts");
    send = await import("../panel/send.ts");
    popup.initPopup(fx.host);
    popup.setHomeSource(() => io.S.home);
    send.initSend({
      host: fx.host,
      blockedReason: () => null,
      bundleBlockedReason: () => null,
      skillRef: (id) => io.S.skillRefs[id],
      enqueue: io.enqueue,
      markMoved: (id, dir) => io.applyChange((s) => core.markMovedToProject(s, id, dir)),
      moveToBundle: (id, to, from, copy) => io.commit((s) => send.moveSkillToBundle(s, id, to, from, copy)),
      toastError: io.toastError,
    });

    const base = core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [
        { id: "b1", name: "B1", enabled: false, skills: ["alpha", "beta"] },
        { id: "b2", name: "B2", enabled: false, skills: ["alpha"] },
        { id: "b3", name: "B3", enabled: false, skills: [] },
      ],
      overrides: {},
    }));

    // Direct moveSkillToBundle from All skills view: moves from all previous bundles into target
    const moved = send.moveSkillToBundle(base, "alpha", "b3", undefined, false);
    expect(moved.bundles.map((b) => [b.id, b.skills])).toEqual([
      ["b1", ["beta"]],
      ["b2", []],
      ["b3", ["alpha"]],
    ]);

    // Direct moveSkillToBundle with copy=true: adds to target while keeping existing memberships
    const copied = send.moveSkillToBundle(base, "alpha", "b3", undefined, true);
    expect(copied.bundles.map((b) => [b.id, b.skills])).toEqual([
      ["b1", ["alpha", "beta"]],
      ["b2", ["alpha"]],
      ["b3", ["alpha"]],
    ]);

    // Direct moveSkillToBundle to UNBUNDLED_ID: removes from all bundles
    const unbundled = send.moveSkillToBundle(base, "alpha", core.UNBUNDLED_ID, undefined, false);
    expect(unbundled.bundles.map((b) => [b.id, b.skills])).toEqual([
      ["b1", ["beta"]],
      ["b2", []],
      ["b3", []],
    ]);

    // Regression: moving a skill already in ["b", "c"] to "c" (copy=false, from=undefined) keeps it in "c" and removes it from "b"
    const alreadyInTarget = core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [
        { id: "b", name: "B", enabled: false, skills: ["alpha", "beta"] },
        { id: "c", name: "C", enabled: false, skills: ["alpha"] },
      ],
      overrides: {},
    }));
    const movedToExisting = send.moveSkillToBundle(alreadyInTarget, "alpha", "c", undefined, false);
    expect(movedToExisting.bundles.map((b) => [b.id, b.skills])).toEqual([
      ["b", ["beta"]],
      ["c", ["alpha"]],
    ]);

    // End-to-end via openSendMenu with from === undefined
    put(core.BUNDLES_PATH, core.serializeBundles(base));
    await io.load();

    // Move "alpha" (in b1 and b2) to b3
    send.openSendMenu("alpha", 20, 20, false);
    const menu1 = globalThis.document.body.children[0];
    menu1.querySelector('[data-bid="b3"]').click();
    await settle();
    expect(io.S.state.bundles.map((b) => [b.id, b.skills])).toEqual([
      ["b1", ["beta"]],
      ["b2", []],
      ["b3", ["alpha"]],
    ]);

    // Alt-click "b1" from All skills view duplicates "alpha" into b1 while keeping it in b3
    send.openSendMenu("alpha", 20, 20, false);
    const menu2 = globalThis.document.body.children[0];
    menu2.querySelector('[data-bid="b1"]').click({ altKey: true });
    await settle();
    expect(io.S.state.bundles.map((b) => [b.id, b.skills])).toEqual([
      ["b1", ["beta", "alpha"]],
      ["b2", []],
      ["b3", ["alpha"]],
    ]);

    // Move "alpha" (now in b1 and b3) to UNBUNDLED_ID from All skills view removes it from all bundles
    send.openSendMenu("alpha", 20, 20, false);
    const menu3 = globalThis.document.body.children[0];
    menu3.querySelector(`[data-bid="${core.UNBUNDLED_ID}"]`).click();
    await settle();
    expect(io.S.state.bundles.map((b) => [b.id, b.skills])).toEqual([
      ["b1", ["beta"]],
      ["b2", []],
      ["b3", []],
    ]);
  } finally {
    send?.closeSendMenu();
    cleanupDom();
  }
});

test("openSendMenu Unbundled item visibility and click removal", async () => {
  const cleanupDom = installMenuDom();
  let send;
  try {
    const popup = await import("../panel/popup.ts");
    send = await import("../panel/send.ts");
    popup.initPopup(fx.host);
    popup.setHomeSource(() => io.S.home);
    send.initSend({
      host: fx.host,
      blockedReason: () => null,
      bundleBlockedReason: () => null,
      skillRef: (id) => io.S.skillRefs[id],
      enqueue: io.enqueue,
      markMoved: (id, dir) => io.applyChange((s) => core.markMovedToProject(s, id, dir)),
      moveToBundle: (id, to, from, copy) => io.commit((s) => send.moveSkillToBundle(s, id, to, from, copy)),
      toastError: io.toastError,
    });

    // Shown when moving from a bundle (from = "b"), and pressing Alt hides Unbundled while keeping focus inside the menu
    send.openSendMenu("alpha", 20, 20, false, null, "b");
    const menuEl = globalThis.document.body.children[0];
    const unbEl = menuEl.querySelector(`[data-bid="${core.UNBUNDLED_ID}"]`);
    expect(unbEl).not.toBeNull();
    unbEl.focus();
    globalThis.document.dispatchKey("keydown", { key: "Alt" });
    expect(menuEl.querySelector(`[data-bid="${core.UNBUNDLED_ID}"]`)).toBeNull();
    expect(menuEl.contains(globalThis.document.activeElement)).toBe(true);
    globalThis.document.dispatchKey("keyup", { key: "Alt" });
    expect(menuEl.querySelector(`[data-bid="${core.UNBUNDLED_ID}"]`)).not.toBeNull();
    send.closeSendMenu();

    // Shown in All skills view (from === undefined) when skill is in at least one bundle
    send.openSendMenu("alpha", 20, 20, false);
    expect(globalThis.document.body.children[0].querySelector(`[data-bid="${core.UNBUNDLED_ID}"]`)).not.toBeNull();
    send.closeSendMenu();

    // Hidden when altAtOpen is true (duplicating)
    send.openSendMenu("alpha", 20, 20, true, null, "b");
    expect(globalThis.document.body.children[0].querySelector(`[data-bid="${core.UNBUNDLED_ID}"]`)).toBeNull();
    send.closeSendMenu();

    send.openSendMenu("alpha", 20, 20, true);
    expect(globalThis.document.body.children[0].querySelector(`[data-bid="${core.UNBUNDLED_ID}"]`)).toBeNull();
    send.closeSendMenu();

    // Clicking Unbundled removes the skill from the bundle
    send.openSendMenu("alpha", 20, 20, false, null, "b");
    globalThis.document.body.children[0].querySelector(`[data-bid="${core.UNBUNDLED_ID}"]`).click();
    await settle();
    expect(io.S.state.bundles.find((b) => b.id === "b").skills).toEqual(["beta"]);

    // Hidden when the skill is already unbundled (both from = UNBUNDLED_ID and from === undefined)
    send.openSendMenu("alpha", 20, 20, false, null, core.UNBUNDLED_ID);
    expect(globalThis.document.body.children[0].querySelector(`[data-bid="${core.UNBUNDLED_ID}"]`)).toBeNull();
    send.closeSendMenu();

    send.openSendMenu("alpha", 20, 20, false);
    expect(globalThis.document.body.children[0].querySelector(`[data-bid="${core.UNBUNDLED_ID}"]`)).toBeNull();
    send.closeSendMenu();
  } finally {
    send?.closeSendMenu();
    cleanupDom();
  }
});

test("openSendMenu filter input filters both bundles and projects", async () => {
  const cleanupDom = installMenuDom();
  let send;
  try {
    const popup = await import("../panel/popup.ts");
    send = await import("../panel/send.ts");
    fx.projects = [
      { id: "p1", name: "App Frontend", directory: `${home}/work/app-frontend` },
      { id: "p2", name: "Backend API", directory: `${home}/work/backend-api` },
      { id: "p3", name: "CLI Tool", directory: `${home}/work/cli-tool` },
      { id: "p4", name: "Docs Site", directory: `${home}/work/docs-site` },
      { id: "p5", name: "Alpha Sandbox", directory: `${home}/work/alpha-sandbox` },
    ];
    put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [
        { id: "b", name: "B", enabled: false, skills: ["alpha"] },
        { id: "frontend", name: "Frontend Kit", enabled: false, skills: [] },
        { id: "backend", name: "Backend Kit", enabled: false, skills: [] },
        { id: "infra", name: "Infra", enabled: false, skills: [] },
        { id: "writing", name: "Writing", enabled: false, skills: [] },
      ],
      overrides: {},
    }))));
    await io.load();

    popup.initPopup(fx.host);
    popup.setHomeSource(() => io.S.home);
    send.initSend({
      host: fx.host,
      blockedReason: () => null,
      bundleBlockedReason: () => null,
      skillRef: (id) => io.S.skillRefs[id],
      enqueue: io.enqueue,
      markMoved: (id, dir) => io.applyChange((s) => core.markMovedToProject(s, id, dir)),
      moveToBundle: (id, to, from, copy) => io.commit((s) => send.moveSkillToBundle(s, id, to, from, copy)),
      toastError: io.toastError,
    });

    send.openSendMenu("alpha", 20, 20, false, null, "b");
    await Promise.resolve(); // let listProjects() resolve and repaint
    const menu = globalThis.document.body.children[0];
    const filterInput = menu.querySelector(".sb-ctx-filter");
    expect(filterInput).not.toBeNull();

    // Filter matching both a bundle ("Frontend Kit") and a project ("App Frontend")
    filterInput.value = "frontend";
    filterInput.dispatch("input");
    const items = menu.querySelectorAll("button.sb-ctx-item");
    expect(items.filter((el) => el.dataset.bid).map((el) => el.dataset.bid)).toEqual(["frontend"]);
    expect(items.filter((el) => el.dataset.pid).map((el) => el.dataset.pid)).toEqual(["p1"]);

    // Filter matching only a bundle ("Writing")
    filterInput.value = "writing";
    filterInput.dispatch("input");
    const items2 = menu.querySelectorAll("button.sb-ctx-item");
    expect(items2.filter((el) => el.dataset.bid).map((el) => el.dataset.bid)).toEqual(["writing"]);
    expect(items2.filter((el) => el.dataset.pid)).toEqual([]);

    // Filter matching neither bundles nor projects
    filterInput.value = "zzzz-no-match";
    filterInput.dispatch("input");
    expect(menu.querySelectorAll("button.sb-ctx-item")).toEqual([]);
    expect(menu.querySelector(".sb-ctx-note")?.textContent).toBe("No matching bundles or projects");
  } finally {
    send?.closeSendMenu();
    cleanupDom();
  }
});

// ---------- cross-surface sync (panel/sync.ts + panel/io.ts + panel/compact.ts) ----------

test("syncFromDisk fast path updates S.state and fires render with zero SKILL.md reads", async () => {
  const skillReads = [];
  const h = fakeHost();
  const origRead = h.readFile;
  h.readFile = async (p) => {
    if (p.endsWith(".md")) skillReads.push(p);
    return origRead(p);
  };
  io.setHost(h);
  await io.load();
  skillReads.length = 0;

  let renders = 0;
  const prevRender = io.hooks.render;
  io.hooks.render = () => { renders++; prevRender(); };
  try {
    // External write duplicates "alpha" into a second bundle on disk
    const nextState = core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [
        { id: "b", name: "B", enabled: false, skills: ["alpha", "beta"] },
        { id: "b2", name: "B2", enabled: true, skills: ["alpha"] },
      ],
      overrides: {},
    }));
    put(core.BUNDLES_PATH, core.serializeBundles(nextState));

    expect(await io.syncFromDisk()).toBe(true);
    expect(renders).toBe(1);
    expect(skillReads).toEqual([]);
    expect(io.S.state.bundles.find((b) => b.id === "b2").skills).toEqual(["alpha"]);
  } finally {
    io.hooks.render = prevRender;
  }
});

test("syncFromDisk({ full: true }) refreshes beta's SKILL.md description", async () => {
  let renders = 0;
  const prevRender = io.hooks.render;
  io.hooks.render = () => { renders++; prevRender(); };
  try {
    put("~/.config/opencode/skills/beta/SKILL.md", skillMd("Beta updated on disk"));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(real("~/.config/opencode/skills/beta/SKILL.md"), future, future);
    expect(await io.syncFromDisk({ full: true })).toBe(true);
    expect(renders).toBe(1);
    expect(io.meta("beta").description).toBe("Beta updated on disk");
  } finally {
    io.hooks.render = prevRender;
  }
});

test("broadcastChange + listenChanges sends no skill IDs, coalesces bursts, and ignores self and malformed payloads", async () => {
  const sync = await import("../panel/sync.ts");
  const makeWin = () => {
    const listeners = new Set();
    const posted = [];
    return {
      parent: null,
      posted,
      addEventListener(t, fn) { if (t === "message") listeners.add(fn); },
      removeEventListener(t, fn) { if (t === "message") listeners.delete(fn); },
      postMessage(data) {
        posted.push(data);
        for (const fn of [...listeners]) fn({ data });
      },
    };
  };
  const winA = makeWin();
  const winB = makeWin();
  const parent = { frames: [winA, winB] };
  winA.parent = parent;
  winB.parent = parent;

  const receivedA = [];
  const receivedB = [];
  const offA = sync.listenChanges((opts) => receivedA.push(opts), winA);
  const offB = sync.listenChanges((opts) => receivedB.push(opts), winB);
  try {
    // Broadcast from winA posts to sibling winB (not winA), with zero skill names
    sync.broadcastChange({ full: true }, winA);
    expect(winA.posted).toEqual([]);
    expect(winB.posted.length).toBe(1);
    const msg = winB.posted[0];
    expect(msg.channel).toBe("skill-bundles.sync");
    expect(msg.v).toBe(1);
    expect(typeof msg.sender).toBe("string");
    expect(msg.full).toBe(true);
    expect("skills" in msg).toBe(false);

    // Self-messages (same sender as this module) are ignored by listenChanges
    winA.postMessage(msg);
    await Promise.resolve();
    expect(receivedA).toEqual([]);
    expect(receivedB).toEqual([]);

    // Burst of messages in the same microtask coalesces into one callback with full = OR
    winB.postMessage({ channel: "skill-bundles.sync", v: 1, sender: `${msg.sender}-other` });
    winB.postMessage({ channel: "skill-bundles.sync", v: 1, sender: `${msg.sender}-other`, full: true });
    winB.postMessage({ channel: "skill-bundles.sync", v: 1, sender: `${msg.sender}-other` });
    await Promise.resolve();
    expect(receivedB).toEqual([{ full: true }]);

    // Malformed / wrong-channel / wrong-version messages are ignored
    winB.postMessage(null);
    winB.postMessage("bad");
    winB.postMessage({ channel: "other", v: 1, sender: "x" });
    winB.postMessage({ channel: "skill-bundles.sync", v: 2, sender: "x" });
    winB.postMessage({ channel: "skill-bundles.sync", v: 1, sender: 123 });
    await Promise.resolve();
    expect(receivedB.length).toBe(1);

    // A non-full message delivers { full: false }
    winB.postMessage({ channel: "skill-bundles.sync", v: 1, sender: "other-frame" });
    await Promise.resolve();
    expect(receivedB[1]).toEqual({ full: false });
  } finally {
    offA();
    offB();
  }
});

test("checkDisk detects external edits, clears stale undoStack, and is a no-op when unchanged or after own commit", async () => {
  let reads = 0;
  let renders = 0;
  const h = fakeHost();
  const origRead = h.readFile;
  h.readFile = async (p) => { reads++; return origRead(p); };
  io.setHost(h);
  await io.load();

  const prevRender = io.hooks.render;
  io.hooks.render = () => { renders++; prevRender(); };
  try {
    // Perform an undoable commit in this frame
    io.commit((s) => core.setBundleEnabled(s, "b", true), undefined, { label: "enable b" });
    await settle();
    expect(io.canUndo()).toBe(true);
    reads = 0;
    renders = 0;

    // Immediately checking disk after own commit is a complete no-op
    expect(await io.checkDisk()).toBe(false);
    expect(reads).toBe(0);
    expect(renders).toBe(0);
    expect(io.canUndo()).toBe(true);

    // External CLI-style edit on disk (bump mtime & change content)
    const nextState = core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [{ id: "b", name: "B", enabled: false, skills: ["alpha"] }],
      overrides: {},
    }));
    put(core.BUNDLES_PATH, core.serializeBundles(nextState));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(real(core.BUNDLES_PATH), future, future);

    expect(await io.checkDisk()).toBe(true);
    expect(renders).toBe(1);
    expect(io.canUndo()).toBe(false);
    expect(io.S.state.bundles[0].skills).toEqual(["alpha"]);

    // Second checkDisk with no changes is again a 0-read, 0-render no-op
    reads = 0;
    renders = 0;
    expect(await io.checkDisk()).toBe(false);
    expect(reads).toBe(0);
    expect(renders).toBe(0);
  } finally {
    io.hooks.render = prevRender;
  }
});

test("syncFromDisk defers reading while lock is held and retries once released", async () => {
  const cliLock = JSON.stringify({ pid: 4242, host: "box", token: "cli-1", time: Date.now() });
  put(core.LOCK_PATH, cliLock);
  // Write a mid-transaction bundles change that shouldn't be read until lock releases
  const updated = core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [{ id: "b", name: "B", enabled: true, skills: ["alpha", "beta"] }],
    overrides: {},
  }));
  put(core.BUNDLES_PATH, core.serializeBundles(updated));

  let renders = 0;
  const prevRender = io.hooks.render;
  io.hooks.render = () => { renders++; prevRender(); };
  try {
    expect(await io.syncFromDisk()).toBe(false);
    expect(io.S.state.bundles[0].enabled).toBe(false);
    expect(renders).toBe(0);

    // Release the lock; bounded retry timer should pick up the new state
    put(core.LOCK_PATH, core.RELEASED_MARKER);
    await new Promise((r) => setTimeout(r, 40));
    expect(io.S.state.bundles[0].enabled).toBe(true);
    expect(renders).toBe(1);
  } finally {
    io.hooks.render = prevRender;
  }
});

test("compact renderCompact updates skill counts and open bundle list without stealing focus when unfocused", async () => {
  const cleanupDom = installMenuDom();
  const prevRender = io.hooks.render;
  const prevStyle = Object.getOwnPropertyDescriptor(globalThis, "HTMLStyleElement");
  try {
    // Start with 1 skill in bundle "b"
    put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [{ id: "b", name: "B", enabled: false, skills: ["alpha"] }],
      overrides: {},
    }))));
    await io.load();

    // Add querySelectorAll support for compact selectors on NodeEl
    const NodeProto = globalThis.HTMLElement.prototype;
    const origQsa = NodeProto.querySelectorAll;
    NodeProto.querySelectorAll = function (sel) {
      const out = origQsa.call(this, sel);
      if (out.length) return out;
      const walk = (n, pred) => {
        for (const c of n.children) {
          if (pred(c)) out.push(c);
          walk(c, pred);
        }
      };
      if (sel === ".sb-c-row") walk(this, (el) => el.classList.contains("sb-c-row"));
      else if (sel === ".sb-c-meta") walk(this, (el) => el.classList.contains("sb-c-meta"));
      else if (sel === ".sb-c-skill-id") walk(this, (el) => el.classList.contains("sb-c-skill-id"));
      else if (sel === ".sb-c-skill-desc") walk(this, (el) => el.classList.contains("sb-c-skill-desc"));
      else if (sel === "button, input, [tabindex]") walk(this, (el) => el.tag === "BUTTON" || el.tag === "INPUT" || "tabindex" in el.attrs);
      return out;
    };

    let focused = true;
    globalThis.HTMLStyleElement = class extends globalThis.HTMLElement {};
    globalThis.document.hasFocus = () => focused;
    globalThis.document.getElementById = () => null;
    globalThis.document.head = globalThis.document.createElement("head");
    globalThis.document.documentElement = globalThis.document.createElement("html");

    const compactMod = await import("../panel/compact.ts");
    const root = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(root);

    io.hooks.render = () => compactMod.renderCompact(root);
    compactMod.renderCompact(root);

    const row = root.querySelectorAll(".sb-c-row")[0];
    expect(root.querySelectorAll(".sb-c-meta")[0].textContent).toBe("1 skill");

    // Drill into bundle "b"
    row.click();
    expect(root.querySelectorAll(".sb-c-skill-id").map((e) => e.textContent)).toEqual(["alpha"]);
    expect(root.querySelectorAll(".sb-c-skill-desc").map((e) => e.textContent)).toEqual(["Alpha"]);

    // Simulate user working in another iframe (document.hasFocus() === false, activeElement elsewhere)
    const externalFocus = globalThis.document.createElement("button");
    let focusCalls = 0;
    const origFocus = NodeProto.focus;
    NodeProto.focus = function () {
      if (root.contains(this)) focusCalls++;
      return origFocus.call(this);
    };
    focused = false;
    externalFocus.focus();

    // Sync a second skill + updated description from disk
    put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [{ id: "b", name: "B", enabled: false, skills: ["alpha", "beta"] }],
      overrides: {},
    }))));
    put("~/.config/opencode/skills/beta/SKILL.md", skillMd("Beta fresh"));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(real("~/.config/opencode/skills/beta/SKILL.md"), future, future);
    expect(await io.syncFromDisk({ full: true })).toBe(true);

    // Open bundle preserved with updated count, skills, descriptions, and zero focus steals
    expect(root.querySelectorAll(".sb-c-meta")[0].textContent).toBe("2 skills · off");
    expect(root.querySelectorAll(".sb-c-skill-id").map((e) => e.textContent)).toEqual(["alpha", "beta"]);
    expect(root.querySelectorAll(".sb-c-skill-desc").map((e) => e.textContent)).toEqual(["Alpha", "Beta fresh"]);
    expect(focusCalls).toBe(0);
    expect(globalThis.document.activeElement).toBe(externalFocus);
    globalThis.document.dispatchKey("keydown", { key: "Escape" });
  } finally {
    if (prevStyle) Object.defineProperty(globalThis, "HTMLStyleElement", prevStyle);
    else delete globalThis.HTMLStyleElement;
    io.hooks.render = prevRender;
    cleanupDom();
  }
});

// ---------- undo stack (panel/io.ts) ----------

test("undo: tracks undoable commits with labels, reverts disk & state, and clears on load", async () => {
  expect(io.canUndo()).toBe(false);
  expect(io.undoLabel()).toBe(null);
  expect(await io.undo()).toBe(false);

  // First undoable change: enable bundle "b"
  io.commit((s) => core.setBundleEnabled(s, "b", true), undefined, { label: "toggle bundle" });
  await settle();
  expect(io.canUndo()).toBe(true);
  expect(io.undoLabel()).toBe("toggle bundle");
  expect(io.S.state.bundles[0].enabled).toBe(true);

  // Second undoable change: set override for alpha to "called"
  io.commit((s) => core.setOverride(s, "alpha", "called"), undefined, { label: "set mode" });
  await settle();
  expect(io.canUndo()).toBe(true);
  expect(io.undoLabel()).toBe("set mode");
  expect(io.S.state.overrides.alpha).toBe("called");
  expect(read("~/.config/opencode/skills/alpha/SKILL.md")).toContain("opencode/autoinvoke: false");

  // Undo second change -> back to enabled=true, no override
  expect(await io.undo()).toBe(true);
  expect(io.S.state.overrides.alpha).toBeUndefined();
  expect(io.S.state.bundles[0].enabled).toBe(true);
  expect(core.parseBundles(read(core.BUNDLES_PATH)).overrides.alpha).toBeUndefined();
  expect(read("~/.config/opencode/skills/alpha/SKILL.md")).not.toContain("autoinvoke: false");
  expect(io.canUndo()).toBe(true);
  expect(io.undoLabel()).toBe("toggle bundle");

  // Undo first change -> back to enabled=false
  expect(await io.undo()).toBe(true);
  expect(io.S.state.bundles[0].enabled).toBe(false);
  expect(core.parseBundles(read(core.BUNDLES_PATH)).bundles[0].enabled).toBe(false);
  expect(io.canUndo()).toBe(false);
  expect(io.undoLabel()).toBe(null);

  // load() clears undoStack
  io.commit((s) => core.setBundleEnabled(s, "b", true), undefined, { label: "toggle bundle" });
  await settle();
  expect(io.canUndo()).toBe(true);
  await io.load();
  expect(io.canUndo()).toBe(false);
  expect(io.undoLabel()).toBe(null);
});

test("undo: { undoable: 'clear' } clears prior undoStack (e.g. markMovedToProject) while preserving projectCopies and overrides", async () => {
  io.commit((s) => core.setBundleEnabled(s, "b", true), undefined, { label: "toggle bundle" });
  await settle();
  expect(io.canUndo()).toBe(true);
  expect(io.undoLabel()).toBe("toggle bundle");

  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.markMovedToProject(s, "alpha", "~/work/app"), { undoable: "clear" })).toBe(true);
  });
  await settle();
  expect(io.S.state.overrides.alpha).toBe("off");
  expect(io.S.state.projectCopies).toEqual({ alpha: ["~/work/app"] });
  expect(io.canUndo()).toBe(false);
  expect(io.undoLabel()).toBe(null);
});

test("undo: undoing addBundleProject cleans up <proj>/.opencode/opencode.json and managedProjects", async () => {
  fs.mkdirSync(real(PROJ), { recursive: true });
  io.commit((s) => core.addBundleProject(s, "b", PROJ), undefined, { label: "add project" });
  await settle();
  expect(io.S.state.managedProjects).toEqual([PROJ]);
  expect(JSON.parse(read(projFile)).permissions.filter((r) => r.action === "skill").map((r) => r.resource)).toEqual(["alpha", "beta"]);

  expect(await io.undo()).toBe(true);
  expect(io.S.state.managedProjects).toBeUndefined();
  expect(core.parseBundles(read(core.BUNDLES_PATH)).managedProjects).toBeUndefined();
  expect(JSON.parse(read(projFile)).permissions.filter((r) => r.action === "skill")).toEqual([]);
  expect(io.canUndo()).toBe(false);
});

test("undo: caps stack at 30 entries, drops oldest 5, and returns false when pending() > 0", async () => {
  for (let i = 0; i < 35; i++) {
    const on = i % 2 === 0;
    io.commit((s) => core.setBundleEnabled(s, "b", on), undefined, { label: `step ${i}` });
  }
  await settle();
  expect(io.canUndo()).toBe(true);
  expect(io.undoDepth()).toBe(30);
  expect(io.undoLabel()).toBe("step 34");

  // While a task is pending in the queue, undo() returns false immediately
  let release;
  const gate = new Promise((r) => { release = r; });
  const blocker = io.enqueue(async () => { await gate; });
  expect(await io.undo()).toBe(false);
  release();
  await blocker;

  // Pop all 30 entries (step 34 down to step 5; steps 0..4 were dropped)
  let count = 0;
  while (io.canUndo()) {
    expect(await io.undo()).toBe(true);
    count++;
  }
  expect(count).toBe(30);
  expect(io.canUndo()).toBe(false);
  // step 4 set enabled=true, so step 5's prev had enabled=true (whereas initial state before step 0 was false)
  expect(io.S.state.bundles[0].enabled).toBe(true);
});

test("undo: failed commit (RefusedError / LockedError) pushes nothing; failed undo() keeps entry", async () => {
  io.commit((s) => core.setBundleEnabled(s, "b", true), undefined, { label: "toggle bundle" });
  await settle();
  expect(io.undoDepth()).toBe(1);

  // RefusedError (incomplete discovery blocks 'called')
  io.S.incomplete = true;
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setOverride(s, "alpha", "called"), { label: "refused" })).toBe(false);
  });
  await settle();
  io.S.incomplete = false;
  expect(io.undoDepth()).toBe(1);
  expect(io.undoLabel()).toBe("toggle bundle");

  // LockedError (CLI lock held) on commit and on undo()
  const lock = JSON.stringify({ pid: 4242, host: "box", token: "t", time: Date.now() });
  put(core.LOCK_PATH, lock);
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setBundleEnabled(s, "b", false), { label: "locked" })).toBe(false);
  });
  await settle();
  expect(io.undoDepth()).toBe(1);
  expect(io.undoLabel()).toBe("toggle bundle");

  // Failed undo() keeps the entry on undoStack
  expect(await io.undo()).toBe(false);
  expect(io.canUndo()).toBe(true);
  expect(io.undoDepth()).toBe(1);
  expect(io.undoLabel()).toBe("toggle bundle");

  // Release lock and undo succeeds
  put(core.LOCK_PATH, core.RELEASED_MARKER);
  expect(await io.undo()).toBe(true);
  expect(io.canUndo()).toBe(false);
  expect(io.S.state.bundles[0].enabled).toBe(false);
});

test("undo: no-op state change does not push an undo entry", async () => {
  expect(io.canUndo()).toBe(false);
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.parseBundles(core.serializeBundles(s)), { label: "noop" })).toBe(true);
  });
  await settle();
  expect(io.canUndo()).toBe(false);
  expect(io.undoDepth()).toBe(0);
  expect(io.undoLabel()).toBe(null);
});

// ---------- review-astra regression tests ----------

test("1. torn snapshot between runSync reads and post-read stamp check does not poison lastDiskStamp", async () => {
  let armed = false;
  let injected = false;
  const h = fakeHost();
  const origRead = h.readFile;
  h.readFile = async (p) => {
    const res = await origRead(p);
    // Simulate a concurrent external write finishing right after bundlesText is read
    if (armed && !injected && p === core.BUNDLES_PATH) {
      injected = true;
      const next = core.parseBundles(JSON.stringify({
        version: 1,
        bundles: [{ id: "b", name: "B", enabled: true, skills: ["alpha", "beta"] }],
        overrides: {},
      }));
      put(core.BUNDLES_PATH, core.serializeBundles(next));
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(real(core.BUNDLES_PATH), future, future);
    }
    return res;
  };
  io.setHost(h);
  await io.load();
  armed = true;

  // The torn read must abort without mutating S.state or advancing lastDiskStamp
  expect(await io.syncFromDisk()).toBe(false);
  expect(injected).toBe(true);
  expect(io.S.state.bundles[0].enabled).toBe(false);

  // Subsequent checkDisk sees the un-poisoned stamp mismatch and converges to enabled: true
  expect(await io.checkDisk()).toBe(true);
  expect(io.S.state.bundles[0].enabled).toBe(true);
});

test("2. queued write waits for syncInFlight to commit fresh S.state and survives syncInFlight failure", async () => {
  // Part A: write queued while syncInFlight is mid-read waits and succeeds without StaleError
  let releaseRead;
  const readGate = new Promise((r) => { releaseRead = r; });
  const h = fakeHost();
  const origRead = h.readFile;
  let blockOnce = false;
  h.readFile = async (p) => {
    if (blockOnce && p === core.BUNDLES_PATH) {
      blockOnce = false;
      await readGate;
    }
    return origRead(p);
  };
  io.setHost(h);
  await io.load();
  blockOnce = true;

  // External write creates a second bundle b2 on disk
  const ext = core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [
      { id: "b", name: "B", enabled: false, skills: ["alpha", "beta"] },
      { id: "b2", name: "B2", enabled: true, skills: ["alpha"] },
    ],
    overrides: {},
  }));
  put(core.BUNDLES_PATH, core.serializeBundles(ext));

  const syncP = io.syncFromDisk();
  // Queue a write on bundle "b" while syncInFlight is paused mid-read
  io.commit((s) => core.setBundleEnabled(s, "b", true), undefined, { label: "enable b" });
  releaseRead();
  await syncP;
  await settle();

  expect(toasts.some((t) => t.kind === "error")).toBe(false);
  expect(io.S.state.bundles.find((b) => b.id === "b").enabled).toBe(true);
  expect(io.S.state.bundles.find((b) => b.id === "b2").enabled).toBe(true);

  // Part B: a failing syncInFlight does not cause a queued write to fail
  let failSyncRead = true;
  h.readFile = async (p) => {
    if (failSyncRead && p === core.OPENCODE_PATH) {
      failSyncRead = false;
      throw new HostRequestError("DENIED", "transient read error");
    }
    return origRead(p);
  };
  const failingSync = io.syncFromDisk();
  let writeRan = false;
  io.commit((s) => { writeRan = true; return core.setBundleEnabled(s, "b", false); });
  await expect(failingSync).rejects.toThrow("transient read error");
  await settle();
  expect(writeRan).toBe(true);
  expect(io.S.state.bundles.find((b) => b.id === "b").enabled).toBe(false);
});

test("toggleBundleInScope scopes to active project dir and falls back to global when null or chats dir", async () => {
  const projA = `${home}/work/proj-a`;
  const projB = `${home}/work/proj-b`;
  fs.mkdirSync(real(projA), { recursive: true });
  fs.mkdirSync(real(projB), { recursive: true });

  // Active project A: turning on adds projA to b.projects without turning global b.enabled on
  io.S.activeDir = projA;
  expect(io.activeProjectDir()).toBe("~/work/proj-a");
  io.toggleBundleInScope("b", true);
  await settle();
  expect(io.S.state.bundles[0].enabled).toBe(false);
  expect(io.S.state.bundles[0].projects).toEqual(["~/work/proj-a"]);
  expect(JSON.parse(read(`${projA}/.opencode/opencode.json`)).permissions.map((r) => r.resource)).toEqual(["alpha", "beta"]);
  expect(io.isBundleOnInScope(io.S.state.bundles[0])).toBe(true);

  // Switching activeDir to projB shows bundle OFF there
  io.S.activeDir = projB;
  expect(io.activeProjectDir()).toBe("~/work/proj-b");
  expect(io.isBundleOnInScope(io.S.state.bundles[0])).toBe(false);

  // Turning off in projA removes projA
  io.S.activeDir = projA;
  io.toggleBundleInScope("b", false);
  await settle();
  expect(io.S.state.bundles[0].projects).toBeUndefined();
  expect(JSON.parse(read(`${projA}/.opencode/opencode.json`)).permissions).toEqual([]);

  // Null or chats dir falls back to global setBundleGlobal (preserving overrides)
  io.commit((s) => core.setOverride(s, "alpha", "off"));
  await settle();
  io.S.activeDir = `${home}/.config/openchamber/chats/chat-1`;
  expect(io.activeProjectDir()).toBeNull();
  io.toggleBundleInScope("b", true);
  await settle();
  expect(io.S.state.bundles[0].enabled).toBe(true);
  expect(io.S.state.overrides.alpha).toBe("off");
});

test("compact rail: no hints, Alt/right-click opens projects menu, Disable pill toggles override, Alt+click skill opens send menu", async () => {
  const cleanupDom = installMenuDom();
  const prevRender = io.hooks.render;
  const prevStyle = Object.getOwnPropertyDescriptor(globalThis, "HTMLStyleElement");
  let popup, send, projects;
  try {
    const projA = `${home}/work/proj-a`;
    const projB = `${home}/work/proj-b`;
    fs.mkdirSync(real(projA), { recursive: true });
    fs.mkdirSync(real(projB), { recursive: true });
    fx.projects = [
      { id: "pa", name: "Proj A", directory: projA },
      { id: "pb", name: "Proj B", directory: projB },
    ];
    put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [
        { id: "b", name: "B", enabled: false, skills: ["alpha", "beta"], projects: [projA] },
        { id: "c", name: "C", enabled: false, skills: [] },
      ],
      overrides: {},
    }))));
    await io.load();
    io.S.activeDir = projA;

    const NodeProto = globalThis.HTMLElement.prototype;
    const origQsa = NodeProto.querySelectorAll;
    NodeProto.querySelectorAll = function (sel) {
      const out = origQsa.call(this, sel);
      if (out.length) return out;
      const walk = (n, pred) => {
        for (const c of n.children) {
          if (pred(c)) out.push(c);
          walk(c, pred);
        }
      };
      if (sel === ".sb-c-row") walk(this, (el) => el.classList.contains("sb-c-row"));
      else if (sel === ".sb-c-switch") walk(this, (el) => el.classList.contains("sb-c-switch"));
      else if (sel === ".sb-c-title") walk(this, (el) => el.classList.contains("sb-c-title"));
      else if (sel === ".sb-c-title-name") walk(this, (el) => el.classList.contains("sb-c-title-name"));
      else if (sel === ".sb-c-skill") walk(this, (el) => el.classList.contains("sb-c-skill"));
      else if (sel === ".sb-c-disable-pill") walk(this, (el) => el.classList.contains("sb-c-disable-pill"));
      else if (sel.startsWith('.sb-c-disable-pill[data-id="')) {
        const id = sel.slice('.sb-c-disable-pill[data-id="'.length, -2);
        walk(this, (el) => el.classList.contains("sb-c-disable-pill") && el.dataset.id === id);
      } else if (sel.startsWith('.sb-c-skill[data-id="')) {
        const id = sel.slice('.sb-c-skill[data-id="'.length, -2);
        walk(this, (el) => el.classList.contains("sb-c-skill") && el.dataset.id === id);
      }
      else if (sel === ".sb-c-meta") walk(this, (el) => el.classList.contains("sb-c-meta"));
      else if (sel === ".sb-c-hint") walk(this, (el) => el.classList.contains("sb-c-hint"));
      else if (sel === ".sb-c-busy") walk(this, (el) => el.classList.contains("sb-c-busy"));
      else if (sel === ".sb-c-tokens") walk(this, (el) => el.classList.contains("sb-c-tokens"));
      else if (sel === "input.sb-proj-check") walk(this, (el) => el.tag === "INPUT" && el.classList.contains("sb-proj-check"));
      else if (sel === "button, input, [tabindex]") walk(this, (el) => el.tag === "BUTTON" || el.tag === "INPUT" || "tabindex" in el.attrs);
      return out;
    };

    globalThis.HTMLStyleElement = class extends globalThis.HTMLElement {};
    globalThis.document.hasFocus = () => true;
    globalThis.document.getElementById = () => null;
    globalThis.document.head = globalThis.document.createElement("head");
    globalThis.document.documentElement = globalThis.document.createElement("html");

    popup = await import("../panel/popup.ts");
    send = await import("../panel/send.ts");
    projects = await import("../panel/projects.ts");
    const compactMod = await import("../panel/compact.ts");

    popup.initPopup(fx.host);
    popup.setHomeSource(() => io.S.home);
    send.initSend({
      host: fx.host,
      blockedReason: () => null,
      bundleBlockedReason: () => null,
      skillRef: (id) => io.S.skillRefs[id],
      enqueue: io.enqueue,
      markMoved: (id, dir) => io.applyChange((s) => core.markMovedToProject(s, id, dir)),
      moveToBundle: (id, to, from, copy) => io.commit((s) => send.moveSkillToBundle(s, id, to, from, copy)),
      toastError: io.toastError,
    });

    const root = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(root);
    io.hooks.render = () => {
      compactMod.renderCompact(root);
      projects.refreshProjectsMenu();
      send.refreshSendMenu();
    };
    compactMod.renderCompact(root);

    // No footer hint in bundle list view
    const byClass = (node, name) => {
      if (node.classList.contains(name)) return node;
      for (const child of node.children) {
        const found = byClass(child, name);
        if (found) return found;
      }
      return null;
    };
    globalThis.document.querySelector = (sel) => sel === ".sb-c-head .sb-c-header" ? byClass(root, "sb-c-header") : null;
    const textTree = (node) => node.textContent + node.children.map(textTree).join("");
    const checkBusy = async () => {
      expect(byClass(root, "sb-c-header").children.at(-1)).toBe(byClass(root, "sb-c-tokens"));
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const blocker = io.enqueue(() => gate);
      try {
        compactMod.renderCompactBusy();
        compactMod.renderCompactBusy();
        expect(root.querySelectorAll(".sb-c-busy")).toHaveLength(1);
        expect(textTree(byClass(root, "sb-c-busy"))).toBe("Saving…");
        expect(byClass(root, "sb-c-header").children.at(-1)).toBe(byClass(root, "sb-c-tokens"));
        compactMod.renderCompact(root);
        expect(root.querySelectorAll(".sb-c-busy")).toHaveLength(1);
        expect(byClass(root, "sb-c-header").children.at(-1)).toBe(byClass(root, "sb-c-tokens"));
      } finally {
        release();
        await blocker;
      }
    };
    expect(byClass(root, "sb-title")).toBeNull();
    expect(byClass(root, "sb-c-back")).toBeNull();
    const listStats = byClass(root, "sb-c-counts").textContent;
    expect(listStats).toMatch(/^\d+ \/ \d+$/);
    expect(byClass(root, "sb-c-tokens").textContent).toMatch(/^~[\d.]+k? tokens$/);
    expect(textTree(byClass(root, "sb-c-header"))).not.toMatch(/installed|bundles on/);
    await checkBusy();
    expect(root.querySelectorAll(".sb-c-hint")).toEqual([]);
    const rowB = root.querySelectorAll(".sb-c-row")[0];
    expect(rowB.classList.contains("on")).toBe(true);

    // Alt + click on bundle row opens Projects menu (with Global row + current project first) without drilling in
    rowB.click({ altKey: true });
    await Promise.resolve();
    const projMenu = globalThis.document.body.children.find((c) => c.classList.contains("sb-proj"));
    expect(projMenu).toBeDefined();
    expect(root.querySelectorAll(".sb-c-skill")).toEqual([]);
    const checks = projMenu.querySelectorAll("input.sb-proj-check");
    expect(checks.map((c) => c.dataset.dir)).toEqual(["__global", projA, projB]);
    expect(checks[0].checked).toBe(false);
    expect(checks[1].checked).toBe(true);
    const itemsBox = projMenu.children.find((c) => c.classList.contains("sb-ctx-items"));
    expect(itemsBox.children.every((c) => c.classList.contains("sb-proj-row"))).toBe(true);
    const footBox = projMenu.children.find((c) => c.classList.contains("sb-ctx-foot"));
    expect(footBox.children).toEqual([]);
    expect(footBox.textContent).toBe("");
    popup.closePopup();

    // Right-click on bundle row also opens Projects menu without drilling in
    rowB.dispatch("contextmenu", { clientX: 20, clientY: 20 });
    expect(globalThis.document.body.children.some((c) => c.classList.contains("sb-proj"))).toBe(true);
    expect(root.querySelectorAll(".sb-c-skill")).toEqual([]);
    popup.closePopup();

    // Clicking switch does not open Projects menu or drill in
    const sw = rowB.querySelectorAll(".sb-c-switch")[0];
    sw.click({ altKey: true });
    expect(globalThis.document.body.children.some((c) => c.classList.contains("sb-proj"))).toBe(false);
    expect(root.querySelectorAll(".sb-c-skill")).toEqual([]);

    // Plain click drills into bundle "b"
    rowB.click();
    expect(byClass(root, "sb-title")).toBeNull();
    expect(byClass(root, "sb-c-back-bar")).toBeNull();
    expect(byClass(root, "sb-c-back").textContent).toBe("Go Back");
    expect(byClass(root, "sb-c-counts").textContent).toBe(listStats);
    expect(byClass(root, "sb-c-header").children[0]).toBe(byClass(root, "sb-c-back"));
    expect(textTree(byClass(root, "sb-c-header"))).not.toMatch(/installed|bundles on/);
    await checkBusy();
    expect(root.textContent).not.toContain("All bundles");
    expect(root.querySelectorAll(".sb-c-hint")).toEqual([]);
    const pills = root.querySelectorAll(".sb-c-disable-pill");
    expect(pills.map((p) => p.textContent)).toEqual(["Disable", "Disable"]);

    // Clicking Disable pill disables "alpha", removes it from projA opencode.json, and shows "Disabled"
    pills[0].click();
    await settle();
    expect(io.S.state.overrides.alpha).toBe("off");
    expect(JSON.parse(read(`${projA}/.opencode/opencode.json`)).permissions.map((r) => r.resource)).toEqual(["beta"]);
    expect(root.querySelectorAll(".sb-c-disable-pill").map((p) => p.textContent)).toEqual(["Disabled", "Disable"]);

    // Preserved across bundle toggle (off then on in projA)
    io.toggleBundleInScope("b", false);
    await settle();
    io.toggleBundleInScope("b", true);
    await settle();
    expect(io.S.state.overrides.alpha).toBe("off");
    expect(root.querySelectorAll(".sb-c-disable-pill").map((p) => p.textContent)).toEqual(["Disabled", "Disable"]);

    // Clicking Disabled pill re-enables "alpha" and restores it to projA opencode.json
    root.querySelectorAll(".sb-c-disable-pill")[0].click();
    await settle();
    expect(io.S.state.overrides.alpha).toBeUndefined();
    expect(JSON.parse(read(`${projA}/.opencode/opencode.json`)).permissions.map((r) => r.resource)).toEqual(["alpha", "beta"]);
    expect(root.querySelectorAll(".sb-c-disable-pill").map((p) => p.textContent)).toEqual(["Disable", "Disable"]);

    // Alt + click on skill row opens Send menu; releasing Alt before clicking item moves (not duplicates)
    const skillAlpha = root.querySelectorAll(".sb-c-skill")[0];
    skillAlpha.click({ altKey: true });
    const sendMenu = globalThis.document.body.children.find((c) => c.classList.contains("sb-ctx") && !c.classList.contains("sb-proj"));
    expect(sendMenu).toBeDefined();
    // Simulate pointer click after Alt was released outside the iframe (e.altKey === false)
    sendMenu.querySelector('[data-bid="c"]').click({ altKey: false });
    await settle();
    expect(io.S.state.bundles.find((b) => b.id === "b").skills).toEqual(["beta"]);
    expect(io.S.state.bundles.find((b) => b.id === "c").skills).toEqual(["alpha"]);

    // Focus restoration on Disable/Disabled pill button + inner <button> of .sb-c-switch + Alt+Enter on open header
    const backBtn = root.querySelectorAll("button, input, [tabindex]").find((e) => e.classList.contains("sb-c-back"));
    backBtn.click();
    expect(byClass(root, "sb-title")).toBeNull();
    expect(byClass(root, "sb-c-counts")).not.toBeNull();
    expect(byClass(root, "sb-c-back")).toBeNull();
    expect(globalThis.document.activeElement).toBe(root.querySelectorAll(".sb-c-row")[0]);
    const rowC = root.querySelectorAll(".sb-c-row")[1];
    rowC.click();
    const pillA = root.querySelectorAll(".sb-c-disable-pill")[0];
    pillA.focus();
    pillA.click();
    await settle();
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
    expect(globalThis.document.activeElement).toBe(root.querySelectorAll(".sb-c-disable-pill")[0]);

    // Clicking inner <button> of .sb-c-switch toggles bundle "c" in projA without opening projects menu
    const innerSwBtn = root.querySelectorAll(".sb-c-title .sb-c-switch button").length
      ? root.querySelectorAll(".sb-c-title .sb-c-switch button")[0]
      : root.querySelectorAll("button, input, [tabindex]").find((e) => e.closest(".sb-c-switch") && e.closest(".sb-c-title"));
    expect(innerSwBtn).toBeDefined();
    innerSwBtn.click();
    await settle();
    expect(io.S.state.bundles.find((b) => b.id === "c").projects).toEqual(["~/work/proj-a"]);
    expect(globalThis.document.body.children.some((c) => c.classList.contains("sb-proj"))).toBe(false);

    // Keyboard Alt+Enter on open bundle header opens Projects menu and closing restores focus to header
    const header = root.querySelectorAll(".sb-c-title-name")[0];
    expect(header).toBeDefined();
    header.focus();
    header.dispatch("keydown", { key: "Enter", altKey: true });
    expect(globalThis.document.body.children.some((c) => c.classList.contains("sb-proj"))).toBe(true);
    popup.closePopup();
    expect(globalThis.document.activeElement).toBe(header);
    globalThis.document.dispatchKey("keydown", { key: "Escape" });
    expect(byClass(root, "sb-c-back")).toBeNull();
    expect(globalThis.document.activeElement).toBe(root.querySelectorAll(".sb-c-row")[1]);
  } finally {
    popup?.closePopup();
    if (prevStyle) Object.defineProperty(globalThis, "HTMLStyleElement", prevStyle);
    else delete globalThis.HTMLStyleElement;
    io.hooks.render = prevRender;
    cleanupDom();
  }
});

test("regression: global bundle toggled off in Project A excludes only Project A, stays on in Project B, and restores on toggle ON", async () => {
  const projA = `${home}/work/proj-a`;
  const projB = `${home}/work/proj-b`;
  fs.mkdirSync(real(projA), { recursive: true });
  fs.mkdirSync(real(projB), { recursive: true });
  put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [{ id: "b", name: "B", enabled: true, skills: ["alpha", "beta"] }],
    overrides: {},
  }))));
  await io.load();

  io.S.activeDir = projA;
  io.toggleBundleInScope("b", false);
  await settle();
  expect(io.S.state.bundles[0].enabled).toBe(true);
  expect(io.S.state.bundles[0].excludedProjects).toEqual(["~/work/proj-a"]);
  expect(io.isBundleOnInScope(io.S.state.bundles[0])).toBe(false);
  expect(JSON.parse(read(`${projA}/.opencode/opencode.json`)).permissions).toEqual([
    { action: "skill", resource: "alpha", effect: "deny" },
    { action: "skill", resource: "beta", effect: "deny" },
  ]);

  io.S.activeDir = projB;
  expect(io.isBundleOnInScope(io.S.state.bundles[0])).toBe(true);

  io.S.activeDir = projA;
  io.toggleBundleInScope("b", true);
  await settle();
  expect(io.S.state.bundles[0].enabled).toBe(true);
  expect(io.S.state.bundles[0].excludedProjects).toBeUndefined();
  expect(JSON.parse(read(`${projA}/.opencode/opencode.json`)).permissions).toEqual([]);
});

test("regression: toggleBundleInScope captures project scope at invocation time even if activeDir changes before queue runs", async () => {
  const projA = `${home}/work/proj-a`;
  const projB = `${home}/work/proj-b`;
  fs.mkdirSync(real(projA), { recursive: true });
  fs.mkdirSync(real(projB), { recursive: true });

  let release;
  const gate = new Promise((r) => { release = r; });
  void io.enqueue(async () => { await gate; });

  io.S.activeDir = projA;
  io.toggleBundleInScope("b", true);
  // User switches activeDir before the queued write executes
  io.S.activeDir = projB;
  release();
  await settle();

  expect(io.S.state.bundles[0].projects).toEqual(["~/work/proj-a"]);
  expect(io.S.state.bundles[0].enabled).toBe(false);
});

test("regression: sameProjectDir works when S.home is undefined, and readCounts derives nonstandard home from listProjects", async () => {
  io.S.home = undefined;
  io.S.activeDir = "/home/u/work/a";
  expect(io.sameProjectDir("/home/u/work/a", "~/work/a")).toBe(true);

  const countsMod = await import("../status/counts.ts");
  const { homeFromDirs } = await import("../shared/panel/projects.ts");
  expect(homeFromDirs(["/srv/users/u/.config/openchamber/chats/c1", "/srv/users/u/work/app"])).toBe("/srv/users/u");
  const countsFx = createFakeHost({
    makeError: (code, msg) => new HostRequestError(code, msg),
  });
  const srvHome = countsFx.home;
  const proj = `${srvHome}/work/app`;
  try {
    countsFx.put("~/.config/opencode/opencode.json", '{"permissions":[]}\n');
    countsFx.put("~/.config/opencode/skills/alpha/SKILL.md", skillMd("Alpha"));
    countsFx.put(`${proj}/.opencode/opencode.json`, JSON.stringify({ permissions: [{ action: "skill", resource: "alpha", effect: "allow" }] }) + "\n");
    countsFx.put("~/.config/opencode/skill-bundles.json", core.serializeBundles(core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [{ id: "b", name: "B", enabled: false, skills: ["alpha"], projects: ["~/work/app"] }],
      overrides: {},
    }))));
    const derived = homeFromDirs([`${srvHome}/.config/openchamber/chats/c1`, proj]);
    expect(derived).toBe(srvHome);
    const res = await countsMod.readCounts(countsFx.host, { projectDir: proj, home: derived });
    expect(res.bundlesOn).toEqual(["b"]);
    expect(res.live).toBe(1);
  } finally {
    countsFx.cleanup();
  }
});

test("regression: checkDisk detects external edits to managed project opencode.json", async () => {
  const projA = `${home}/work/proj-a`;
  fs.mkdirSync(real(projA), { recursive: true });
  io.S.activeDir = projA;
  io.toggleBundleInScope("b", true);
  await settle();

  let syncs = 0;
  const prevSync = io.hooks.onExternalSync;
  io.hooks.onExternalSync = () => { syncs++; prevSync(); };
  try {
    expect(await io.checkDisk()).toBe(false);
    const pPath = `${projA}/.opencode/opencode.json`;
    put(pPath, JSON.stringify({ permissions: [] }, null, 2) + "\n");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(real(pPath), future, future);

    expect(await io.checkDisk()).toBe(true);
    expect(syncs).toBe(1);
  } finally {
    io.hooks.onExternalSync = prevSync;
  }
});

test("regression: openSendMenu preserves Copy mode across Overwrite confirmation and supports keyboard Alt activation", async () => {
  const cleanupDom = installMenuDom();
  let send;
  try {
    const projA = `${home}/work/proj-a`;
    fs.mkdirSync(real(projA), { recursive: true });
    put(`${projA}/.opencode/skills/alpha/SKILL.md`, skillMd("Old Alpha"));
    fx.projects = [{ id: "pa", name: "Proj A", directory: projA }];
    put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [{ id: "b", name: "B", enabled: true, skills: ["alpha"] }],
      overrides: {},
    }))));
    await io.load();

    const popup = await import("../panel/popup.ts");
    send = await import("../panel/send.ts");
    popup.initPopup(fx.host);
    popup.setHomeSource(() => io.S.home);
    send.initSend({
      host: fx.host,
      blockedReason: () => null,
      bundleBlockedReason: () => null,
      skillRef: (id) => io.S.skillRefs[id],
      enqueue: io.enqueue,
      markMoved: (id, dir) => io.applyChange((s) => core.markMovedToProject(s, id, dir)),
      moveToBundle: (id, to, from, copy) => io.commit((s) => send.moveSkillToBundle(s, id, to, from, copy)),
      toastError: io.toastError,
    });

    // Alt-click project -> Overwrite prompt -> release Alt -> click Overwrite: must Copy (not markMoved)
    send.openSendMenu("alpha", 20, 20, true, null, "b");
    await Promise.resolve();
    const menu1 = globalThis.document.body.children.find((c) => c.classList.contains("sb-ctx"));
    menu1.querySelector('[data-pid="pa"]').click({ altKey: true, detail: 1 });
    await new Promise((r) => setTimeout(r, 15));
    const overwriteBtn = menu1.querySelector('[data-confirm="yes"]');
    expect(overwriteBtn).toBeDefined();
    overwriteBtn.click({ altKey: false, detail: 1 });
    await settle();
    expect(io.S.state.overrides.alpha).toBeUndefined();
    expect(read(`${projA}/.opencode/skills/alpha/SKILL.md`)).toBe(skillMd("Alpha"));

    // Keyboard activation (detail: 0) with Alt held duplicates into another bundle
    put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [
        { id: "b", name: "B", enabled: false, skills: ["alpha"] },
        { id: "c", name: "C", enabled: false, skills: [] },
      ],
      overrides: {},
    }))));
    await io.load();
    send.openSendMenu("alpha", 20, 20, false, null, "b");
    const menu2 = globalThis.document.body.children.find((c) => c.classList.contains("sb-ctx"));
    globalThis.document.dispatchKey("keydown", { key: "Alt" });
    menu2.querySelector('[data-bid="c"]').dispatch("click", { altKey: false, detail: 0 });
    await settle();
    expect(io.S.state.bundles.find((b) => b.id === "b").skills).toEqual(["alpha"]);
    expect(io.S.state.bundles.find((b) => b.id === "c").skills).toEqual(["alpha"]);
  } finally {
    send?.closeSendMenu();
    cleanupDom();
  }
});

test("3. full:true hitting a held lock preserves full:true across a later full:false ping", async () => {
  const cliLock = JSON.stringify({ pid: 4242, host: "box", token: "cli-1", time: Date.now() });
  put(core.LOCK_PATH, cliLock);
  put("~/.config/opencode/skills/beta/SKILL.md", skillMd("Beta updated under lock"));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(real("~/.config/opencode/skills/beta/SKILL.md"), future, future);

  expect(await io.syncFromDisk({ full: true })).toBe(false);
  expect(io.meta("beta").description).toBe("Beta");

  // Release lock and immediately send a non-full ping before retry timer fires
  put(core.LOCK_PATH, core.RELEASED_MARKER);
  expect(await io.syncFromDisk({ full: false })).toBe(true);
  expect(io.meta("beta").description).toBe("Beta updated under lock");
});

test("4. >256 skills modified on disk: full sync refreshes all 260 descriptions without truncation", async () => {
  const ids = Array.from({ length: 260 }, (_, i) => `sk${String(i).padStart(3, "0")}`);
  for (const id of ids) put(`~/.config/opencode/skills/${id}/SKILL.md`, skillMd(`v1-${id}`));
  await io.load();
  expect(io.S.allIds.length).toBeGreaterThanOrEqual(260);

  const future = new Date(Date.now() + 5000);
  for (const id of ids) {
    const p = `~/.config/opencode/skills/${id}/SKILL.md`;
    put(p, skillMd(`v2-${id}`));
    fs.utimesSync(real(p), future, future);
  }
  expect(await io.syncFromDisk({ full: true })).toBe(true);
  for (const id of ids) {
    expect(io.meta(id).description).toBe(`v2-${id}`);
  }
});

test("5. Work Status refresher coalesces mid-flight sync ping into an immediate follow-up readCounts", async () => {
  let calls = 0;
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  const painted = [];
  const refresh = counts.createStatusRefresher(
    async () => {
      calls++;
      if (calls === 1) {
        await firstGate;
        return { live: 1, installed: 4, chars: 180, bundlesOn: ["b"], fromOpencode: false };
      }
      return { live: 3, installed: 4, chars: 540, bundlesOn: ["b"], fromOpencode: false };
    },
    (c) => painted.push(c.live),
    () => {},
  );

  const p1 = refresh();
  // Ping arrives while first readCounts is still in flight
  const p2 = refresh();
  releaseFirst();
  await Promise.all([p1, p2]);
  expect(calls).toBe(2);
  expect(painted).toEqual([1, 3]);
});

test("6. active Page editing (detail textarea / rename) preserves draft on external sync and broadcastChange leaks no skill names", async () => {
  const sync = await import("../panel/sync.ts");
  const cleanupDom = installMenuDom();
  const prevExternal = io.hooks.onExternalSync;
  const prevStyle = Object.getOwnPropertyDescriptor(globalThis, "HTMLStyleElement");
  try {
    globalThis.HTMLStyleElement = class extends globalThis.HTMLElement {};
    globalThis.document.hasFocus = () => true;
    globalThis.document.getElementById = (id) => (id === "detail" ? detailEl : null);
    globalThis.document.head = globalThis.document.createElement("head");
    globalThis.document.documentElement = globalThis.document.createElement("html");
    const detailEl = globalThis.document.createElement("div");
    detailEl.id = "detail";
    globalThis.document.body.appendChild(detailEl);

    // Verify broadcastChange never includes skill names
    const posted = [];
    const winA = { parent: null };
    const winB = { postMessage: (d) => posted.push(d) };
    winA.parent = { frames: [winA, winB] };
    sync.broadcastChange({ full: true }, winA);
    expect(posted).toEqual([{ channel: "skill-bundles.sync", v: 1, sender: posted[0].sender, full: true }]);
    expect(JSON.stringify(posted)).not.toContain("alpha");

    // Simulate active textarea editing in #detail with S.descDraft set
    const ta = globalThis.document.createElement("textarea");
    detailEl.appendChild(ta);
    ta.focus();
    io.S.descDraft = { id: "alpha", value: "User typing draft" };

    // External sync updates bundle state; onExternalSync defers DOM rebuild while textarea is focused,
    // and flushes once focus leaves
    let deferredRenders = 0;
    let blurAttached = false;
    io.hooks.onExternalSync = () => {
      if (globalThis.document.activeElement === ta) {
        if (!blurAttached) {
          blurAttached = true;
          globalThis.document.addEventListener("focusout", () => {
            blurAttached = false;
            deferredRenders++;
          });
        }
        return;
      }
      deferredRenders++;
    };

    const next = core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [{ id: "b", name: "B", enabled: true, skills: ["alpha", "beta"] }],
      overrides: {},
    }));
    put(core.BUNDLES_PATH, core.serializeBundles(next));
    expect(await io.syncFromDisk()).toBe(true);
    expect(deferredRenders).toBe(0);
    expect(io.S.descDraft).toEqual({ id: "alpha", value: "User typing draft" });
    expect(globalThis.document.activeElement).toBe(ta);

    // Blur flushes the deferred render
    globalThis.document.dispatchKey("focusout");
    expect(deferredRenders).toBe(1);
  } finally {
    if (prevStyle) Object.defineProperty(globalThis, "HTMLStyleElement", prevStyle);
    else delete globalThis.HTMLStyleElement;
    io.hooks.onExternalSync = prevExternal;
    cleanupDom();
  }
});

test("7. checkDisk detects direct SKILL.md edits and custom opencode.json skill roots without config/lock changes", async () => {
  // Direct edit to existing SKILL.md without touching bundles/opencode/lock
  put("~/.config/opencode/skills/alpha/SKILL.md", skillMd("Alpha direct edit"));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(real("~/.config/opencode/skills/alpha/SKILL.md"), future, future);
  expect(await io.checkDisk()).toBe(true);
  expect(io.meta("alpha").description).toBe("Alpha direct edit");

  // Even after an unrelated fast-path bundle sync, a direct SKILL.md edit is NOT masked
  const next = core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [{ id: "b", name: "B", enabled: true, skills: ["alpha", "beta"] }],
    overrides: {},
  }));
  put(core.BUNDLES_PATH, core.serializeBundles(next));
  fs.utimesSync(real(core.BUNDLES_PATH), future, future);
  expect(await io.syncFromDisk({ full: false })).toBe(true);

  put("~/.config/opencode/skills/beta/SKILL.md", skillMd("Beta direct edit after fast sync"));
  const future2 = new Date(Date.now() + 10000);
  fs.utimesSync(real("~/.config/opencode/skills/beta/SKILL.md"), future2, future2);
  expect(await io.checkDisk()).toBe(true);
  expect(io.meta("beta").description).toBe("Beta direct edit after fast sync");

  // Custom root in opencode.json skills array
  put(core.OPENCODE_PATH, JSON.stringify({ $schema: "x", skills: ["~/extra-root"], permissions: [] }, null, 2) + "\n");
  fs.utimesSync(real(core.OPENCODE_PATH), future2, future2);
  await io.load();
  put("~/extra-root/custom-one/SKILL.md", skillMd("From extra root"));
  fs.utimesSync(real("~/extra-root"), future2, future2);
  expect(await io.checkDisk()).toBe(true);
  expect(io.S.allIds).toContain("custom-one");
  expect(io.meta("custom-one").description).toBe("From extra root");
});

test("8. undo() revalidates undoStack after syncInFlight and aborts when external bundle edit cleared it", async () => {
  // Pause syncFromDisk mid-read while an external bundle is added on disk
  let releaseRead;
  const readGate = new Promise((r) => { releaseRead = r; });
  const h = fakeHost();
  const origRead = h.readFile;
  let blockOnce = false;
  h.readFile = async (p) => {
    if (blockOnce && p === core.BUNDLES_PATH) {
      blockOnce = false;
      await readGate;
    }
    return origRead(p);
  };
  io.setHost(h);
  await io.load();
  // Create an undoable commit
  io.commit((s) => core.setBundleEnabled(s, "b", true), undefined, { label: "enable b" });
  await settle();
  expect(io.canUndo()).toBe(true);

  const ext = core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [
      { id: "b", name: "B", enabled: true, skills: ["alpha", "beta"] },
      { id: "ext", name: "Ext", enabled: false, skills: ["alpha"] },
    ],
    overrides: {},
  }));
  put(core.BUNDLES_PATH, core.serializeBundles(ext));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(real(core.BUNDLES_PATH), future, future);

  blockOnce = true;
  const syncP = io.syncFromDisk();
  // Queue undo() while syncInFlight is active
  const undoP = io.undo();
  releaseRead();
  await syncP;
  expect(await undoP).toBe(false);
  expect(io.S.state.bundles.map((b) => b.id)).toEqual(["b", "ext"]);
  expect(core.parseBundles(read(core.BUNDLES_PATH)).bundles.map((b) => b.id)).toEqual(["b", "ext"]);
});

test("9. saveDescription does not mask external BUNDLES_PATH edits and root-changing sync does not swallow concurrent bundle edits", async () => {
  // (a) External BUNDLES_PATH edit while saveDescription runs
  const ext = core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [
      { id: "b", name: "B", enabled: false, skills: ["alpha", "beta"] },
      { id: "ext2", name: "Ext2", enabled: true, skills: ["beta"] },
    ],
    overrides: {},
  }));
  put(core.BUNDLES_PATH, core.serializeBundles(ext));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(real(core.BUNDLES_PATH), future, future);

  io.saveDescription("alpha", "Alpha desc while bundles edited");
  await settle();
  await settle();
  expect(read("~/.config/opencode/skills/alpha/SKILL.md")).toContain("description: Alpha desc while bundles edited");
  // checkDisk must still see the external BUNDLES_PATH change
  expect(await io.checkDisk()).toBe(true);
  expect(io.S.state.bundles.map((b) => b.id)).toEqual(["b", "ext2"]);

  // (b) Full sync where opencode.json changed AND a concurrent write modifies BUNDLES_PATH during root discovery
  let injected = false;
  const h = fakeHost();
  const origListDir = h.listDir;
  h.listDir = async (p) => {
    const res = await origListDir(p);
    if (!injected && p === "~/new-root") {
      injected = true;
      const newer = core.parseBundles(JSON.stringify({
        version: 1,
        bundles: [
          { id: "b", name: "B", enabled: false, skills: ["alpha", "beta"] },
          { id: "ext3", name: "Ext3", enabled: true, skills: ["alpha"] },
        ],
        overrides: {},
      }));
      put(core.BUNDLES_PATH, core.serializeBundles(newer));
      const future2 = new Date(Date.now() + 10000);
      fs.utimesSync(real(core.BUNDLES_PATH), future2, future2);
    }
    return res;
  };
  io.setHost(h);
  await io.load();

  put("~/new-root/n1/SKILL.md", skillMd("New root skill"));
  put(core.OPENCODE_PATH, JSON.stringify({ $schema: "x", skills: ["~/new-root"], permissions: [] }, null, 2) + "\n");
  fs.utimesSync(real(core.OPENCODE_PATH), future, future);

  // Sync detects the torn snapshot and returns false without poisoning lastDiskStamp
  expect(await io.syncFromDisk({ full: true })).toBe(false);
  expect(injected).toBe(true);
  // Subsequent checkDisk sees both the new root and ext3
  expect(await io.checkDisk()).toBe(true);
  expect(io.S.state.bundles.map((b) => b.id)).toEqual(["b", "ext3"]);
  expect(io.S.allIds).toContain("n1");
});

test("10. createEditGuard stays armed across rename->textarea focus transitions and flushes when leaving all editing controls", async () => {
  const { createEditGuard } = await import("../panel/edit-guard.ts");
  const cleanupDom = installMenuDom();
  try {
    const renameInput = globalThis.document.createElement("input");
    const detailTextarea = globalThis.document.createElement("textarea");
    const outsideButton = globalThis.document.createElement("button");
    globalThis.document.body.append(renameInput, detailTextarea, outsideButton);

    let defers = 0;
    let renders = 0;
    const guard = createEditGuard({
      isEditing: () => globalThis.document.activeElement === renameInput || globalThis.document.activeElement === detailTextarea,
      isTargetDeleted: () => false,
      onDefer: () => { defers++; },
      onRender: () => { renders++; },
    });

    // Focus rename input and trigger external sync -> deferred
    renameInput.focus();
    guard.onExternalSync();
    expect(defers).toBe(1);
    expect(renders).toBe(0);
    expect(guard.isPending()).toBe(true);

    // Move focus directly from rename input into detail textarea -> still editing, so no render yet
    detailTextarea.focus();
    globalThis.document.dispatchKey("focusout");
    await Promise.resolve();
    expect(renders).toBe(0);
    expect(guard.isPending()).toBe(true);

    // Move focus outside all editing controls -> flushes render once
    outsideButton.focus();
    globalThis.document.dispatchKey("focusout");
    await Promise.resolve();
    expect(renders).toBe(1);
    expect(guard.isPending()).toBe(false);
    guard.dispose();
  } finally {
    cleanupDom();
  }
});

test("11. createStatusRefresher recovers on dirty retry when first read rejects", async () => {
  let calls = 0;
  let rejectFirst;
  const firstGate = new Promise((_r, rej) => { rejectFirst = rej; });
  const painted = [];
  const errors = [];
  const refresh = counts.createStatusRefresher(
    async () => {
      calls++;
      if (calls === 1) return firstGate;
      return { live: 2, installed: 4, chars: 360, bundlesOn: ["b"], fromOpencode: false };
    },
    (c) => painted.push(c.live),
    (e) => errors.push(e.message),
  );

  const p1 = refresh();
  // Concurrent ping marks dirty while first read is pending
  const p2 = refresh();
  rejectFirst(new Error("transient read failure"));
  await Promise.all([p1, p2]);
  expect(calls).toBe(2);
  expect(errors).toEqual(["transient read failure"]);
  expect(painted).toEqual([2]);
});

test("12. load() validates before/after stamps so mid-load SKILL.md edits are caught by checkDisk", async () => {
  let editedMidLoad = false;
  const h = fakeHost();
  const origRead = h.readFile;
  h.readFile = async (p) => {
    const res = await origRead(p);
    if (!editedMidLoad && p === "~/.config/opencode/skills/alpha/SKILL.md") {
      editedMidLoad = true;
      put(p, skillMd("Alpha edited mid-load"));
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(real(p), future, future);
    }
    return res;
  };
  io.setHost(h);
  await io.load();
  expect(editedMidLoad).toBe(true);
  expect(io.meta("alpha").description).toBe("Alpha");

  // Because load() detected the mid-load stamp change, checkDisk() must return true and reconcile
  expect(await io.checkDisk()).toBe(true);
  expect(io.meta("alpha").description).toBe("Alpha edited mid-load");
});

test("13. createEditGuard preserves Save button click across pointerdown -> focusout -> pointerup -> click", async () => {
  const { createEditGuard } = await import("../panel/edit-guard.ts");
  const cleanupDom = installMenuDom();
  try {
    const renameInput = globalThis.document.createElement("input");
    const saveBtn = globalThis.document.createElement("button");
    globalThis.document.body.append(renameInput, saveBtn);

    let renders = 0;
    let saveClicks = 0;
    saveBtn.addEventListener("click", () => {
      if (saveBtn.isConnected) saveClicks++;
    });

    const guard = createEditGuard({
      isEditing: () => globalThis.document.activeElement === renameInput,
      isTargetDeleted: () => false,
      onDefer: () => {},
      onRender: () => {
        renders++;
        saveBtn.remove(); // simulate DOM rebuild replacing Save button
      },
    });

    renameInput.focus();
    guard.onExternalSync();
    expect(guard.isPending()).toBe(true);

    // 1. pointerdown on Save -> focusout on input + focus leaves input
    globalThis.document.dispatchKey("pointerdown");
    saveBtn.focus();
    globalThis.document.dispatchKey("focusout");

    // 2. Microtasks drain: Save button must still be connected and no render yet
    await Promise.resolve();
    expect(renders).toBe(0);
    expect(saveBtn.isConnected).toBe(true);

    // 3. pointerup + click on Save
    globalThis.document.dispatchKey("pointerup");
    saveBtn.click();
    globalThis.document.dispatchKey("click");
    expect(saveClicks).toBe(1);

    // 4. Macrotask timer drains: deferred render flushes cleanly after click
    await new Promise((r) => setTimeout(r, 10));
    expect(renders).toBe(1);
    expect(guard.isPending()).toBe(false);
    guard.dispose();
  } finally {
    cleanupDom();
  }
});

test("14. createEditGuard defers sync arriving mid-press between pointerdown and pointerup/click", async () => {
  const { createEditGuard } = await import("../panel/edit-guard.ts");
  const cleanupDom = installMenuDom();
  try {
    const renameInput = globalThis.document.createElement("input");
    const saveBtn = globalThis.document.createElement("button");
    globalThis.document.body.append(renameInput, saveBtn);

    let renders = 0;
    let saveClicks = 0;
    saveBtn.addEventListener("click", () => {
      if (saveBtn.isConnected) saveClicks++;
    });

    const guard = createEditGuard({
      isEditing: () => globalThis.document.activeElement === renameInput,
      isTargetDeleted: () => false,
      onDefer: () => {},
      onRender: () => {
        renders++;
        saveBtn.remove();
      },
    });

    // Case A: deferred sync -> pointerdown -> focusout -> SECOND onExternalSync mid-press -> pointerup -> click
    renameInput.focus();
    guard.onExternalSync();
    expect(guard.isPending()).toBe(true);

    globalThis.document.dispatchKey("pointerdown");
    saveBtn.focus();
    globalThis.document.dispatchKey("focusout");
    guard.onExternalSync(); // second sync arrives while pointerActive is true and input already blurred
    await Promise.resolve();
    expect(renders).toBe(0);
    expect(saveBtn.isConnected).toBe(true);

    globalThis.document.dispatchKey("pointerup");
    saveBtn.click();
    globalThis.document.dispatchKey("click");
    expect(saveClicks).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(renders).toBe(1);
    expect(guard.isPending()).toBe(false);

    // Case B: FIRST onExternalSync arrives between pointerdown (after blur) and pointerup -> click
    globalThis.document.body.appendChild(saveBtn);
    renders = 0;
    saveClicks = 0;
    renameInput.focus();
    globalThis.document.dispatchKey("pointerdown");
    saveBtn.focus();
    globalThis.document.dispatchKey("focusout");
    guard.onExternalSync(); // first sync ever arrives mid-press
    expect(guard.isPending()).toBe(true);
    await Promise.resolve();
    expect(renders).toBe(0);
    expect(saveBtn.isConnected).toBe(true);

    globalThis.document.dispatchKey("pointerup");
    saveBtn.click();
    globalThis.document.dispatchKey("click");
    expect(saveClicks).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(renders).toBe(1);
    expect(guard.isPending()).toBe(false);

    guard.dispose();
  } finally {
    cleanupDom();
  }
});

test("regression: unreadable project opencode.json does not break load, checkDisk, readCounts, or unrelated saves", async () => {
  const lockedProj = `${home}/work/locked-proj`;
  const otherProj = `${home}/work/other-proj`;
  fs.mkdirSync(real(lockedProj), { recursive: true });
  fs.mkdirSync(real(otherProj), { recursive: true });
  put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [
      { id: "b", name: "B", enabled: false, skills: ["alpha"], projects: [lockedProj] },
      { id: "c", name: "C", enabled: false, skills: ["beta"] },
    ],
    overrides: {},
  }))));

  const h = fakeHost();
  const origRead = h.readFile;
  h.readFile = async (p) => {
    if (p.includes("locked-proj") && p.endsWith(".opencode/opencode.json")) {
      throw new HostRequestError("DENIED", "permission denied");
    }
    return origRead(p);
  };
  io.setHost(h);
  await io.load();
  expect(io.S.loaded).toBe(true);
  expect(await io.checkDisk()).toBe(false);

  const res = await counts.readCounts(h, { projectDir: lockedProj, home });
  expect(res.bundlesOn).toEqual(["b"]);
  expect(res.live).toBe(1);

  // Unrelated bundle toggle still succeeds
  io.S.activeDir = otherProj;
  io.toggleBundleInScope("c", true);
  await settle();
  expect(io.S.state.bundles.find((b) => b.id === "c").projects).toEqual(["~/work/other-proj"]);
});

test("regression: external project opencode.json deny * drops rail meter and readCounts live count to 0", async () => {
  const cleanupDom = installMenuDom();
  const prevStyle = Object.getOwnPropertyDescriptor(globalThis, "HTMLStyleElement");
  try {
    const proj = `${home}/work/proj-a`;
    fs.mkdirSync(real(proj), { recursive: true });
    put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [{ id: "b", name: "B", enabled: false, skills: ["alpha", "beta"], projects: [proj] }],
      overrides: {},
    }))));
    await io.load();
    io.S.activeDir = proj;

    const NodeProto = globalThis.HTMLElement.prototype;
    const origQsa = NodeProto.querySelectorAll;
    NodeProto.querySelectorAll = function (sel) {
      const out = origQsa.call(this, sel);
      if (out.length) return out;
      const walk = (n, pred) => {
        for (const c of n.children) {
          if (pred(c)) out.push(c);
          walk(c, pred);
        }
      };
      if ([".sb-c-counts", ".sb-c-tokens", ".sb-c-header", ".sb-title", ".skm-meter"].includes(sel)) walk(this, (el) => el.classList.contains(sel.slice(1)));
      return out;
    };
    globalThis.HTMLStyleElement = class extends globalThis.HTMLElement {};
    globalThis.document.hasFocus = () => true;
    globalThis.document.getElementById = () => null;
    globalThis.document.head = globalThis.document.createElement("head");
    globalThis.document.documentElement = globalThis.document.createElement("html");

    const compactMod = await import("../panel/compact.ts");
    const root = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(root);

    // Externally overwrite <proj>/.opencode/opencode.json to deny *
    const pFile = `${proj}/.opencode/opencode.json`;
    put(pFile, JSON.stringify({ permissions: [{ action: "skill", resource: "*", effect: "deny" }] }, null, 2) + "\n");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(real(pFile), future, future);

    expect(await io.checkDisk()).toBe(true);
    const normProj = io.activeProjectDir();
    const projCfg = core.projectConfigPath(normProj);
    expect(counts.countsFromState(io.S.state, io.S.allIds, io.S.opencodeText, {
      projectDir: proj,
      home: io.effectiveHome(),
      projectOpencodeText: io.S.projectTexts[projCfg],
    }).live).toBe(0);
    expect((await counts.readCounts(fx.host, { projectDir: proj, home })).live).toBe(0);

    compactMod.renderCompact(root);
    expect(root.querySelectorAll(".sb-title")).toEqual([]);
    expect(root.querySelectorAll(".sb-c-counts")[0].textContent).toBe(`0 / ${io.S.allIds.length}`);
    expect(root.querySelectorAll(".sb-c-tokens")[0].textContent).toBe("~0 tokens");
    expect(root.querySelectorAll(".skm-meter")).toHaveLength(0);
    expect(root.querySelectorAll(".sb-c-counts")[0].title).toBe(`0 of ${io.S.allIds.length} skills live`);
    expect(root.querySelectorAll(".sb-c-counts")[0].attrs["aria-label"]).toBe(`0 of ${io.S.allIds.length} skills live`);
    expect(root.querySelectorAll(".sb-c-tokens")[0].title).toBe(counts.TOKENS_TITLE);

    // Without bundles, keep the same header and count the active project's permissions.
    io.S.state = null;
    compactMod.renderCompact(root);
    const fallback = counts.countsFromState(null, io.S.allIds, io.S.opencodeText, {
      projectDir: proj,
      home: io.effectiveHome(),
      projectOpencodeText: io.S.projectTexts[projCfg],
    });
    expect(fallback.live).toBe(0);
    expect(root.querySelectorAll(".sb-title")).toEqual([]);
    expect(root.querySelectorAll(".sb-c-header")).toHaveLength(1);
    expect(root.querySelectorAll(".sb-c-counts")[0].textContent).toBe(`${fallback.live} / ${fallback.installed}`);
    expect(root.querySelectorAll(".sb-c-tokens")[0].textContent).toBe(`~${counts.formatTokens(counts.tokensOf(fallback.chars))} tokens`);
    expect(root.querySelectorAll(".skm-meter")).toHaveLength(0);
  } finally {
    if (prevStyle) Object.defineProperty(globalThis, "HTMLStyleElement", prevStyle);
    else delete globalThis.HTMLStyleElement;
    cleanupDom();
  }
});

test("regression: compact renderCompact uses effectiveHome() when S.home is undefined", async () => {
  const cleanupDom = installMenuDom();
  const prevStyle = Object.getOwnPropertyDescriptor(globalThis, "HTMLStyleElement");
  try {
    put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [{ id: "b", name: "B", enabled: false, skills: ["alpha", "beta"], projects: ["/home/u/work/a"] }],
      overrides: {},
    }))));
    await io.load();
    io.S.home = undefined;
    io.S.activeDir = "/home/u/work/a";

    const NodeProto = globalThis.HTMLElement.prototype;
    const origQsa = NodeProto.querySelectorAll;
    NodeProto.querySelectorAll = function (sel) {
      const out = origQsa.call(this, sel);
      if (out.length) return out;
      const walk = (n, pred) => {
        for (const c of n.children) {
          if (pred(c)) out.push(c);
          walk(c, pred);
        }
      };
      if (sel === ".sb-c-row") walk(this, (el) => el.classList.contains("sb-c-row"));
      else if ([".sb-c-counts", ".sb-c-tokens", ".sb-title", ".skm-meter"].includes(sel)) walk(this, (el) => el.classList.contains(sel.slice(1)));
      return out;
    };
    globalThis.HTMLStyleElement = class extends globalThis.HTMLElement {};
    globalThis.document.hasFocus = () => true;
    globalThis.document.getElementById = () => null;
    globalThis.document.head = globalThis.document.createElement("head");
    globalThis.document.documentElement = globalThis.document.createElement("html");

    const compactMod = await import("../panel/compact.ts");
    const root = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(root);
    compactMod.renderCompact(root);

    expect(root.querySelectorAll(".sb-c-row")[0].classList.contains("on")).toBe(true);
    expect(root.querySelectorAll(".sb-title")).toEqual([]);
    expect(root.querySelectorAll(".sb-c-counts")[0].textContent).toMatch(/^[1-9]\d* \/ \d+$/);
    expect(root.querySelectorAll(".sb-c-tokens")[0].textContent).toMatch(/^~[\d.]+k? tokens$/);
    expect(root.querySelectorAll(".skm-meter")).toHaveLength(0);
  } finally {
    if (prevStyle) Object.defineProperty(globalThis, "HTMLStyleElement", prevStyle);
    else delete globalThis.HTMLStyleElement;
    cleanupDom();
  }
});

test("regression: disabling overlapping global bundle refuses with toast when excluded project file is unreadable", async () => {
  const proj = `${home}/work/proj-a`;
  fs.mkdirSync(real(proj), { recursive: true });
  put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [
      { id: "g", name: "G", enabled: true, skills: ["alpha"], excludedProjects: [proj] },
      { id: "h", name: "H", enabled: true, skills: ["alpha"] },
    ],
    overrides: {},
  }))));

  const h = fakeHost();
  const origRead = h.readFile;
  h.readFile = async (p) => {
    if (p.includes("proj-a") && p.endsWith(".opencode/opencode.json")) {
      throw new HostRequestError("DENIED", "permission denied");
    }
    return origRead(p);
  };
  io.setHost(h);
  await io.load();

  let ok;
  await io.enqueue(async () => {
    ok = await io.applyChange((s) => core.setBundleGlobal(s, "h", false));
  });
  await settle();
  expect(ok).toBe(false);
  expect(toasts.some((t) => t.kind === "error" && /permission denied|Saving failed/i.test(t.message))).toBe(true);
  expect(io.S.state.bundles.find((b) => b.id === "h").enabled).toBe(true);
});

test("regression: save() does not poison configStamps for unassigned activeDir project file edited before save", async () => {
  const proj = `${home}/work/proj-a`;
  fs.mkdirSync(real(proj), { recursive: true });
  put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [{ id: "b", name: "B", enabled: true, skills: ["alpha", "beta"] }],
    overrides: {},
  }))));
  await io.load();
  io.S.activeDir = proj;

  // Externally deny * in unassigned activeDir's project opencode.json
  const pFile = `${proj}/.opencode/opencode.json`;
  put(pFile, JSON.stringify({ permissions: [{ action: "skill", resource: "*", effect: "deny" }] }, null, 2) + "\n");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(real(pFile), future, future);

  // Rename bundle b (triggers save() which does NOT read unassigned proj)
  io.commit((s) => core.renameBundle(s, "b", "B Renamed"));
  await settle();

  // checkDisk() must still detect the external edit to proj/.opencode/opencode.json
  expect(await io.checkDisk()).toBe(true);
  const normProj = io.activeProjectDir();
  const projCfg = core.projectConfigPath(normProj);
  expect(counts.countsFromState(io.S.state, io.S.allIds, io.S.opencodeText, {
    projectDir: proj,
    home: io.effectiveHome(),
    projectOpencodeText: io.S.projectTexts[projCfg],
  }).live).toBe(0);
});

test("regression: missing or empty {} project opencode.json reports 0 live for project-only bundle", async () => {
  const cleanupDom = installMenuDom();
  const prevStyle = Object.getOwnPropertyDescriptor(globalThis, "HTMLStyleElement");
  try {
    const proj = `${home}/work/proj-a`;
    fs.mkdirSync(real(proj), { recursive: true });
    put(core.BUNDLES_PATH, core.serializeBundles(core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [{ id: "b", name: "B", enabled: false, skills: ["alpha", "beta"] }],
      overrides: {},
    }))));
    await io.load();
    io.S.activeDir = proj;

    const NodeProto = globalThis.HTMLElement.prototype;
    const origQsa = NodeProto.querySelectorAll;
    NodeProto.querySelectorAll = function (sel) {
      const out = origQsa.call(this, sel);
      if (out.length) return out;
      const walk = (n, pred) => {
        for (const c of n.children) {
          if (pred(c)) out.push(c);
          walk(c, pred);
        }
      };
      if ([".sb-c-counts", ".sb-title", ".skm-meter"].includes(sel)) walk(this, (el) => el.classList.contains(sel.slice(1)));
      return out;
    };
    globalThis.HTMLStyleElement = class extends globalThis.HTMLElement {};
    globalThis.document.hasFocus = () => true;
    globalThis.document.getElementById = () => null;
    globalThis.document.head = globalThis.document.createElement("head");
    globalThis.document.documentElement = globalThis.document.createElement("html");

    const compactMod = await import("../panel/compact.ts");
    const root = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(root);

    // Enable project-only bundle b in proj (live = 2)
    io.toggleBundleInScope("b", true);
    await settle();
    expect((await counts.readCounts(fx.host, { projectDir: proj, home })).live).toBe(2);

    // Externally delete <proj>/.opencode/opencode.json -> 0 live
    const pFile = `${proj}/.opencode/opencode.json`;
    fs.unlinkSync(real(pFile));
    expect(await io.checkDisk()).toBe(true);
    expect((await counts.readCounts(fx.host, { projectDir: proj, home })).live).toBe(0);
    compactMod.renderCompact(root);
    expect(root.querySelectorAll(".sb-title")).toEqual([]);
    expect(root.querySelectorAll(".sb-c-counts")[0].textContent).toBe(`0 / ${io.S.allIds.length}`);
    expect(root.querySelectorAll(".skm-meter")).toHaveLength(0);

    // Externally write '{}' -> 0 live
    put(pFile, "{}\n");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(real(pFile), future, future);
    expect(await io.checkDisk()).toBe(true);
    expect((await counts.readCounts(fx.host, { projectDir: proj, home })).live).toBe(0);
    compactMod.renderCompact(root);
    expect(root.querySelectorAll(".sb-c-counts")[0].textContent).toBe(`0 / ${io.S.allIds.length}`);
  } finally {
    if (prevStyle) Object.defineProperty(globalThis, "HTMLStyleElement", prevStyle);
    else delete globalThis.HTMLStyleElement;
    cleanupDom();
  }
});

test("checkDisk uses fast path (0 listDir calls) on external skill-bundles.json edit and full path on direct SKILL.md edit", async () => {
  let listDirCalls = 0;
  const h = fakeHost();
  const origListDir = h.listDir;
  h.listDir = async (p) => {
    listDirCalls++;
    return origListDir(p);
  };
  io.setHost(h);
  await io.load();
  listDirCalls = 0;

  // External skill-bundles.json edit only -> fast path with 0 listDir calls
  const next = core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [{ id: "b", name: "B", enabled: true, skills: ["alpha", "beta"] }],
    overrides: {},
  }));
  put(core.BUNDLES_PATH, core.serializeBundles(next));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(real(core.BUNDLES_PATH), future, future);

  expect(await io.checkDisk()).toBe(true);
  expect(listDirCalls).toBe(0);
  expect(io.S.state.bundles[0].enabled).toBe(true);

  // Direct SKILL.md edit -> full path (walks skill roots) and updates meta(id).description
  put("~/.config/opencode/skills/alpha/SKILL.md", skillMd("Alpha updated via SKILL.md"));
  const future2 = new Date(Date.now() + 10000);
  fs.utimesSync(real("~/.config/opencode/skills/alpha/SKILL.md"), future2, future2);

  expect(await io.checkDisk()).toBe(true);
  expect(listDirCalls).toBeGreaterThan(0);
  expect(io.meta("alpha").description).toBe("Alpha updated via SKILL.md");
});

test("malformed skill-bundles.json during checkDisk warns once and does not retry infinitely on unchanged checkDisk", async () => {
  let reads = 0;
  let warns = 0;
  const h = fakeHost();
  const origRead = h.readFile;
  h.readFile = async (p) => {
    reads++;
    return origRead(p);
  };
  io.setHost(h);
  await io.load();

  const origWarn = console.warn;
  console.warn = (...args) => {
    if (String(args[0] ?? "").includes("failed to parse skill-bundles.json")) warns++;
  };
  try {
    put(core.BUNDLES_PATH, "{ invalid json\n");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(real(core.BUNDLES_PATH), future, future);

    reads = 0;
    expect(await io.checkDisk()).toBe(false);
    expect(warns).toBe(1);
    expect(reads).toBeGreaterThan(0);
    // Existing S.state remains intact
    expect(io.S.state.bundles[0].id).toBe("b");

    // Subsequent unchanged checkDisk() does not re-read files or warn again
    reads = 0;
    expect(await io.checkDisk()).toBe(false);
    expect(reads).toBe(0);
    expect(warns).toBe(1);

    // Once fixed on disk, checkDisk() recovers cleanly
    const fixed = core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [{ id: "b", name: "B", enabled: true, skills: ["alpha"] }],
      overrides: {},
    }));
    put(core.BUNDLES_PATH, core.serializeBundles(fixed));
    const future2 = new Date(Date.now() + 10000);
    fs.utimesSync(real(core.BUNDLES_PATH), future2, future2);
    expect(await io.checkDisk()).toBe(true);
    expect(io.S.state.bundles[0].enabled).toBe(true);
    expect(io.S.state.bundles[0].skills).toEqual(["alpha"]);
  } finally {
    console.warn = origWarn;
  }
});

// ---------- simplify-code regression & efficiency tests ----------

test("core scope primitives: normalizeScopeDir, sameProjectDir, isBundleActive, and setBundleInScope", () => {
  const hOpt = { home: "/home/me" };

  // normalizeScopeDir rejects empty, chats dirs, "~", "/", relative paths, and ".."; canonicalizes valid project paths
  expect(core.normalizeScopeDir(null, hOpt)).toBeNull();
  expect(core.normalizeScopeDir(undefined, hOpt)).toBeNull();
  expect(core.normalizeScopeDir("", hOpt)).toBeNull();
  expect(core.normalizeScopeDir("~/.config/openchamber/chats/2026-01-01/s1", hOpt)).toBeNull();
  expect(core.normalizeScopeDir("/home/me/.config/openchamber/chats/s1", hOpt)).toBeNull();
  expect(core.normalizeScopeDir("~", hOpt)).toBeNull();
  expect(core.normalizeScopeDir("/home/me", hOpt)).toBeNull();
  expect(core.normalizeScopeDir("/", hOpt)).toBeNull();
  expect(core.normalizeScopeDir("relative/path", hOpt)).toBeNull();
  expect(core.normalizeScopeDir("work/app", hOpt)).toBeNull();
  expect(core.normalizeScopeDir("~/work/../escape", hOpt)).toBeNull();
  expect(core.normalizeScopeDir("~/work/app/", hOpt)).toBe("~/work/app");
  expect(core.normalizeScopeDir("/home/me/work/app", hOpt)).toBe("~/work/app");
  expect(core.normalizeScopeDir("/srv/work/app/", hOpt)).toBe("/srv/work/app");

  // sameProjectDir matches "~/..." and absolute path under home, and falls back safely on invalid paths
  expect(core.sameProjectDir("~/work/app/", "/home/me/work/app", hOpt)).toBe(true);
  expect(core.sameProjectDir("/home/me/work/app", "/home/me/work/other", hOpt)).toBe(false);
  expect(core.sameProjectDir("relative/a", "relative/a", hOpt)).toBe(true);
  expect(core.sameProjectDir("relative/a", "relative/b", hOpt)).toBe(false);

  // Global scope toggles via setBundleGlobal, preserving per-skill 'off' overrides
  let st = core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [{ id: "b", name: "B", enabled: false, skills: ["alpha", "beta"] }],
    overrides: { alpha: "off" },
  }), hOpt);
  expect(core.isBundleActive(st.bundles[0], { projectDir: null, ...hOpt })).toBe(false);
  expect(core.isBundleActive(st.bundles[0], { projectDir: "~/.config/openchamber/chats/c1", ...hOpt })).toBe(false);

  st = core.setBundleInScope(st, "b", true, { projectDir: null, ...hOpt });
  expect(st.bundles[0].enabled).toBe(true);
  expect(st.overrides.alpha).toBe("off");
  expect(core.isBundleActive(st.bundles[0], { projectDir: null, ...hOpt })).toBe(true);

  // Project scope on an enabled bundle: turning off adds excludedProjects and clears any explicit projects entry
  st = core.addBundleProject(st, "b", "/home/me/work/app", hOpt);
  expect(st.bundles[0].projects).toEqual(["~/work/app"]);
  st = core.setBundleInScope(st, "b", false, { projectDir: "/home/me/work/app/", ...hOpt });
  expect(st.bundles[0].enabled).toBe(true);
  expect(st.bundles[0].projects).toBeUndefined();
  expect(st.bundles[0].excludedProjects).toEqual(["~/work/app"]);
  expect(core.isBundleActive(st.bundles[0], { projectDir: "~/work/app", ...hOpt })).toBe(false);
  expect(core.isBundleActive(st.bundles[0], { projectDir: "~/work/other", ...hOpt })).toBe(true);

  // Turning back on in project scope clears excludedProjects via includeBundleProject without redundant projects entry
  st = core.setBundleInScope(st, "b", true, { projectDir: "/home/me/work/app", ...hOpt });
  expect(st.bundles[0].enabled).toBe(true);
  expect(st.bundles[0].excludedProjects).toBeUndefined();
  expect(st.bundles[0].projects).toBeUndefined();
  expect(core.isBundleActive(st.bundles[0], { projectDir: "~/work/app", ...hOpt })).toBe(true);

  // Global off clears excludedProjects; disabled bundle toggles on/off in a project via projects
  st = core.setBundleInScope(st, "b", false, { projectDir: "~/work/app", ...hOpt });
  expect(st.bundles[0].excludedProjects).toEqual(["~/work/app"]);
  st = core.setBundleInScope(st, "b", false, { projectDir: null, ...hOpt });
  expect(st.bundles[0].enabled).toBe(false);
  expect(st.bundles[0].excludedProjects).toBeUndefined();
  expect(st.overrides.alpha).toBe("off");

  st = core.setBundleInScope(st, "b", true, { projectDir: "/home/me/work/app/", ...hOpt });
  expect(st.bundles[0].enabled).toBe(false);
  expect(st.bundles[0].projects).toEqual(["~/work/app"]);
  expect(core.isBundleActive(st.bundles[0], { projectDir: "/home/me/work/app", ...hOpt })).toBe(true);
  expect(core.isBundleActive(st.bundles[0], { projectDir: "/home/me/work/other", ...hOpt })).toBe(false);

  st = core.setBundleInScope(st, "b", false, { projectDir: "~/work/app", ...hOpt });
  expect(st.bundles[0].projects).toBeUndefined();
  expect(core.isBundleActive(st.bundles[0], { projectDir: "~/work/app", ...hOpt })).toBe(false);
});

test("efficiency #1: checkDisk fast-path (0 listDir calls on BUNDLES_PATH edit) vs full-path (SKILL.md description update)", async () => {
  let listDirCount = 0;
  const h = fakeHost();
  const origListDir = h.listDir;
  h.listDir = async (p) => {
    listDirCount++;
    return origListDir(p);
  };
  io.setHost(h);
  await io.load();
  expect(listDirCount).toBeGreaterThan(0);
  listDirCount = 0;

  // External BUNDLES_PATH change + mtime bump -> fast path: updates S.state with 0 listDir calls
  const updatedBundles = core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [
      { id: "b", name: "B", enabled: true, skills: ["alpha"] },
      { id: "extra", name: "Extra", enabled: false, skills: ["beta"] },
    ],
    overrides: { beta: "called" },
  }));
  put(core.BUNDLES_PATH, core.serializeBundles(updatedBundles));
  const t1 = new Date(Date.now() + 5_000);
  fs.utimesSync(real(core.BUNDLES_PATH), t1, t1);

  expect(await io.checkDisk()).toBe(true);
  expect(listDirCount).toBe(0);
  expect(io.S.state.bundles.map((b) => [b.id, b.enabled, b.skills])).toEqual([
    ["b", true, ["alpha"]],
    ["extra", false, ["beta"]],
  ]);
  expect(io.S.state.overrides.beta).toBe("called");

  // External SKILL.md description edit + mtime bump -> full path: updates io.meta(id).description
  put("~/.config/opencode/skills/beta/SKILL.md", skillMd("Beta revised description"));
  const t2 = new Date(Date.now() + 10_000);
  fs.utimesSync(real("~/.config/opencode/skills/beta/SKILL.md"), t2, t2);

  expect(await io.checkDisk()).toBe(true);
  expect(listDirCount).toBeGreaterThan(0);
  expect(io.meta("beta").description).toBe("Beta revised description");
});

test("efficiency #3: malformed skill-bundles.json during checkDisk records bad stamp (0 BUNDLES_PATH reads on retry) and recovers", async () => {
  let bundleReads = 0;
  const h = fakeHost();
  const origRead = h.readFile;
  h.readFile = async (p) => {
    if (p === core.BUNDLES_PATH) bundleReads++;
    return origRead(p);
  };
  io.setHost(h);
  await io.load();
  const priorState = JSON.parse(JSON.stringify(io.S.state));

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    // Write invalid JSON "{broken", add a new skill, AND edit an existing SKILL.md during the broken window
    put(core.BUNDLES_PATH, "{broken");
    put("~/.config/opencode/skills/delta/SKILL.md", skillMd("Delta added while broken"));
    put("~/.config/opencode/skills/beta/SKILL.md", skillMd("Beta edited while broken"));
    const t1 = new Date(Date.now() + 5_000);
    fs.utimesSync(real(core.BUNDLES_PATH), t1, t1);
    fs.utimesSync(real("~/.config/opencode/skills"), t1, t1);
    fs.utimesSync(real("~/.config/opencode/skills/beta/SKILL.md"), t1, t1);

    bundleReads = 0;
    expect(await io.checkDisk()).toBe(false);
    expect(bundleReads).toBe(1);
    expect(JSON.parse(JSON.stringify(io.S.state))).toEqual(priorState);

    // Second checkDisk with NO file/mtime change does 0 readFile calls on core.BUNDLES_PATH
    bundleReads = 0;
    expect(await io.checkDisk()).toBe(false);
    expect(bundleReads).toBe(0);
    expect(JSON.parse(JSON.stringify(io.S.state))).toEqual(priorState);

    // Writing valid updated JSON with a newer mtime recovers, runs deferred full scan, and refreshes both "delta" and "beta"
    const validNext = core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [{ id: "b", name: "B Recovered", enabled: true, skills: ["beta"] }],
      overrides: {},
    }));
    put(core.BUNDLES_PATH, core.serializeBundles(validNext));
    const t2 = new Date(Date.now() + 10_000);
    fs.utimesSync(real(core.BUNDLES_PATH), t2, t2);

    expect(await io.checkDisk()).toBe(true);
    expect(io.S.state.bundles).toEqual([{ id: "b", name: "B Recovered", enabled: true, skills: ["beta"] }]);
    expect(io.S.allIds).toContain("delta");
    expect(io.meta("delta").description).toBe("Delta added while broken");
    expect(io.meta("beta").description).toBe("Beta edited while broken");
  } finally {
    console.warn = origWarn;
  }
});

test("efficiency #5: overlapping checkDisk() calls coalesce with in-flight sync and update state once", async () => {
  let bundleReads = 0;
  let externalSyncCalls = 0;
  let releaseRead;
  const readGate = new Promise((r) => { releaseRead = r; });

  const h = fakeHost();
  const origRead = h.readFile;
  let pauseFirstBundleRead = false;
  h.readFile = async (p) => {
    if (p === core.BUNDLES_PATH) {
      bundleReads++;
      if (pauseFirstBundleRead) {
        pauseFirstBundleRead = false;
        await readGate;
      }
    }
    return origRead(p);
  };
  io.setHost(h);
  await io.load();

  const prevOnExternalSync = io.hooks.onExternalSync;
  io.hooks.onExternalSync = () => {
    externalSyncCalls++;
    prevOnExternalSync();
  };
  try {
    const next = core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [{ id: "b", name: "B Coalesced", enabled: true, skills: ["alpha", "beta"] }],
      overrides: {},
    }));
    put(core.BUNDLES_PATH, core.serializeBundles(next));
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(real(core.BUNDLES_PATH), future, future);

    bundleReads = 0;
    pauseFirstBundleRead = true;

    // Start first checkDisk() and let it enter syncFromDisk() (syncInFlight active) before firing the second
    const p1 = io.checkDisk();
    const p2 = io.checkDisk();
    await new Promise((r) => setTimeout(r, 10));
    const p3 = io.checkDisk();
    releaseRead();

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual([true, true, true]);
    expect(bundleReads).toBe(1);
    expect(externalSyncCalls).toBe(1);
    expect(io.S.state.bundles[0].name).toBe("B Coalesced");
    expect(io.S.state.bundles[0].enabled).toBe(true);
  } finally {
    io.hooks.onExternalSync = prevOnExternalSync;
  }
});

test("regression: checkDisk({ includeSkills: false }) escalates to full sync when SKILL.md changed alongside config", async () => {
  const h = fakeHost();
  io.setHost(h);
  await io.load();

  // Simulate CLI `skills set alpha auto` rewriting both BUNDLES_PATH and alpha/SKILL.md externally
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setOverride(s, "alpha", "called"))).toBe(true);
  });
  await settle();
  const alphaPath = "~/.config/opencode/skills/alpha/SKILL.md";
  expect(core.readFrontmatter(read(alphaPath)).autoinvoke).toBe(false);

  const cliState = core.setOverride(io.S.state, "alpha", "auto");
  const cliAlphaMd = core.setAutoinvoke(read(alphaPath), true);
  put(alphaPath, cliAlphaMd);
  put(core.BUNDLES_PATH, core.serializeBundles(cliState));
  const t1 = new Date(Date.now() + 5_000);
  fs.utimesSync(real(alphaPath), t1, t1);
  fs.utimesSync(real(core.BUNDLES_PATH), t1, t1);

  // Quick-tier poll tick must notice SKILL.md changed too and refresh S.skillMds
  expect(await io.checkDisk({ includeSkills: false })).toBe(true);
  expect(io.S.skillMds.alpha).toBe(cliAlphaMd);

  // Subsequent panel change back to `called` must rewrite SKILL.md with `autoinvoke: false`
  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setOverride(s, "alpha", "called"))).toBe(true);
  });
  await settle();
  expect(core.readFrontmatter(read(alphaPath)).autoinvoke).toBe(false);
});

test("load(onLoaded) fires onLoaded before post-stat verification and warms skill-index-v1 cache unless incomplete", async () => {
  const { SKILL_INDEX_KEY, formatRootStamps, statRootsMap } = await import("../status/cache.ts");
  const { skillRoots } = await import("../src/discover.js");

  fx.storage.clear();
  const h = fakeHost();
  let statsAfterOnLoaded = 0;
  let onLoadedFired = false;
  let loadedDuringCallback = false;
  let stateDuringCallback = null;
  const origStat = h.stat;
  h.stat = async (p) => {
    if (onLoadedFired) statsAfterOnLoaded++;
    return origStat(p);
  };
  io.setHost(h);
  io.S.loaded = false;
  io.S.state = null;

  await io.load(() => {
    onLoadedFired = true;
    loadedDuringCallback = io.S.loaded;
    stateDuringCallback = io.S.state;
  });

  expect(onLoadedFired).toBe(true);
  expect(loadedDuringCallback).toBe(true);
  expect(stateDuringCallback?.bundles.map((b) => b.id)).toEqual(["b"]);
  expect(statsAfterOnLoaded).toBeGreaterThan(0);

  const roots = skillRoots(io.S.opencodeText);
  const expectedStamps = formatRootStamps(roots, await statRootsMap(h, roots));
  const cached = await h.storage.get(SKILL_INDEX_KEY);
  expect(cached).toMatchObject({
    v: 1,
    rootsKey: JSON.stringify(roots),
    rootStamps: expectedStamps,
    allIds: io.S.allIds,
    home,
  });
  expect(typeof cached.scannedAt).toBe("number");

  // Full sync updates skill-index-v1 when a new skill is added on disk
  put("~/.config/opencode/skills/gamma/SKILL.md", skillMd("Gamma"));
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(real("~/.config/opencode/skills"), future, future);
  expect(await io.syncFromDisk({ full: true })).toBe(true);
  await Promise.resolve();
  const cachedAfterSync = await h.storage.get(SKILL_INDEX_KEY);
  expect(cachedAfterSync.allIds).toContain("gamma");

  // Incomplete discovery does NOT overwrite or populate skill-index-v1
  fx.storage.clear();
  put(core.OPENCODE_PATH, JSON.stringify({ $schema: "x", skills: ["/outside/skills"], permissions: [] }, null, 2) + "\n");
  const origListDir = h.listDir;
  h.listDir = async (p) => {
    if (p === "/outside/skills") throw new HostRequestError("BAD_PATH", "outside");
    return origListDir(p);
  };
  await io.load();
  expect(io.S.incomplete).toBe(true);
  expect(await h.storage.get(SKILL_INDEX_KEY)).toBeUndefined();
});

test("regression: commit() inside load(onLoaded) keeps lastDiskStamp null until verified and discovers concurrent new skills", async () => {
  const { SKILL_INDEX_KEY } = await import("../status/cache.ts");
  fx.storage.clear();
  const h = fakeHost();
  io.setHost(h);

  // Inside onLoaded (before post-stat verification runs), add a new skill on disk AND queue a user toggle
  await io.load(() => {
    put("~/.config/opencode/skills/epsilon/SKILL.md", skillMd("Epsilon added mid-boot"));
    const t = new Date(Date.now() + 5_000);
    fs.utimesSync(real("~/.config/opencode/skills"), t, t);
    io.commit((s) => core.setBundleGlobal(s, "b", true));
  });
  await settle();
  expect(io.S.state.bundles[0].enabled).toBe(true);

  // Because baseline stamps were unverified during save(), checkDisk() runs a full verification scan and discovers epsilon
  expect(await io.checkDisk()).toBe(true);
  expect(io.S.allIds).toContain("epsilon");
  expect((await h.storage.get(SKILL_INDEX_KEY))?.allIds).toContain("epsilon");
});

test("regression: checkDisk() during load(onLoaded) post-stat waits for postLoadStamps and uses 0-listDir fast path on project switch", async () => {
  const projNew = `${home}/work/proj-switch`;
  fs.mkdirSync(real(projNew), { recursive: true });
  put(`${projNew}/.opencode/opencode.json`, JSON.stringify({ permissions: [] }) + "\n");

  let listDirCalls = 0;
  const h = fakeHost();
  const origListDir = h.listDir;
  h.listDir = async (p) => {
    listDirCalls++;
    return origListDir(p);
  };
  io.setHost(h);

  let diskPromise;
  await io.load(() => {
    // Discovery has already finished when onLoaded fires; reset counter and simulate immediate onDirectory switch
    listDirCalls = 0;
    io.S.activeDir = projNew;
    diskPromise = io.checkDisk();
  });
  await diskPromise;

  // checkDisk() waited for postLoadStamps and read projNew's config via the 0-listDir fast path!
  expect(listDirCalls).toBe(0);
  expect(Object.hasOwn(io.S.projectTexts, core.projectConfigPath("~/work/proj-switch"))).toBe(true);
});

test("regression: StaleError reloadAfter() inside enqueue verifies stamps so subsequent checkDisk() needs 0 listDirs", async () => {
  let listDirCalls = 0;
  const h = fakeHost();
  const origListDir = h.listDir;
  h.listDir = async (p) => {
    listDirCalls++;
    return origListDir(p);
  };
  io.setHost(h);
  await io.load();

  // Externally edit skill-bundles.json WITHOUT syncing so applyChange hits StaleError -> reloadAfter() inside enqueue
  const extState = core.setBundleGlobal(io.S.state, "b", true);
  put(core.BUNDLES_PATH, core.serializeBundles(extState));
  const t1 = new Date(Date.now() + 5_000);
  fs.utimesSync(real(core.BUNDLES_PATH), t1, t1);

  await io.enqueue(async () => {
    expect(await io.applyChange((s) => core.setOverride(s, "alpha", "called"))).toBe(false);
  });
  await settle();
  expect(io.S.state.bundles[0].enabled).toBe(true);

  // reloadAfter()'s load() verified stamps cleanly even though activeWrites was 1 -> next checkDisk() is a 0-listDir no-op!
  listDirCalls = 0;
  expect(await io.checkDisk()).toBe(false);
  expect(listDirCalls).toBe(0);
});

// ---------- cache-first boot (panel-index-v1) ----------

/** A host that counts listDir calls and SKILL.md reads, on the shared fixture. */
function countingHost() {
  const h = fakeHost();
  const c = { listDir: 0, skillReads: 0, projects: 0 };
  const { listDir, readFile, listProjects } = h;
  h.listDir = async (p) => { c.listDir++; return listDir(p); };
  h.readFile = async (p) => { if (p.endsWith(".md")) c.skillReads++; return readFile(p); };
  h.listProjects = async () => { c.projects++; return listProjects(); };
  return { h, c };
}

/** Fresh panel state, as a newly opened frame has. */
function resetPanel(h) {
  io.setHost(h);
  io.S.loaded = false;
  io.S.state = null;
  io.S.allIds = [];
  io.S.skillMds = {};
  io.S.skillPaths = Object.create(null);
  io.S.homeDerived = false;
  io.S.home = undefined;
}

test("cache-first load paints from panel-index-v1 with no folder walk, SKILL.md read or project list, then hydrates", async () => {
  // beforeEach's full load stored the index.
  const { h, c } = countingHost();
  resetPanel(h);
  let atPaint = null;
  let paints = 0;
  await io.load(() => {
    paints++;
    if (atPaint) return;
    atPaint = { ...c, fresh: io.S.fresh, ids: [...io.S.allIds], desc: io.meta("alpha").description, path: io.skillPath("beta"), bundles: io.S.state?.bundles.map((b) => b.id) };
  }, { cache: true });
  expect(atPaint).toEqual({ listDir: 0, skillReads: 0, projects: 0, fresh: false, ids: io.S.allIds, desc: "Alpha", path: "~/.config/opencode/skills/beta/SKILL.md", bundles: ["b"] });
  expect(paints).toBe(2);
  expect(io.S.fresh).toBe(true);
  expect(c.listDir).toBeGreaterThan(0);
  // Unchanged since the index: verified by stat, never read.
  expect(c.skillReads).toBe(0);
  expect(io.meta("beta").description).toBe("Beta");
});

test("cache-first load: a commit made on the index paint waits for the disk and plans on real SKILL.md text", async () => {
  const { h } = countingHost();
  resetPanel(h);
  let queued = false;
  await io.load(() => {
    if (queued) return;
    queued = true;
    expect(io.S.fresh).toBe(false);
    io.commit((s) => core.setOverride(core.setBundleEnabled(s, "b", true), "alpha", "called"));
  }, { cache: true });
  await settle();
  expect(io.S.state.overrides.alpha).toBe("called");
  expect(read("~/.config/opencode/skills/alpha/SKILL.md")).toContain("opencode/autoinvoke: false");
  expect(read("~/.config/opencode/skills/alpha/SKILL.md")).toContain("description: Alpha");
  expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
});

test("cache-first load: an index for other skill roots is ignored, the panel loads from disk once", async () => {
  put(core.OPENCODE_PATH, JSON.stringify({ $schema: "x", skills: ["~/extra/skills"], permissions: [] }, null, 2) + "\n");
  put("~/extra/skills/delta/SKILL.md", skillMd("Delta"));
  const { h } = countingHost();
  resetPanel(h);
  const seen = [];
  await io.load(() => seen.push({ fresh: io.S.fresh, delta: io.S.allIds.includes("delta") }), { cache: true });
  expect(seen).toEqual([{ fresh: true, delta: true }]);
});

test("cache-first load: syncFromDisk and checkDisk do nothing until the disk load lands", async () => {
  const base = countingHost();
  resetPanel(base.h);
  await io.load(undefined, { cache: true });
  const { h, c } = countingHost();
  resetPanel(h);
  const results = [];
  const counted = h.listDir;
  // A sync ping arriving while the disk load is walking folders (after it took its generation).
  h.listDir = async (p) => {
    if (!results.length && !io.S.fresh) results.push(io.syncFromDisk({ full: true }), io.checkDisk());
    return counted(p);
  };
  await io.load(undefined, { cache: true });
  expect(await Promise.all(results)).toEqual([false, false]);
  expect(c.listDir).toBe(base.c.listDir); // the disk load's own walk only, no second scan
});

test("cache-first load: a description edited on disk since the index shows after hydration and is stored for the next boot", async () => {
  put("~/.config/opencode/skills/alpha/SKILL.md", skillMd("Alpha v2"));
  const { h, c } = countingHost();
  resetPanel(h);
  const descs = [];
  await io.load(() => descs.push(io.meta("alpha").description), { cache: true });
  expect(descs).toEqual(["Alpha", "Alpha v2"]);
  expect(c.skillReads).toBe(1); // only the edited file
  const { PANEL_INDEX_KEY } = await import("../panel/index-cache.ts");
  await Promise.resolve();
  const stored = await h.storage.get(PANEL_INDEX_KEY);
  expect(stored.skills.find((s) => s.id === "alpha").description).toBe("Alpha v2");
});

test("parsePanelIndex: accepts a valid index and drops one with any malformed field", async () => {
  const { parsePanelIndex } = await import("../panel/index-cache.ts");
  const ok = { v: 1, rootsKey: "[]", home: "/h", allIds: ["a"], skills: [{ id: "a", root: "~/r", path: "~/r/a/SKILL.md", dir: "~/r/a", description: "d", autoinvoke: true, error: null, stamp: "file:1:2" }], unreachable: [], unreadable: [] };
  expect(parsePanelIndex(ok)).toEqual(ok);
  expect(parsePanelIndex({ ...ok, v: 2 })).toBeNull();
  expect(parsePanelIndex({ ...ok, allIds: [1] })).toBeNull();
  expect(parsePanelIndex({ ...ok, skills: [{ ...ok.skills[0], autoinvoke: "yes" }] })).toBeNull();
  expect(parsePanelIndex({ ...ok, unreachable: [{ path: "x" }] })).toBeNull();
  expect(parsePanelIndex({ ...ok, skills: [{ ...ok.skills[0], stamp: "err:DENIED" }] })).toBeNull();
  expect(parsePanelIndex(null)).toBeNull();
  expect(parsePanelIndex([])).toBeNull();
});

// ---------- lazy SKILL.md text (read only when needed) ----------

/** Reopen the panel the way the rail does: cache-first, on a counting host. */
async function cacheBoot() {
  const { h, c } = countingHost();
  resetPanel(h);
  await io.load(undefined, { cache: true });
  expect(c.skillReads).toBe(0);
  return { h, c };
}

test("lazy: turning a bundle on reads its skills and removes a 'when called' opt-out from an unread SKILL.md", async () => {
  const betaPath = "~/.config/opencode/skills/beta/SKILL.md";
  put(betaPath, core.setAutoinvoke(skillMd("Beta"), false));
  await io.load(); // re-index with beta's new stamp
  await Promise.resolve();
  const { c } = await cacheBoot();
  io.commit((s) => core.setBundleEnabled(s, "b", true));
  await settle();
  expect(core.readFrontmatter(read(betaPath)).autoinvoke).toBe(true);
  expect(c.skillReads).toBeGreaterThanOrEqual(2); // alpha + beta, both now live
});

test("lazy: a description edit on an unread skill is applied to its real text", async () => {
  const p = "~/.config/opencode/skills/beta/SKILL.md";
  await cacheBoot();
  io.saveDescription("beta", "Beta edited");
  await settle();
  expect(read(p)).toBe(skillMd("Beta edited"));
  expect(io.meta("beta").description).toBe("Beta edited");
});

test("lazy: an unread SKILL.md that became unreadable is reported, and 'when called' on it is refused", async () => {
  const p = "~/.config/opencode/skills/alpha/SKILL.md";
  const { h } = await cacheBoot();
  const readFile = h.readFile;
  h.readFile = async (x) => {
    if (x === p) throw new HostRequestError("DENIED", "nope");
    return readFile(x);
  };
  io.commit((s) => core.setOverride(s, "alpha", "called"));
  await settle();
  expect(io.S.unreadable).toContain("alpha");
  expect(read(p)).toBe(skillMd("Alpha"));
  expect(io.S.state.overrides.alpha).toBeUndefined();
  expect(toasts.some((t) => t.kind === "error" && /alpha/.test(t.message))).toBe(true);
});

test("lazy: checkDisk after an external edit reads only the edited SKILL.md", async () => {
  const { c } = await cacheBoot();
  put("~/.config/opencode/skills/beta/SKILL.md", skillMd("Beta v2"));
  const t = new Date(Date.now() + 5_000);
  fs.utimesSync(real("~/.config/opencode/skills/beta/SKILL.md"), t, t);
  expect(await io.checkDisk()).toBe(true);
  expect(io.meta("beta").description).toBe("Beta v2");
  expect(c.skillReads).toBe(1);
  expect(io.meta("alpha").description).toBe("Alpha");
});

test("lazy: a non-full sync racing an on-demand read keeps its unreadable result, so 'when called' stays refused", async () => {
  const p = "~/.config/opencode/skills/alpha/SKILL.md";
  const { h } = await cacheBoot();
  const readFile = h.readFile;
  let lockReads = -1; // armed below
  h.readFile = async (x) => {
    if (x === p) throw new HostRequestError("DENIED", "nope");
    if (x === core.LOCK_PATH && lockReads >= 0 && ++lockReads === 2) {
      // The sync's post-read lock check: an on-demand read finishes (DENIED) right now.
      await io.loadSkillMd("alpha");
    }
    return readFile(x);
  };
  // A config-only change, so the sync really applies its snapshot (not an early "unchanged" return).
  put(core.BUNDLES_PATH, core.serializeBundles(core.renameBundle(io.S.state, "b", "B renamed")));
  const t = new Date(Date.now() + 5_000);
  fs.utimesSync(real(core.BUNDLES_PATH), t, t);
  lockReads = 0;
  expect(await io.syncFromDisk()).toBe(true);
  lockReads = -1;
  expect(io.S.state.bundles[0].name).toBe("B renamed");
  expect(io.S.unreadable).toContain("alpha");
  io.commit((s) => core.setOverride(s, "alpha", "called"));
  await settle();
  expect(io.S.state.overrides.alpha).toBeUndefined();
  expect(read(p)).toBe(skillMd("Alpha"));
});

test("lazy: a live skill with neither text nor an unreadable record is never planned blind", async () => {
  const p = "~/.config/opencode/skills/alpha/SKILL.md";
  delete io.S.skillMds.alpha; // a state no path should reach: not loaded, not lazy, not unreadable
  io.commit((s) => core.setOverride(s, "alpha", "called"));
  await settle();
  // Either refused or recovered by a reload, but never "called" without the SKILL.md edit.
  const st = io.S.state.overrides.alpha;
  if (st === "called") expect(core.readFrontmatter(read(p)).autoinvoke).toBe(false);
  expect(core.readFrontmatter(read(p)).autoinvoke === false || read(core.BUNDLES_PATH).includes('"called"') === false).toBe(true);
});
