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
const { createFakeHost } = await import("../shared/test/fake-host.js");

const skillMd = (desc) => `---\nname: x\ndescription: ${desc}\n---\nBody\n`;

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
