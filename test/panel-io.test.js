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
    getAttribute(k) { return this.attrs[k] ?? null; }
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
    dispatch(t, ev = {}) {
      for (const fn of [...(this.listeners[t] ?? [])]) fn({ type: t, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...ev });
    }
    click(ev = {}) { this.dispatch("click", { altKey: false, ...ev }); }
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
