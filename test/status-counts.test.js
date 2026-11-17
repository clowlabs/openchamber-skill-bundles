// Unit tests for skill-bundles/status/counts.ts. Needs bun (imports TypeScript):
//   bun test test/status-counts.test.js
// Under `node --test test/` it registers one skipped test so the Node suite stays green.
import fs from "node:fs";

const isBun = typeof globalThis.Bun !== "undefined";
if (!isBun) {
  const { test: nodeTest } = await import("node:test");
  nodeTest("status-counts (run with: bun test test/status-counts.test.js)", { skip: "needs bun" }, () => {});
}
const { afterEach, beforeEach, describe, expect, test } = isBun
  ? await import("bun:test")
  : { afterEach() {}, beforeEach() {}, describe() {}, expect() {}, test() {} };
const { HostRequestError } = await import("@openchamber/sdk");
const core = await import("../src/core.js");
const counts = isBun ? await import("../status/counts.ts") : null;
const cache = isBun ? await import("../status/cache.ts") : null;
const { createFakeHost } = await import("../shared/test/fake-host.js");

const skillMd = (desc) => `---\nname: x\ndescription: ${desc}\n---\nBody\n`;

describe("renderMeterHeader", () => {
  const withDom = (fn) => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
    const make = () => {
      const el = {
        className: "",
        textContent: "",
        title: "",
        children: [],
        attrs: {},
        style: {},
        append: (...c) => el.children.push(...c),
        prepend: (...c) => el.children.unshift(...c),
        replaceChildren: (...c) => el.children.splice(0, el.children.length, ...c),
        appendChild: (c) => el.children.push(c),
        setAttribute: (k, v) => { el.attrs[k] = v; },
      };
      return el;
    };
    globalThis.document = { createElement: make };
    try {
      return fn();
    } finally {
      if (saved) Object.defineProperty(globalThis, "document", saved);
      else delete globalThis.document;
    }
  };
  const c = { live: 25, installed: 218, chars: 25 * core.CHARS_PER_SKILL, bundlesOn: [], fromOpencode: false };

  test("default (rail panel) keeps the meter bar", () => {
    withDom(() => {
      const { wrap, left, fill } = counts.renderMeterHeader(c);
      expect(wrap.className).toBe("skm");
      expect(wrap.children.map((x) => x.className)).toEqual(["skm-top", "skm-meter"]);
      expect(left.children.map((x) => x.textContent)).toEqual(["25", "live", " / 218 installed · 11%"]);
      expect(left.children.map((x) => x.className)).toEqual(["skm-live-n", "skm-live-w", "skm-rest"]);
      expect(wrap.children[0].children[1].textContent).toBe("~1.1k tokens");
      expect(fill.style.width).toBe("11%");
    });
  });

  test("compact (Work Status) is one line with no meter bar", () => {
    withDom(() => {
      const { wrap, left, fill } = counts.renderMeterHeader(c, { compact: true });
      expect(wrap.className).toBe("skm skm-compact");
      expect(wrap.children.map((x) => x.className)).toEqual(["skm-top"]);
      const top = wrap.children[0];
      expect(top.children.map((x) => x.className)).toEqual(["skm-icon", "skm-left", "skm-tokens"]);
      expect(top.children[0].innerHTML).toBe(counts.STACK_ICON_SVG);
      expect(top.children[0].attrs["aria-hidden"]).toBe("true");
      expect(top.children[2].textContent).toBe("~1.1k tokens");
      expect(fill).toBeNull();
      expect(left.children.map((x) => x.textContent)).toEqual(["25", "/ 218", "live"]);
      expect(left.children.map((x) => x.className)).toEqual(["skm-live-n", "skm-rest", "skm-live-w"]);
    });
  });
});

describe("parseSkillRules & applySkillRules", () => {
  test("parses valid skill rules, ignores non-skill entries, and handles missing/malformed inputs", () => {
    expect(counts.parseSkillRules("{}")).toEqual([]);
    expect(counts.parseSkillRules('{"$schema":"x"}')).toEqual([]);
    expect(
      counts.parseSkillRules(
        JSON.stringify({
          permissions: [
            { action: "skill", resource: "*", effect: "deny" },
            { action: "bash", resource: "rm", effect: "deny" },
            { action: "skill", resource: "alpha", effect: "allow" },
            { action: "skill", resource: 123, effect: "allow" },
            null,
          ],
        }),
      ),
    ).toEqual([
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "alpha", effect: "allow" },
    ]);

    expect(counts.parseSkillRules("not json")).toBeNull();
    expect(counts.parseSkillRules("[]")).toBeNull();
    expect(counts.parseSkillRules("null")).toBeNull();
    expect(counts.parseSkillRules('{"permissions":"bad"}')).toBeNull();
    expect(counts.parseSkillRules('{"permissions":{}}')).toBeNull();
  });

  test("applySkillRules evaluates last-matching-rule semantics with wildcard *", () => {
    const rules = [
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "alpha", effect: "allow" },
      { action: "skill", resource: "beta", effect: "allow" },
      { action: "skill", resource: "beta", effect: "deny" },
    ];
    expect(counts.applySkillRules(true, rules, "alpha")).toBe(true);
    expect(counts.applySkillRules(true, rules, "beta")).toBe(false);
    expect(counts.applySkillRules(true, rules, "gamma")).toBe(false);
    expect(counts.applySkillRules(false, [], "alpha")).toBe(false);
  });

  test("liveFromOpencode returns 0 on invalid opencodeText and ignores invalid projectOpencodeText", () => {
    const ids = ["alpha", "beta", "gamma"];
    expect(counts.liveFromOpencode("{broken", ids)).toBe(0);
    expect(counts.liveFromOpencode("null", ids)).toBe(0);
    expect(counts.liveFromOpencode('{"permissions":"bad"}', ids)).toBe(0);
    expect(counts.liveFromOpencode(null, ids)).toBe(3);
    expect(counts.liveFromOpencode("{}", ids)).toBe(3);

    const globalDeny = JSON.stringify({
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "alpha", effect: "allow" },
      ],
    });
    expect(counts.liveFromOpencode(globalDeny, ids)).toBe(1);
    expect(counts.liveFromOpencode(globalDeny, ids, "{broken-project-json")).toBe(1);

    const projAllow = JSON.stringify({
      permissions: [{ action: "skill", resource: "beta", effect: "allow" }],
    });
    expect(counts.liveFromOpencode(globalDeny, ids, projAllow)).toBe(2);
  });
});

describe("countsFromState", () => {
  const home = "/home/tester";
  const projA = "/home/tester/work/proj-a";
  const projB = "/home/tester/work/proj-b";
  const allIds = ["alpha", "beta", "gamma", ...core.BUILTIN_SKILLS];

  test("counts global bundles and called overrides accurately", () => {
    const state = core.parseBundles(
      JSON.stringify({
        version: 1,
        bundles: [
          { id: "dev", name: "Dev", enabled: true, skills: ["alpha", "beta"] },
          { id: "off-b", name: "Off", enabled: false, skills: ["gamma"] },
        ],
        overrides: { beta: "called" },
      }),
      { home },
    );
    const res = counts.countsFromState(state, allIds, "{}", { home });
    // alpha is auto (1 * CHARS_PER_SKILL), beta is called (live, 0 chars)
    expect(res.live).toBe(2);
    expect(res.installed).toBe(allIds.length);
    expect(res.chars).toBe(1 * core.CHARS_PER_SKILL);
    expect(res.bundlesOn).toEqual(["dev"]);
    expect(res.fromOpencode).toBe(false);
  });

  test("evaluates project-scoped bundle, excludedProjects, and project opencode.json rules", () => {
    const state = core.parseBundles(
      JSON.stringify({
        version: 1,
        bundles: [
          { id: "global-ex", name: "Global Ex", enabled: true, skills: ["alpha"], excludedProjects: [projA] },
          { id: "proj-only", name: "Proj Only", enabled: false, skills: ["beta"], projects: [projA] },
        ],
        overrides: {},
      }),
      { home },
    );

    // In projA: global-ex is excluded, proj-only is active. Project opencode.json denies alpha and allows beta.
    const projRulesText = JSON.stringify({
      permissions: [
        { action: "skill", resource: "alpha", effect: "deny" },
        { action: "skill", resource: "beta", effect: "allow" },
      ],
    });
    const inProjA = counts.countsFromState(state, ["alpha", "beta", "gamma"], "{}", {
      projectDir: projA,
      home,
      projectOpencodeText: projRulesText,
    });
    expect(inProjA.bundlesOn).toEqual(["proj-only"]);
    expect(inProjA.live).toBe(1);
    expect(inProjA.chars).toBe(1 * core.CHARS_PER_SKILL);

    // In projB (no projectOpencodeText -> null): global-ex is active, proj-only is off
    const inProjB = counts.countsFromState(state, ["alpha", "beta", "gamma"], "{}", {
      projectDir: projB,
      home,
      projectOpencodeText: null,
    });
    expect(inProjB.bundlesOn).toEqual(["global-ex"]);
    expect(inProjB.live).toBe(1);
  });

  test("per-skill off override combined with project allow rule makes skill live in project", () => {
    const state = core.parseBundles(
      JSON.stringify({
        version: 1,
        bundles: [{ id: "dev", name: "Dev", enabled: true, skills: ["alpha", "beta"] }],
        overrides: { beta: "off", gamma: "called" },
      }),
      { home },
    );
    const projAllowBeta = JSON.stringify({
      permissions: [{ action: "skill", resource: "beta", effect: "allow" }],
    });
    const res = counts.countsFromState(state, ["alpha", "beta", "gamma"], "{}", {
      projectDir: projA,
      home,
      projectOpencodeText: projAllowBeta,
    });
    // alpha (auto via bundle), beta (global off, overridden to allow by project rule -> auto), gamma (called -> live, 0 chars)
    expect(res.live).toBe(3);
    expect(res.chars).toBe(2 * core.CHARS_PER_SKILL);
  });

  test("falls back to state summary when projectOpencodeText is malformed JSON", () => {
    const state = core.parseBundles(
      JSON.stringify({
        version: 1,
        bundles: [
          { id: "global-ex", name: "Global Ex", enabled: true, skills: ["alpha"], excludedProjects: [projA] },
          { id: "proj-only", name: "Proj Only", enabled: false, skills: ["beta"], projects: [projA] },
        ],
        overrides: {},
      }),
      { home },
    );
    const res = counts.countsFromState(state, ["alpha", "beta", "gamma"], "{}", {
      projectDir: projA,
      home,
      projectOpencodeText: "{corrupt-json",
    });
    expect(res.bundlesOn).toEqual(["proj-only"]);
    expect(res.live).toBe(1);
    expect(res.chars).toBe(1 * core.CHARS_PER_SKILL);
  });
});

describe("readCounts", () => {
  let fx;
  let home;

  beforeEach(() => {
    fx = createFakeHost({ makeError: (code, msg) => new HostRequestError(code, msg) });
    home = fx.home;
    fx.put("~/.config/opencode/opencode.json", JSON.stringify({ permissions: [] }) + "\n");
    fx.put("~/.config/opencode/skills/alpha/SKILL.md", skillMd("Alpha"));
    fx.put("~/.config/opencode/skills/beta/SKILL.md", skillMd("Beta"));
    fx.put(
      "~/.config/opencode/skill-bundles.json",
      core.serializeBundles(
        core.parseBundles(
          JSON.stringify({
            version: 1,
            bundles: [{ id: "b", name: "B", enabled: true, skills: ["alpha"] }],
            overrides: {},
          }),
        ),
      ),
    );
  });

  afterEach(() => {
    fx.cleanup();
  });

  test("reuses cachedIds without calling listDir", async () => {
    let listDirCalls = 0;
    const host = {
      ...fx.host,
      listDir: async (p) => {
        listDirCalls++;
        return fx.host.listDir(p);
      },
    };

    const full = await counts.readCounts(host, { home });
    expect(listDirCalls).toBeGreaterThan(0);
    expect(full.live).toBe(1);

    listDirCalls = 0;
    const cached = await counts.readCounts(host, {
      home,
      cachedIds: ["alpha", "beta", ...core.BUILTIN_SKILLS],
    });
    expect(listDirCalls).toBe(0);
    expect(cached.live).toBe(1);
    expect(cached.installed).toBe(2 + core.BUILTIN_SKILLS.length);
  });

  test("reads active project opencode.json in parallel with skill discovery", async () => {
    const proj = `${home}/work/proj-parallel`;
    fs.mkdirSync(fx.real(proj), { recursive: true });
    fx.put(
      `${proj}/.opencode/opencode.json`,
      JSON.stringify({ permissions: [{ action: "skill", resource: "beta", effect: "allow" }] }) + "\n",
    );

    const events = [];
    let releaseProj;
    const projGate = new Promise((r) => {
      releaseProj = r;
    });

    const host = {
      ...fx.host,
      readFile: async (p) => {
        if (p.endsWith("proj-parallel/.opencode/opencode.json")) {
          events.push("proj:start");
          await projGate;
          events.push("proj:end");
        }
        return fx.host.readFile(p);
      },
      listDir: async (p) => {
        events.push(`listDir:${p}`);
        if (events.filter((e) => e.startsWith("listDir:")).length === 1) {
          releaseProj();
        }
        return fx.host.listDir(p);
      },
    };

    const res = await counts.readCounts(host, { projectDir: proj, home });
    // Both project readFile and listSkillIds listDir started concurrently before projGate resolved
    expect(events).toContain("proj:start");
    expect(events.some((e) => e.startsWith("listDir:"))).toBe(true);
    const firstListIdx = events.findIndex((e) => e.startsWith("listDir:"));
    const projEndIdx = events.indexOf("proj:end");
    expect(firstListIdx).toBeLessThan(projEndIdx);
    // alpha (bundle) + beta (project allow) = 2
    expect(res.live).toBe(2);
  });

  test("falls back cleanly when active project opencode.json is unreadable", async () => {
    const proj = `${home}/work/locked-proj`;
    fs.mkdirSync(fx.real(proj), { recursive: true });
    fx.put(
      "~/.config/opencode/skill-bundles.json",
      core.serializeBundles(
        core.parseBundles(
          JSON.stringify(
            {
              version: 1,
              bundles: [{ id: "p", name: "P", enabled: false, skills: ["alpha", "beta"], projects: [proj] }],
              overrides: {},
            },
          ),
          { home },
        ),
        { home },
      ),
    );

    const host = {
      ...fx.host,
      readFile: async (p) => {
        if (p.includes("locked-proj") && p.endsWith(".opencode/opencode.json")) {
          throw new HostRequestError("DENIED", "permission denied");
        }
        return fx.host.readFile(p);
      },
    };

    const res = await counts.readCounts(host, { projectDir: proj, home });
    expect(res.bundlesOn).toEqual(["p"]);
    expect(res.live).toBe(2);
  });
});

describe("status/cache & createStatusLoader", () => {
  let fx;
  let home;

  beforeEach(() => {
    fx = createFakeHost({ makeError: (code, msg) => new HostRequestError(code, msg) });
    home = fx.home;
    fx.put("~/.config/opencode/opencode.json", JSON.stringify({ permissions: [] }) + "\n");
    fx.put("~/.config/opencode/skills/alpha/SKILL.md", skillMd("Alpha"));
    fx.put("~/.config/opencode/skills/beta/SKILL.md", skillMd("Beta"));
    fx.put(
      "~/.config/opencode/skill-bundles.json",
      core.serializeBundles(
        core.parseBundles(
          JSON.stringify({
            version: 1,
            bundles: [{ id: "global-b", name: "Global B", enabled: true, skills: ["alpha"] }],
            overrides: {},
          }),
          { home },
        ),
      ),
    );
  });

  afterEach(() => {
    fx.cleanup();
  });

  test("parseSkillIndexCache validates schema and read/writeSkillIndexCache handle storage safely", async () => {
    expect(cache.parseSkillIndexCache(null)).toBeNull();
    expect(cache.parseSkillIndexCache({ v: 2, rootsKey: "[]", rootStamps: "", allIds: [], scannedAt: 1 })).toBeNull();
    expect(cache.parseSkillIndexCache({ v: 1, rootsKey: "[]", rootStamps: "", allIds: [1], scannedAt: 1 })).toBeNull();
    expect(
      cache.parseSkillIndexCache({
        v: 1,
        rootsKey: "[]",
        rootStamps: "",
        allIds: ["a"],
        home: "/home/u",
        scannedAt: 100,
      }),
    ).toEqual({
      v: 1,
      rootsKey: "[]",
      rootStamps: "",
      allIds: ["a"],
      home: "/home/u",
      scannedAt: 100,
    });

    const entry = {
      v: 1,
      rootsKey: '["~/.config/opencode/skills"]',
      rootStamps: "directory:0:1",
      allIds: ["alpha"],
      home,
      scannedAt: 123,
    };
    await cache.writeSkillIndexCache(fx.host, entry);
    expect(await cache.readSkillIndexCache(fx.host)).toEqual(entry);
    expect(await cache.readSkillIndexCache({})).toBeNull();
  });

  test("cold loader populates storage, and a brand-new loader instance returns project-scoped counts in 0 listDir calls", async () => {
    const proj = `${home}/work/proj-fast`;
    fs.mkdirSync(fx.real(proj), { recursive: true });
    fx.put(
      "~/.config/opencode/skill-bundles.json",
      core.serializeBundles(
        core.parseBundles(
          JSON.stringify({
            version: 1,
            bundles: [
              { id: "global-b", name: "Global B", enabled: true, skills: ["alpha"] },
              { id: "proj-b", name: "Proj B", enabled: false, skills: ["beta"], projects: [proj] },
            ],
            overrides: {},
          }),
          { home },
        ),
      ),
    );
    fx.put(
      `${proj}/.opencode/opencode.json`,
      JSON.stringify({ permissions: [{ action: "skill", resource: "beta", effect: "allow" }] }) + "\n",
    );

    const coldLoader = counts.createStatusLoader(fx.host);
    const coldRes = await coldLoader.load(null);
    expect(coldRes.live).toBe(1);
    expect(coldRes.installed).toBe(2 + core.BUILTIN_SKILLS.length);

    // Wait a microtask for fire-and-forget writeSkillIndexCache to settle
    await new Promise((r) => setTimeout(r, 10));
    const stored = await fx.host.storage.get(cache.SKILL_INDEX_KEY);
    expect(stored).toBeDefined();
    expect(stored.allIds).toEqual(["alpha", "beta", ...core.BUILTIN_SKILLS].sort());
    expect(stored.home).toBe(home);

    // Simulate reopening the Work Status iframe: brand-new loader instance!
    let listDirCalls = 0;
    const spiedHost = {
      ...fx.host,
      listDir: async (p) => {
        listDirCalls++;
        return fx.host.listDir(p);
      },
    };
    const warmLoader = counts.createStatusLoader(spiedHost);
    const warmRes = await warmLoader.load(proj);
    expect(listDirCalls).toBe(0);
    expect(warmRes.bundlesOn).toEqual(["global-b", "proj-b"]);
    expect(warmRes.live).toBe(2);
    expect(warmRes.installed).toBe(2 + core.BUILTIN_SKILLS.length);
  });

  test("stale-while-revalidate: added skill + bumped root mtime returns optimistic counts with 0 blocking listDirs, then calls onRevalidated", async () => {
    const firstLoader = counts.createStatusLoader(fx.host);
    const initial = await firstLoader.load(null);
    expect(initial.installed).toBe(2 + core.BUILTIN_SKILLS.length);
    await new Promise((r) => setTimeout(r, 10));

    // Add a new skill folder and bump root mtime while unmounted
    fx.put("~/.config/opencode/skills/gamma/SKILL.md", skillMd("Gamma"));
    const rootReal = fx.real("~/.config/opencode/skills");
    const bumpedTime = new Date(Date.now() + 5_000);
    fs.utimesSync(rootReal, bumpedTime, bumpedTime);

    let listDirCalls = 0;
    let releaseListDir;
    const listDirGate = new Promise((r) => {
      releaseListDir = r;
    });

    const spiedHost = {
      ...fx.host,
      listDir: async (p) => {
        listDirCalls++;
        await listDirGate;
        return fx.host.listDir(p);
      },
    };

    let revalidatedCounts = null;
    let resolveRevalidated;
    const revalidatedDone = new Promise((r) => {
      resolveRevalidated = r;
    });

    const reopenedLoader = counts.createStatusLoader(spiedHost, {
      onRevalidated: (c) => {
        revalidatedCounts = c;
        resolveRevalidated(c);
      },
    });

    // load() resolves BEFORE listDirGate is released — 0 blocking listDirs!
    const immediate = await reopenedLoader.load(null);
    expect(immediate.installed).toBe(2 + core.BUILTIN_SKILLS.length);
    expect(revalidatedCounts).toBeNull();

    // Unblock background scan
    releaseListDir();
    const updated = await revalidatedDone;
    expect(listDirCalls).toBeGreaterThan(0);
    expect(updated.installed).toBe(3 + core.BUILTIN_SKILLS.length);

    const storedAfter = await fx.host.storage.get(cache.SKILL_INDEX_KEY);
    expect(storedAfter.allIds).toEqual(["alpha", "beta", "gamma", ...core.BUILTIN_SKILLS].sort());
  });

  test("forceImmediateScan revalidates even when root mtime and revalidateAfterMs are fresh", async () => {
    fs.mkdirSync(fx.real("~/.config/opencode/skills/nested"), { recursive: true });
    const loader = counts.createStatusLoader(fx.host, { revalidateAfterMs: 60_000 });
    await loader.load(null);
    await new Promise((r) => setTimeout(r, 10));

    let listDirCalls = 0;
    const spiedHost = {
      ...fx.host,
      listDir: async (p) => {
        listDirCalls++;
        return fx.host.listDir(p);
      },
    };

    let revalidated = null;
    const done = new Promise((r) => {
      revalidated = r;
    });
    const warmLoader = counts.createStatusLoader(spiedHost, {
      revalidateAfterMs: 60_000,
      onRevalidated: (c) => revalidated(c),
    });

    // Add a skill under an already-existing subfolder so top-level root size and mtime stay unchanged
    fx.put("~/.config/opencode/skills/nested/delta/SKILL.md", skillMd("Delta"));

    // Ordinary forceScan within 60s window does NOT scan when rootStamps match
    await warmLoader.load(null, { forceScan: true });
    expect(listDirCalls).toBe(0);

    // forceImmediateScan (e.g. { full: true } ping) DOES scan immediately in background
    await warmLoader.load(null, { forceScan: true, forceImmediateScan: true });
    const fresh = await done;
    expect(listDirCalls).toBeGreaterThan(0);
    expect(fresh.installed).toBe(3 + core.BUILTIN_SKILLS.length);
  });

  test("incomplete discovery (DENIED on a skill root) is NOT persisted to host.storage", async () => {
    fx.failOn = (p, op) => op === "list" && p.includes(".claude/skills");
    const loader = counts.createStatusLoader(fx.host);
    const res = await loader.load(null);
    expect(res.installed).toBe(2 + core.BUILTIN_SKILLS.length);
    await new Promise((r) => setTimeout(r, 10));

    const stored = await fx.host.storage.get(cache.SKILL_INDEX_KEY);
    expect(stored).toBeUndefined();
  });

  test("race: switching directory while background onRevalidated readCounts is pending never overwrites newer directory counts", async () => {
    const projA = `${home}/work/proj-a`;
    const projB = `${home}/work/proj-b`;
    fs.mkdirSync(fx.real(projA), { recursive: true });
    fs.mkdirSync(fx.real(projB), { recursive: true });
    fx.put(
      "~/.config/opencode/skill-bundles.json",
      core.serializeBundles(
        core.parseBundles(
          JSON.stringify({
            version: 1,
            bundles: [{ id: "only-a", name: "Only A", enabled: false, skills: ["alpha", "beta", "gamma"], projects: [projA] }],
            overrides: {},
          }),
          { home },
        ),
      ),
    );

    // Seed storage cache before adding gamma
    const seedLoader = counts.createStatusLoader(fx.host);
    await seedLoader.load(projA);
    await new Promise((r) => setTimeout(r, 10));

    // Add gamma and bump root mtime
    fx.put("~/.config/opencode/skills/gamma/SKILL.md", skillMd("Gamma"));
    const bumped = new Date(Date.now() + 5_000);
    fs.utimesSync(fx.real("~/.config/opencode/skills"), bumped, bumped);
    fx.put(
      `${projA}/.opencode/opencode.json`,
      JSON.stringify({
        permissions: [
          { action: "skill", resource: "alpha", effect: "allow" },
          { action: "skill", resource: "beta", effect: "allow" },
          { action: "skill", resource: "gamma", effect: "allow" },
        ],
      }) + "\n",
    );

    let gateNextProjARead = false;
    let enteredBgRead;
    const bgReadStarted = new Promise((r) => {
      enteredBgRead = r;
    });
    let releaseProjARead;
    const projAReadGate = new Promise((r) => {
      releaseProjARead = r;
    });

    const host = {
      ...fx.host,
      listDir: async (p) => {
        const res = await fx.host.listDir(p);
        // Once background discovery lists skills, gate the subsequent readCounts(projA) project file read
        gateNextProjARead = true;
        return res;
      },
      readFile: async (p) => {
        if (gateNextProjARead && p.endsWith("proj-a/.opencode/opencode.json")) {
          gateNextProjARead = false;
          enteredBgRead();
          await projAReadGate;
        }
        return fx.host.readFile(p);
      },
    };

    const painted = [];
    const loader = counts.createStatusLoader(host, {
      onRevalidated: (c) => painted.push(c),
    });

    // 1. Load projA -> returns optimistic 2 live, starts background scan
    const cA = await loader.load(projA);
    expect(cA.live).toBe(2);
    painted.push(cA);

    // 2. Wait until background scan updated idCache and paused inside readCounts(projA)
    await bgReadStarted;

    // 3. Switch to projB -> uses fresh idCache (3 + builtins installed, 0 live in projB)
    const cB = await loader.load(projB);
    expect(cB.live).toBe(0);
    expect(cB.installed).toBe(3 + core.BUILTIN_SKILLS.length);
    painted.push(cB);

    // 4. Release stale readCounts(projA) -> must NOT fire onRevalidated and overwrite projB
    releaseProjARead();
    await new Promise((r) => setTimeout(r, 20));
    expect(painted.at(-1).live).toBe(0);
    expect(painted.at(-1).installed).toBe(3 + core.BUILTIN_SKILLS.length);
  });

  test("race: obsolete background scan from old roots never overwrites newer roots cache or storage", async () => {
    const seedLoader = counts.createStatusLoader(fx.host);
    await seedLoader.load(null);
    await new Promise((r) => setTimeout(r, 10));

    // Bump default skills root mtime to trigger background scan on old roots
    const bumped = new Date(Date.now() + 5_000);
    fs.utimesSync(fx.real("~/.config/opencode/skills"), bumped, bumped);

    let pauseOldScan = true;
    let enteredOldScan;
    const oldScanStarted = new Promise((r) => {
      enteredOldScan = r;
    });
    let releaseOldScan;
    const oldScanGate = new Promise((r) => {
      releaseOldScan = r;
    });

    const host = {
      ...fx.host,
      listDir: async (p) => {
        if (pauseOldScan && p.endsWith(".config/opencode/skills")) {
          pauseOldScan = false;
          enteredOldScan();
          await oldScanGate;
        }
        return fx.host.listDir(p);
      },
    };

    const revalidated = [];
    const loader = counts.createStatusLoader(host, {
      onRevalidated: (c) => revalidated.push(c),
    });

    // 1. Trigger warm load on old roots -> starts background scan that pauses in listDir
    await loader.load(null);
    await oldScanStarted;

    // 2. Add a custom extra root with skill "zeta" in opencode.json and run a new load()
    fx.put("~/extra-skills/zeta/SKILL.md", skillMd("Zeta"));
    fx.put("~/.config/opencode/opencode.json", JSON.stringify({ skills: ["~/extra-skills"], permissions: [] }) + "\n");
    const newCounts = await loader.load(null);
    expect(newCounts.installed).toBe(3 + core.BUILTIN_SKILLS.length);
    await new Promise((r) => setTimeout(r, 10));

    // 3. Release the obsolete background scan from the old roots -> must NOT clobber storage or emit stale counts
    releaseOldScan();
    await new Promise((r) => setTimeout(r, 20));
    expect(revalidated).toEqual([]);
    const stored = await fx.host.storage.get(cache.SKILL_INDEX_KEY);
    expect(stored.allIds).toContain("zeta");
    expect(stored.installed ?? stored.allIds.length).toBe(3 + core.BUILTIN_SKILLS.length);
  });
});
