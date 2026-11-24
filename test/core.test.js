import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as core from "../src/core.js";

const fx = (n) => readFileSync(fileURLToPath(new URL(`./fixtures/core/${n}`, import.meta.url)), "utf8");
const seedText = readFileSync(fileURLToPath(new URL("../data/default-bundles.json", import.meta.url)), "utf8");
const OPENCODE = fx("opencode.json");
const ARCHIFY = fx("archify.SKILL.md");
const IDEM = fx("idempotent.SKILL.md");

const S = (o = {}) => core.parseBundles(JSON.stringify({ version: 1, bundles: [], overrides: {}, ...o }));
const base = () => S({
  bundles: [
    { id: "a", name: "A", enabled: true, skills: ["x", "y"] },
    { id: "b", name: "B", enabled: false, skills: ["y", "z"] },
  ],
});

test("constants", () => {
  assert.equal(core.BUNDLES_PATH, "~/.config/opencode/skill-bundles.json");
  assert.equal(core.OPENCODE_PATH, "~/.config/opencode/opencode.json");
  assert.equal(core.SKILLS_DIR, "~/.config/opencode/skills");
  assert.deepEqual(core.BUILTIN_SKILLS, ["opencode", "report"]);
});

test("parseBundles normalizes and round-trips the seed", () => {
  const s = core.parseBundles(seedText);
  assert.equal(s.version, 1);
  assert.ok(s.bundles.length >= 2);
  assert.deepEqual(core.parseBundles(core.serializeBundles(s)), s);
  assert.ok(core.serializeBundles(s).endsWith("}\n"));
  const n = S({ bundles: [{ id: "q", skills: ["a", "a"] }] });
  assert.deepEqual(n.bundles[0], { id: "q", name: "q", enabled: false, skills: ["a"] });
});

test("parseBundles rejects bad schema with clear messages", () => {
  assert.throws(() => core.parseBundles("{"), /not valid JSON/);
  assert.throws(() => core.parseBundles("[]"), /must be a JSON object/);
  assert.throws(() => core.parseBundles('{"version":2,"bundles":[]}'), /version/);
  assert.throws(() => core.parseBundles('{"version":1}'), /bundles/);
  assert.throws(() => S({ bundles: [{ id: "" }] }), /id/);
  assert.throws(() => S({ bundles: [{ id: "a" }, { id: "a" }] }), /duplicated/);
  assert.throws(() => S({ bundles: [{ id: "__unbundled" }] }), /reserved/);
  assert.throws(() => S({ bundles: [{ id: "a", skills: [1] }] }), /skills/);
  assert.throws(() => S({ bundles: [{ id: "a", enabled: "yes" }] }), /enabled/);
  assert.throws(() => S({ overrides: { x: "maybe" } }), /overrides/);
  assert.throws(() => S({ overrides: [] }), /overrides/);
});

test("effectiveMode", () => {
  let s = base();
  assert.equal(core.effectiveMode(s, "x"), "auto");
  assert.equal(core.effectiveMode(s, "y"), "auto");
  assert.equal(core.effectiveMode(s, "z"), "off");
  assert.equal(core.effectiveMode(s, "nope"), "off");
  s = core.setOverride(s, "x", "called");
  assert.equal(core.effectiveMode(s, "x"), "called");
  s = core.setOverride(s, "z", "auto");
  assert.equal(core.effectiveMode(s, "z"), "auto");
  s = core.setOverride(s, "opencode", "called");
  assert.equal(core.effectiveMode(s, "opencode"), "auto");
});

test("scope normalization catches invalid home and falls back to global mode", () => {
  const opts = { home: "/home/../bad", projectDir: "/project" };
  assert.equal(core.normalizeScopeDir(opts.projectDir, opts), null);
  assert.equal(core.normalizeScopeDir("/home/u/project//.", { home: "/home/u" }), "~/project");
  const bundle = { id: "a", enabled: false, skills: ["x"], projects: ["/project"] };
  assert.equal(core.isBundleActive(bundle, opts), false);
  assert.equal(core.effectiveMode(S({ bundles: [bundle] }), "x", opts), "off");
});

test("Windows drive paths are absolute project dirs with one spelling", () => {
  // "E:/x" is absolute on Windows; treating it as project-relative made every project unusable there.
  assert.equal(core.normalizeProjectDir("E:/Coding/app"), "E:/Coding/app");
  assert.equal(core.normalizeProjectDir("e:\\Coding\\app"), "E:/Coding/app");
  assert.equal(core.normalizeProjectDir("E:/Coding//app/./"), "E:/Coding/app");
  assert.equal(core.normalizeProjectDir("E:"), "E:/");
  assert.equal(core.projectConfigPath("e:/Coding/app"), "E:/Coding/app/.opencode/opencode.json");
  assert.equal(core.sameProjectDir("E:/Coding/app", "e:/Coding/app"), true);
  assert.throws(() => core.normalizeProjectDir("E:/a/../b"), /must not contain/);
  assert.throws(() => core.normalizeProjectDir("coding/app"), /must be absolute/);
  // No `~` collapse without a usable home: the stored spelling stays absolute.
  assert.equal(core.normalizeScopeDir("E:/Coding/app", { home: "C:/Users/u" }), "E:/Coding/app");
  assert.equal(core.normalizeScopeDir("C:/Users/u/.config/openchamber/chats/1", { home: "C:/Users/u" }), null);
  const state = core.parseBundles(JSON.stringify({ version: 1, bundles: [{ id: "a", name: "A", enabled: false, skills: ["x"], projects: ["e:/Coding/app"] }] }));
  assert.deepEqual(state.bundles[0].projects, ["E:/Coding/app"]);
  assert.equal(core.isBundleActive(state.bundles[0], { projectDir: "E:/Coding/app", home: "C:/Users/u" }), true);
});

test("bulk mode lookups preserve invalid/inherited overrides and builtin called modes", () => {
  const state = base();
  state.overrides = Object.assign(Object.create({ z: "auto" }), {
    x: "invalid", y: "called", opencode: "called", report: "off",
  });
  const ids = ["x", "y", "z", "opencode", "report"];
  assert.deepEqual(core.summary(state, ids), { on: 3, auto: 2, called: 1, chars: 2 * core.CHARS_PER_SKILL });
  const permissions = JSON.parse(core.applyPermissions("{}", state, ids)).permissions;
  assert.deepEqual(permissions.filter((r) => r.effect === "allow").map((r) => r.resource), ["opencode", "x", "y"]);
  const md = "---\nname: example\n---\nbody\n";
  const plan = core.syncPlan(state, ids, Object.fromEntries(ids.map((id) => [id, md])));
  assert.deepEqual(plan.skillEdits.map((edit) => edit.id), ["y"]);
  const next = core.setOverride(core.setOverride(state, "x", "off"), "z", "auto");
  const changed = JSON.parse(core.applyPermissions('{"permissions":[]}', next, ids, { prevState: state })).permissions;
  assert.deepEqual(changed, [
    { action: "skill", resource: "x", effect: "deny" },
    { action: "skill", resource: "z", effect: "allow" },
  ]);
});

test("groups: stored order then __unbundled", () => {
  const g = core.groups(base(), ["z", "w", "x", "v", "y"]);
  assert.deepEqual(g.map((x) => x.id), ["a", "b", "__unbundled"]);
  assert.deepEqual(g[2].skills, ["v", "w"]);
  assert.equal(g[2].synthetic, true);
  assert.equal(g[2].enabled, false);
});

test("setBundleEnabled is immutable and clears overrides for its skills", () => {
  const s0 = core.setOverride(core.setOverride(base(), "z", "called"), "x", "off");
  const s1 = core.setBundleEnabled(s0, "b", true);
  assert.equal(s0.bundles[1].enabled, false);
  assert.equal(s1.bundles[1].enabled, true);
  assert.deepEqual({ ...s1.overrides }, { x: "off" });
  assert.deepEqual({ ...s0.overrides }, { z: "called", x: "off" });
  assert.throws(() => core.setBundleEnabled(s0, "nope", true), /Unknown bundle/);
});

test("setOverride", () => {
  const s = core.setOverride(base(), "x", "off");
  assert.equal(s.overrides.x, "off");
  assert.deepEqual({ ...core.setOverride(s, "x", null).overrides }, {});
  assert.throws(() => core.setOverride(s, "x", "bad"), /Invalid mode/);
});

test("moveSkill: move, copy, dedupe, no-op, unbundled", () => {
  const s = base();
  assert.equal(core.moveSkill(s, "x", "a", "a"), s);
  const m = core.moveSkill(s, "x", "a", "b");
  assert.deepEqual(m.bundles[0].skills, ["y"]);
  assert.deepEqual(m.bundles[1].skills, ["y", "z", "x"]);
  const c = core.moveSkill(s, "x", "a", "b", { copy: true });
  assert.deepEqual(c.bundles[0].skills, ["x", "y"]);
  assert.deepEqual(c.bundles[1].skills, ["y", "z", "x"]);
  const d = core.moveSkill(s, "y", "a", "b");
  assert.deepEqual(d.bundles[1].skills, ["y", "z"]);
  assert.deepEqual(d.bundles[0].skills, ["x"]);
  const u = core.moveSkill(s, "new", "__unbundled", "a");
  assert.deepEqual(u.bundles[0].skills, ["x", "y", "new"]);
  const r = core.moveSkill(s, "x", "a", "__unbundled");
  assert.deepEqual(r.bundles[0].skills, ["y"]);
  assert.deepEqual(s.bundles[0].skills, ["x", "y"]);
});

test("create / rename / delete bundle", () => {
  let s = core.createBundle(base(), "My Bundle!");
  assert.equal(s.bundles[2].id, "my-bundle");
  assert.equal(s.bundles[2].name, "My Bundle!");
  s = core.createBundle(s, "my bundle");
  assert.equal(s.bundles[3].id, "my-bundle-2");
  assert.equal(core.createBundle(base(), "A").bundles[2].id, "a-2");
  assert.throws(() => core.createBundle(base(), "  "), /empty/);
  const r = core.renameBundle(base(), "a", "Alpha");
  assert.equal(r.bundles[0].id, "a");
  assert.equal(r.bundles[0].name, "Alpha");
  const d = core.deleteBundle(base(), "a");
  assert.deepEqual(d.bundles.map((b) => b.id), ["b"]);
  assert.deepEqual(core.groups(d, ["x", "y", "z"]).at(-1).skills, ["x"]);
  assert.throws(() => core.deleteBundle(base(), "zz"), /Unknown/);
});

test("applyPermissions on fixture opencode.json", () => {
  const seed = core.parseBundles(seedText);
  const allIds = [...new Set(seed.bundles.flatMap((b) => b.skills))];
  const out = core.applyPermissions(OPENCODE, seed, allIds);
  const before = JSON.parse(OPENCODE);
  const after = JSON.parse(out);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const k of Object.keys(before)) if (k !== "permissions") assert.deepEqual(after[k], before[k]);
  assert.ok(out.endsWith("\n") && out.includes('\n  "permissions": ['));
  const skillRules = after.permissions.filter((r) => r.action === "skill");
  assert.deepEqual(skillRules[0], { action: "skill", resource: "*", effect: "deny" });
  const allows = skillRules.slice(1).map((r) => r.resource);
  assert.deepEqual(allows, [...allows].sort());
  const expected = allIds.filter((id) => core.effectiveMode(seed, id) !== "off").sort();
  assert.deepEqual(allows, expected);
  // seed reproduces today's hand-written rules, minus report/duckduckgo-search
  const old = before.permissions.filter((r) => r.action === "skill" && r.effect === "allow").map((r) => r.resource);
  const oldSet = new Set(old.filter((x) => x !== "report" && x !== "duckduckgo-search"));
  assert.deepEqual(new Set(allows), oldSet);
  assert.equal(core.applyPermissions(out, seed, allIds), out);
});

test("applyPermissions keeps non-skill rules in order and handles missing array", () => {
  const txt = JSON.stringify({ a: 1, permissions: [
    { action: "bash", resource: "*", effect: "ask" },
    { action: "skill", resource: "old", effect: "allow" },
    { action: "edit", resource: "x", effect: "deny" },
  ], z: 2 });
  const s = core.setOverride(base(), "z", "called");
  const out = JSON.parse(core.applyPermissions(txt, s, ["x", "y", "z", "w"]));
  assert.deepEqual(Object.keys(out), ["a", "permissions", "z"]);
  assert.deepEqual(out.permissions.map((r) => r.resource), ["*", "x", "*", "x", "y", "z"]);
  assert.deepEqual(out.permissions.slice(0, 2).map((r) => r.action), ["bash", "edit"]);
  const none = JSON.parse(core.applyPermissions('{"a":1}', base(), ["x"]));
  assert.deepEqual(Object.keys(none), ["a", "permissions"]);
  assert.deepEqual(none.permissions.map((r) => r.resource), ["*", "x"]);
  assert.throws(() => core.applyPermissions("nope", base(), []), /opencode.json/);
});

test("applyPermissions is textual: non-permission bytes untouched (\\u00b7 escapes)", () => {
  const src = fx("escapes.opencode.json");
  const out = core.applyPermissions(src, base(), ["x", "y", "z"]);
  const pStart = src.indexOf('"permissions": ') + '"permissions": '.length;
  const pEnd = src.indexOf("\n  ],") + "\n  ]".length;
  assert.equal(out.slice(0, pStart), src.slice(0, pStart));
  assert.ok(out.endsWith(src.slice(pEnd)));
  assert.ok(out.includes("gpt\\u00b7mini") && out.includes('"x\\u00b7y"'));
  const j = JSON.parse(out);
  assert.deepEqual(j.permissions.map((r) => r.resource), ["*", "*", "x", "y"]);
  assert.equal(core.applyPermissions(out, base(), ["x", "y", "z"]), out);
  const ins = core.applyPermissions('{\n  "a": "\\u00b7"\n}\n', base(), ["x"]);
  assert.ok(ins.startsWith('{\n  "a": "\\u00b7",\n  "permissions": [\n    {\n      "action"'));
  assert.ok(ins.endsWith("\n  ]\n}\n"));
  assert.deepEqual(JSON.parse(core.applyPermissions("{}", base(), [])).permissions.length, 1);
  const crlf = core.applyPermissions('{\r\n  "permissions": []\r\n}\r\n', base(), ["x"]);
  assert.ok(!/[^\r]\n/.test(crlf));
});

test("readFrontmatter on fixtures", () => {
  const a = core.readFrontmatter(ARCHIFY);
  assert.deepEqual(a, { description: "Validated interactive HTML diagrams, upstream-maintained.", autoinvoke: true, hasFrontmatter: true });
  const i = core.readFrontmatter(IDEM);
  assert.equal(i.autoinvoke, true);
  assert.equal(i.description, "Design idempotent retries, keys, and state transitions.");
  assert.deepEqual(core.readFrontmatter("# hi\n"), { description: "", autoinvoke: true, hasFrontmatter: false });
});

test("readFrontmatter: disable-model-invocation and precedence", () => {
  assert.equal(core.readFrontmatter("---\nname: a\ndisable-model-invocation: true\n---\n").autoinvoke, false);
  assert.equal(core.readFrontmatter("---\ndisable-model-invocation: true\nmetadata:\n  opencode/autoinvoke: true\n---\n").autoinvoke, true);
  assert.equal(core.readFrontmatter("---\nmetadata:\n  opencode/autoinvoke: false\n---\n").autoinvoke, false);
  assert.equal(core.readFrontmatter("---\ndescription: \"a: b\"\n---\n").description, "a: b");
  assert.equal(core.readFrontmatter("---\ndescription: 'it''s'\n---\n").description, "it's");
  assert.equal(core.readFrontmatter("---\ndescription: >\n  one\n  two\n---\n").description, "one two");
});

test("setAutoinvoke(false/true) on archify: surgical and idempotent", () => {
  const off = core.setAutoinvoke(ARCHIFY, false);
  assert.ok(off.includes("metadata:\n  opencode/autoinvoke: false\n  info:\n    tags:"));
  assert.equal(core.readFrontmatter(off).autoinvoke, false);
  assert.equal(core.setAutoinvoke(off, false), off);
  const on = core.setAutoinvoke(off, true);
  assert.equal(on, ARCHIFY);
  assert.equal(core.setAutoinvoke(on, true), ARCHIFY);
});

test("setAutoinvoke on idempotent fixture adds metadata block before closing ---", () => {
  const off = core.setAutoinvoke(IDEM, false);
  assert.ok(off.includes("disable-model-invocation: false\nmetadata:\n  opencode/autoinvoke: false\n---\n"));
  assert.equal(core.readFrontmatter(off).autoinvoke, false);
  assert.equal(core.setAutoinvoke(off, false), off);
  const back = core.setAutoinvoke(off, true);
  assert.equal(core.readFrontmatter(back).autoinvoke, true);
  assert.ok(!back.includes("opencode/autoinvoke"));
  assert.equal(back.replace("metadata:\n", ""), IDEM);
});

test("setAutoinvoke: no frontmatter, CRLF, dmi true", () => {
  const off = core.setAutoinvoke("# Body\n", false);
  assert.equal(off, "---\nmetadata:\n  opencode/autoinvoke: false\n---\n# Body\n");
  assert.equal(core.setAutoinvoke("# Body\n", true), "# Body\n");
  const crlf = "---\r\nname: a\r\nmetadata:\r\n  x: 1\r\n---\r\nbody\r\n";
  const c = core.setAutoinvoke(crlf, false);
  assert.equal(c, "---\r\nname: a\r\nmetadata:\r\n  opencode/autoinvoke: false\r\n  x: 1\r\n---\r\nbody\r\n");
  assert.equal(core.setAutoinvoke(c, true), crlf);
  const dmi = "---\ndisable-model-invocation: true\n---\n";
  assert.equal(core.readFrontmatter(core.setAutoinvoke(dmi, true)).autoinvoke, true);
  assert.equal(core.setAutoinvoke(dmi, false), dmi);
});

test("setDescription", () => {
  const d = core.setDescription(ARCHIFY, "New text");
  assert.equal(d, ARCHIFY.replace("description: Validated interactive HTML diagrams, upstream-maintained.", "description: New text"));
  for (const t of ["a: b", "has # hash", "- dash", "say \"hi\"", "it's", "* star", "true", "[x]"]) {
    const out = core.setDescription(IDEM, t);
    assert.equal(core.readFrontmatter(out).description, t, t);
    assert.match(out, /^description: "/m, t);
  }
  assert.equal(core.readFrontmatter(core.setDescription(IDEM, "line1\nline2")).description, "line1 line2");
  const blk = core.setDescription("---\nname: a\ndescription: >\n  old\n  text\nother: 1\n---\n", "x");
  assert.equal(blk, "---\nname: a\ndescription: x\nother: 1\n---\n");
  assert.equal(core.setDescription("---\nname: a\n---\nb", "x"), "---\nname: a\ndescription: x\n---\nb");
  assert.equal(core.setDescription("body", "x"), "---\ndescription: x\n---\nbody");
  assert.equal(core.setDescription("---\r\ndescription: o\r\n---\r\n", "n"), "---\r\ndescription: n\r\n---\r\n");
});

test("syncPlan: edits only changed SKILL.md, skips builtins", () => {
  let s = S({ bundles: [{ id: "a", enabled: true, skills: ["archify", "idem", "opencode", "gone"] }] });
  s = core.setOverride(s, "archify", "called");
  s = core.setOverride(s, "opencode", "called");
  const mds = {
    archify: ARCHIFY,
    idem: core.setAutoinvoke(IDEM, false),
    opencode: "---\n---\n",
  };
  const plan = core.syncPlan(s, ["archify", "idem", "opencode", "gone"], mds);
  assert.deepEqual(plan.skillEdits.map((e) => e.id).sort(), ["archify", "idem"]);
  const byId = Object.fromEntries(plan.skillEdits.map((e) => [e.id, e.next]));
  assert.equal(core.readFrontmatter(byId.archify).autoinvoke, false);
  assert.equal(core.readFrontmatter(byId.idem).autoinvoke, true);
  const oc = JSON.parse(plan.opencode('{"permissions":[]}'));
  assert.deepEqual(oc.permissions.map((r) => r.resource), ["*", "archify", "gone", "idem", "opencode"]);
  const again = core.syncPlan(s, Object.keys(mds), { archify: byId.archify, idem: byId.idem });
  assert.deepEqual(again.skillEdits, []);
});

// ---------- regression tests (review round 1) ----------

test("R2 applyPermissions throws on non-array permissions", () => {
  for (const v of ['{"a":1}', '"x"', "null", "3"]) {
    assert.throws(() => core.applyPermissions(`{"permissions": ${v}}`, base(), ["x"]), /not an array/);
  }
});

test("R3 applyPermissions throws on duplicate top-level keys incl. escaped spellings", () => {
  assert.throws(() => core.applyPermissions('{"permissions":[],"permissions":[]}', base(), []), /duplicate top-level key/);
  assert.throws(() => core.applyPermissions('{"permissions":[],"permission\\u0073":[]}', base(), []), /duplicate/);
  assert.throws(() => core.applyPermissions('{"a":1,"\\u0061":2}', base(), []), /duplicate/);
  // nested duplicates are not our concern
  assert.doesNotThrow(() => core.applyPermissions('{"x":{"permissions":1},"permissions":[]}', base(), []));
});

test("R4 nested metadata.info.opencode/autoinvoke is not treated or removed as ours", () => {
  const md = "---\nname: a\nmetadata:\n  info:\n    opencode/autoinvoke: false\n---\nbody\n";
  assert.equal(core.readFrontmatter(md).autoinvoke, true);
  assert.equal(core.setAutoinvoke(md, true), md);
  const off = core.setAutoinvoke(md, false);
  assert.equal(off, "---\nname: a\nmetadata:\n  opencode/autoinvoke: false\n  info:\n    opencode/autoinvoke: false\n---\nbody\n");
  assert.equal(core.setAutoinvoke(off, true), md);
});

test("R4 removing the line does not edit body lines (bounds recomputed)", () => {
  const md = "---\nmetadata:\n  opencode/autoinvoke: false\ndisable-model-invocation: true\n---\ndisable-model-invocation: true\n";
  const on = core.setAutoinvoke(md, true);
  assert.equal(on, "---\nmetadata:\ndisable-model-invocation: false\n---\ndisable-model-invocation: true\n");
  assert.equal(core.readFrontmatter(on).autoinvoke, true);
});

test("R5 unsupported layouts throw instead of writing", () => {
  const flow = "---\nname: a\nmetadata: {info: 1}\n---\n";
  assert.throws(() => core.setAutoinvoke(flow, false), /flow-style/);
  assert.throws(() => core.setDescription(flow, "x"), /not supported/);
  assert.throws(() => core.readFrontmatter("---\nmetadata: {opencode/autoinvoke: false}\n---\n"), /flow-style/);
  const indented = "---\n  name: a\n  description: b\n---\n";
  assert.throws(() => core.setAutoinvoke(indented, false), /indented/);
  const odd = "---\nmetadata:\n    a: 1\n  b: 2\n---\n";
  assert.throws(() => core.setAutoinvoke(odd, false), /inconsistent indentation/);
  const tabs = "---\nmetadata:\n\ta: 1\n---\n";
  assert.throws(() => core.setAutoinvoke(tabs, false), /tab/);
});

test("R5 unindented comments between metadata children keep the block intact", () => {
  const md = "---\nmetadata:\n  a: 1\n# note\n  b: 2\n---\n";
  const off = core.setAutoinvoke(md, false);
  assert.equal(off, "---\nmetadata:\n  opencode/autoinvoke: false\n  a: 1\n# note\n  b: 2\n---\n");
  assert.equal(core.setAutoinvoke(off, false), off);
  const md2 = "---\nmetadata:\n  a: 1\n# note\n  opencode/autoinvoke: false\n---\n";
  assert.equal(core.readFrontmatter(md2).autoinvoke, false);
  assert.equal(core.setAutoinvoke(md2, true), "---\nmetadata:\n  a: 1\n# note\n---\n");
  // custom 4-space child indent is respected
  assert.equal(core.setAutoinvoke("---\nmetadata:\n    a: 1\n---\n", false), "---\nmetadata:\n    opencode/autoinvoke: false\n    a: 1\n---\n");
});

test("R7 prototype-like ids are plain data", () => {
  const s = base();
  for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(core.effectiveMode(s, id), "off", id);
    const t = core.setOverride(s, id, "auto");
    assert.equal(core.effectiveMode(t, id), "auto", id);
    assert.equal(core.effectiveMode(core.setOverride(t, id, null), id), "off", id);
    assert.equal(core.effectiveMode(s, id), "off", id);
  }
  const p = core.parseBundles('{"version":1,"bundles":[],"overrides":{"__proto__":"called","constructor":"auto"}}');
  assert.equal(core.effectiveMode(p, "__proto__"), "called");
  assert.equal(core.effectiveMode(p, "constructor"), "auto");
  assert.equal(core.effectiveMode(p, "toString"), "off");
  assert.deepEqual(JSON.parse(core.serializeBundles(p)).overrides, JSON.parse('{"__proto__":"called","constructor":"auto"}'));
  assert.equal({}.polluted, undefined);
  const perms = JSON.parse(core.applyPermissions("{}", s, ["toString", "constructor"])).permissions;
  assert.deepEqual(perms.map((r) => r.resource), ["*"]);
  const plan = core.syncPlan(s, ["toString"], {});
  assert.deepEqual(plan.skillEdits, []);
});

test("R8 setDescription replaces plain multiline continuation lines", () => {
  const md = "---\nname: a\ndescription: first part\n  second part\n  third\nversion: 1\n---\nbody\n";
  assert.equal(core.readFrontmatter(md).description, "first part second part third");
  assert.equal(core.setDescription(md, "new"), "---\nname: a\ndescription: new\nversion: 1\n---\nbody\n");
  const q = '---\ndescription: "a\n  b"\nx: 1\n---\n';
  assert.throws(() => core.setDescription(q, "n"), /multi-line quoted scalar/);
  const blk = "---\ndescription: |\n  l1\n\n  l2\n\nx: 1\n---\n";
  assert.equal(core.setDescription(blk, "n"), "---\ndescription: n\n\nx: 1\n---\n");
});

// ---------- regression tests (review round 2) ----------

test("RB quoted reserved keys are unsupported", () => {
  for (const md of [
    '---\n"metadata":\n  a: 1\n---\n',
    "---\n'description': x\n---\n",
    '---\nmetadata:\n  "opencode/autoinvoke": false\n---\n',
    "---\n'disable-model-invocation': true\n---\n",
  ]) {
    assert.throws(() => core.readFrontmatter(md), /quoted key/, md);
    assert.throws(() => core.setAutoinvoke(md, false), /quoted key/, md);
    assert.throws(() => core.setAutoinvoke(md, true), /quoted key/, md);
    assert.throws(() => core.setDescription(md, "x"), /quoted key/, md);
  }
  assert.doesNotThrow(() => core.readFrontmatter('---\n"other": 1\n---\n'));
});

test("RF layout validated first; no early no-op; syncPlan surfaces errors", () => {
  const flow = "---\nmetadata: {opencode/autoinvoke: false}\n---\n";
  assert.throws(() => core.readFrontmatter(flow), /not supported/);
  assert.throws(() => core.setAutoinvoke(flow, true), /not supported/);
  assert.throws(() => core.setAutoinvoke(flow, false), /not supported/);
  const dup = "---\nmetadata:\n  opencode/autoinvoke: false\n  opencode/autoinvoke: false\n---\n";
  assert.throws(() => core.setAutoinvoke(dup, false), /duplicate/);
  const s = core.setOverride(S(), "bad", "called");
  assert.throws(() => core.syncPlan(s, ["bad"], { bad: flow }), /skills\/bad\/SKILL\.md.*not supported/);
  const s2 = core.setOverride(S(), "bad", "auto");
  assert.throws(() => core.syncPlan(s2, ["bad"], { bad: flow }), /not supported/);
});

test("RH setAutoinvoke(true) removes a direct opencode/autoinvoke: true line", () => {
  const md = "---\nname: a\nmetadata:\n  opencode/autoinvoke: true\n  x: 1\n---\n";
  assert.equal(core.setAutoinvoke(md, true), "---\nname: a\nmetadata:\n  x: 1\n---\n");
  const plan = core.syncPlan(core.setOverride(S(), "a", "auto"), ["a"], { a: md });
  assert.deepEqual(plan.skillEdits, [{ id: "a", next: "---\nname: a\nmetadata:\n  x: 1\n---\n" }]);
});

// ---------- regression tests (real-skill compatibility) ----------

test("compact sequences at column 0 under a valueless root key are accepted", () => {
  const md = fx("compact-seq.SKILL.md");
  const fm = core.readFrontmatter(md);
  assert.equal(fm.description, "Define an AI agent's purpose, boundaries, and priorities.");
  assert.equal(fm.autoinvoke, true);
  const off = core.setAutoinvoke(md, false);
  assert.ok(off.endsWith("metadata:\n  opencode/autoinvoke: false\n---\n\n# Ethos explore\n\nBody.\n"));
  assert.equal(core.readFrontmatter(off).autoinvoke, false);
  assert.equal(core.setAutoinvoke(core.setAutoinvoke(off, true), false), off);
  const d = core.setDescription(md, "New: text");
  assert.equal(d, md.replace(/^description: .*$/m, 'description: "New: text"'));
  // a description block followed by a compact list key is not swallowed
  const small = "---\ndescription: x\ntriggers:\n- a\n- b\nnot-for:\n- c\n  more\nname: n\n---\n";
  assert.equal(core.setDescription(small, "y"), small.replace("description: x", "description: y"));
  assert.equal(core.readFrontmatter(small).description, "x");
  assert.equal(core.setAutoinvoke(small, false), small.replace("---\n", "---\n").replace("name: n\n---", "name: n\nmetadata:\n  opencode/autoinvoke: false\n---"));
});

test("column-0 list items not under a valueless key are still rejected", () => {
  for (const md of [
    "---\n- a\nname: x\n---\n",
    "---\nname: x\n- a\n---\n",
    "---\ntags: [a]\n- b\n---\n",
    "---\ndescription: hi\n- b\n---\n",
    "---\nmetadata:\n- a\n---\n",
  ]) {
    assert.throws(() => core.readFrontmatter(md), /not supported/, md);
    assert.throws(() => core.setAutoinvoke(md, false), /not supported/, md);
  }
  assert.doesNotThrow(() => core.readFrontmatter("---\ntags: # comment\n- a\n---\n"));
});

// ---------- regression tests (review round 3) ----------

test("R3-2 escaped or reserved quoted keys are refused", () => {
  for (const md of [
    '---\n"meta\\u0064ata":\n  a: 1\n---\n',
    '---\n"other\\tkey": 1\n---\n',
    '---\nmetadata:\n  "opencode\\/autoinvoke": false\n---\n',
    "---\n'descr''iption': x\n---\n".replace("descr''iption", "description"),
    '---\nmetadata:\n  "disable-model-invocation": true\n---\n',
  ]) {
    assert.throws(() => core.readFrontmatter(md), /quoted key/, md);
    assert.throws(() => core.setAutoinvoke(md, false), /quoted key/, md);
  }
  assert.doesNotThrow(() => core.readFrontmatter('---\n"plain key": 1\nmetadata:\n  "x y": 2\n---\n'));
});

test("R3-3 multi-line quoted scalars and trailing backslashes are refused", () => {
  for (const md of [
    '---\ndescription: "a\n  b"\n---\n',
    "---\nname: x\nother: 'it\n  continues'\ndescription: d\n---\n",
    '---\nmetadata:\n  info: "open\n    metadata: x"\n---\n',
    '---\ntags:\n- "open\n  y"\n---\n',
    '---\ndescription: d \\\n---\n',
  ]) {
    assert.throws(() => core.readFrontmatter(md), /not supported/, md);
    assert.throws(() => core.setAutoinvoke(md, false), /not supported/, md);
    assert.throws(() => core.setDescription(md, "z"), /not supported/, md);
  }
  // supported: single-line quoted (with escapes and # inside), plain multi-line, block scalars
  const ok = [
    '---\ndescription: "a: \\"b\\" # c" # comment\nx: \'it\'\'s\'\n---\n',
    "---\ndescription: plain\n  continued\n---\n",
    "---\ndescription: |\n  line with \"quote\n  and 'another\n  ends with \\\nname: n\n---\n",
    "---\ntags:\n- 'a'\n- \"b\"\n---\n",
  ];
  for (const md of ok) assert.doesNotThrow(() => core.setAutoinvoke(md, false), md);
  assert.equal(core.readFrontmatter(ok[0]).description, 'a: "b" # c');
});

test("R3-8 syncPlan skips unsupported SKILL.md for auto, throws for called or explicit opt-out", () => {
  const flow = "---\nmetadata: {info: 1}\n---\n";
  const auto = core.setOverride(S(), "f", "auto");
  const plan = core.syncPlan(auto, ["f", "ok"], { f: flow, ok: "---\nname: ok\n---\n" });
  assert.deepEqual(plan.skillEdits, []);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].id, "f");
  assert.match(plan.skipped[0].reason, /flow-style/);
  assert.ok(JSON.parse(plan.opencode("{}")).permissions.some((r) => r.resource === "f"));
  const called = core.setOverride(S(), "f", "called");
  assert.throws(() => core.syncPlan(called, ["f"], { f: flow }), /skills\/f\/SKILL\.md/);
  for (const optOut of [
    "---\nmetadata: {opencode/autoinvoke: false}\n---\n",
    '---\n"disable-model-invocation": true\n---\n',
    '---\nmetadata:\n  "opencode\\/autoinvoke": false\n---\n',
  ]) {
    assert.throws(() => core.syncPlan(auto, ["f"], { f: optOut }), /skills\/f\/SKILL\.md/, optOut);
  }
  assert.deepEqual(core.syncPlan(auto, ["ok"], { ok: "---\nname: ok\n---\n" }).skipped, []);
});

test("F3 unsupported layout mentioning autoinvoke / disable-model-invocation anywhere throws for auto", () => {
  const auto = core.setOverride(S(), "f", "auto");
  for (const md of [
    "---\nmetadata: {note: see opencode/autoinvoke}\n---\n",
    "---\nmetadata: {disable-model-invocation: maybe}\n---\n",
    "---\nmetadata: {x: 1}\ninfo: 'mentions autoinvoke\n  across lines'\n---\n",
  ]) {
    assert.throws(() => core.syncPlan(auto, ["f"], { f: md }), /skills\/f\/SKILL\.md/, md);
  }
  assert.equal(core.syncPlan(auto, ["f"], { f: "---\nmetadata: {x: 1}\n---\nbody mentions autoinvoke\n" }).skipped.length, 1);
});

// ---------- project copies ----------

test("projectCopies: absent stays absent on round-trip", () => {
  const s = base();
  assert.equal("projectCopies" in s, false);
  assert.equal(core.serializeBundles(s).includes("projectCopies"), false);
});

test("projectCopies: round-trips and validates", () => {
  const s = S({ projectCopies: { x: ["/p/a", "/p/a", "/p/b"], y: [] } });
  assert.deepEqual({ ...s.projectCopies }, { x: ["/p/a", "/p/b"] });
  const again = core.parseBundles(core.serializeBundles(s));
  assert.deepEqual({ ...again.projectCopies }, { x: ["/p/a", "/p/b"] });
  assert.throws(() => S({ projectCopies: [] }), /projectCopies/);
  assert.throws(() => S({ projectCopies: { x: [1] } }), /projectCopies\["x"\]/);
});

test("addProjectCopy is immutable and dedupes", () => {
  const s = base();
  const a = core.addProjectCopy(s, "x", "/p/a/");
  const b = core.addProjectCopy(a, "x", "/p/a");
  assert.equal(s.projectCopies, undefined);
  assert.deepEqual([...b.projectCopies.x], ["/p/a"]);
  assert.throws(() => core.addProjectCopy(s, "x", "rel/dir"), /absolute/);
});

test("markMovedToProject turns global off and records the copy", () => {
  const s = core.markMovedToProject(base(), "x", "/p/a");
  assert.equal(core.effectiveMode(s, "x"), "off");
  assert.deepEqual([...s.projectCopies.x], ["/p/a"]);
  assert.equal(s.bundles[0].skills.includes("x"), true);
});

test("projectSkillDir", () => {
  assert.equal(core.projectSkillDir("/home/u/proj/", "vite"), "/home/u/proj/.opencode/skills/vite");
  assert.throws(() => core.projectSkillDir("/p", "../x"));
  assert.throws(() => core.projectSkillDir("/p/../q", "x"));
});

test("isChatsDir / shortenDir / filterProjects / looksBinary", () => {
  assert.equal(core.isChatsDir("/home/u/.config/openchamber/chats/2026/s1"), true);
  assert.equal(core.isChatsDir("/home/u/Projects/chats"), false);
  assert.equal(core.shortenDir("/home/u/Projects/x", "/home/u"), "~/Projects/x");
  assert.equal(core.shortenDir("/srv/a/b/c"), "…/b/c");
  const ps = [{ id: "1", name: "Alpha", directory: "/a" }, { id: "2", name: "Beta", directory: "/srv/alpha2" }];
  assert.deepEqual(core.filterProjects(ps, "ALPHA").map((p) => p.id), ["1", "2"]);
  assert.equal(core.looksBinary("ok"), false);
  assert.equal(core.looksBinary("a\uFFFDb"), true);
});

// ---------- R1: planChange ----------

test("R1 planChange: order, kinds, paths, no-ops, seeding, error tags", () => {
  assert.deepEqual(core.PUBLISH_ORDER, ["skill", "project", "opencode", "bundles"]);
  const prevState = S({ bundles: [{ id: "a", enabled: true, skills: ["zeta", "archify"] }] });
  const prev = {
    bundlesText: core.serializeBundles(prevState),
    opencodeText: core.applyPermissions('{"permissions":[]}\n', prevState, ["zeta", "archify"]),
    skillMds: { zeta: "---\nname: zeta\n---\n", archify: ARCHIFY },
  };
  const next = core.setOverride(core.setOverride(prevState, "zeta", "called"), "archify", "called");
  const p = core.planChange(prev, next, ["zeta", "archify"]);
  assert.deepEqual(p.order, ["skill", "project", "opencode", "bundles"]);
  assert.deepEqual(p.writes.map((w) => [w.kind, w.id ?? null]), [["skill", "archify"], ["skill", "zeta"], ["bundles", null]]);
  assert.equal(p.writes[0].path, "~/.config/opencode/skills/archify/SKILL.md");
  assert.equal(p.writes[0].before, ARCHIFY);
  assert.equal(core.readFrontmatter(p.writes[0].after).autoinvoke, false);
  assert.equal(p.writes[2].path, core.BUNDLES_PATH);
  assert.deepEqual(p.skipped, []);
  // no change -> no writes
  assert.deepEqual(core.planChange(prev, prevState, ["zeta", "archify"]).writes, []);
  // permission change -> opencode write between skills and bundles
  const off = core.setBundleEnabled(prevState, "a", false);
  const q = core.planChange(prev, off, ["zeta", "archify"]);
  assert.deepEqual(q.writes.map((w) => w.kind), ["opencode", "bundles"]);
  assert.equal(q.writes[0].path, core.OPENCODE_PATH);
  // seeding: absent bundles file
  const seed = core.planChange({ ...prev, bundlesText: null }, prevState, ["zeta", "archify"]);
  assert.deepEqual(seed.writes.map((w) => [w.kind, w.before]), [["bundles", null]]);
  // pure: inputs untouched
  assert.equal(prev.skillMds.archify, ARCHIFY);
  // error tags
  assert.throws(() => core.planChange({ ...prev, opencodeText: null }, prevState, []), (e) => e.file === "opencode");
  assert.throws(() => core.planChange({ ...prev, opencodeText: '{"permissions":{}}' }, prevState, []), (e) => e.file === "opencode" && /not an array/.test(e.message));
  const bad = core.setOverride(prevState, "zeta", "called");
  assert.throws(() => core.planChange({ ...prev, skillMds: { zeta: "---\nmetadata: {a: 1}\n---\n" } }, bad, ["zeta"]), (e) => e.file === "skill");
  // skipped passes through
  const auto = core.setOverride(prevState, "zeta", "auto");
  assert.equal(core.planChange({ ...prev, skillMds: { zeta: "---\nmetadata: {a: 1}\n---\n" } }, auto, ["zeta"]).skipped[0].id, "zeta");
});

// ---------- R2: lock protocol ----------

test("R2 lock fixture matrix: parseLock + classifyLock", () => {
  const lock = (n) => fx(`locks/${n}`);
  const T = 1_000_000_000;
  const alive = (pid) => pid === 4242;
  const dead = () => false;
  const host = "here";
  // [fixture, parsed kind, [opts, verdict]...]
  const matrix = [
    ["cli.json", "cli", [
      [{ now: T, mtimeMs: T - 1, pidAlive: alive, host }, "held"],
      [{ now: T, mtimeMs: T - 24 * 3600e3, pidAlive: alive, host }, "held"], // live owner never times out
      [{ now: T, mtimeMs: T, pidAlive: dead, host }, "stale"],
      [{ now: T, mtimeMs: T - 60e3, pidAlive: alive, host: "elsewhere" }, "held"], // other host: 10-min rule
      [{ now: T, mtimeMs: T - 11 * 60e3, pidAlive: alive, host: "elsewhere" }, "stale"],
      [{ now: T, mtimeMs: T - 60e3, host }, "held"], // no pid probe (panel): 10-min rule
    ]],
    ["panel.json", "panel", [
      [{ now: 1000 + 59_999, mtimeMs: 1000 }, "held"],
      [{ now: 1000 + 60_000, mtimeMs: 1000 }, "held"],
      [{ now: 1000 + 60_001, mtimeMs: 1000 }, "stale"],
      [{ now: 1000 + 60_001, mtimeMs: 1000 + 30_000 }, "held"], // later mtime wins
      [{ now: T, mtimeMs: T, pidAlive: dead, host }, "held"], // old time but fresh mtime: max wins; pid ignored
    ]],
    ["panel-no-time.json", "panel", [
      [{ now: T, mtimeMs: T - 1000 }, "held"],
      [{ now: T, mtimeMs: T - 61_000 }, "stale"],
    ]],
    ["released.json", "released", [[{ now: T, mtimeMs: T }, "free"]]],
    ["released-no-owner.json", "invalid", [[{ now: T, mtimeMs: T }, "held"], [{ now: T, mtimeMs: T - 11 * 60e3 }, "stale"]]],
    ["released-string.json", "panel", [[{ now: T, mtimeMs: T }, "held"]]],
    ["garbage.txt", "invalid", [[{ now: T, mtimeMs: T - 9 * 60e3 }, "held"], [{ now: T, mtimeMs: T - 11 * 60e3 }, "stale"]]],
    ["empty.txt", "invalid", [[{ now: T, mtimeMs: T }, "held"]]],
    ["array.json", "invalid", [[{ now: T, mtimeMs: T }, "held"]]],
    ["pid-zero.json", "invalid", [[{ now: T, mtimeMs: T, pidAlive: alive, host }, "held"]]],
    ["no-host.json", "invalid", [[{ now: T, mtimeMs: T, pidAlive: dead, host }, "held"], [{ now: T, mtimeMs: T - 11 * 60e3 }, "stale"]]],
  ];
  for (const [file, kind, rows] of matrix) {
    const info = core.parseLock(lock(file));
    assert.equal(info.kind, kind, file);
    for (const [opts, verdict] of rows) assert.equal(core.classifyLock(info, opts), verdict, `${file} ${JSON.stringify(opts)}`);
  }
  assert.equal(core.classifyLock(null, { now: T, mtimeMs: T }), "free");
  assert.deepEqual(core.parseLock(lock("cli.json")), { kind: "cli", pid: 4242, host: "here", token: "cli-tok", time: 1000 });
  assert.equal(core.parseLock(lock("panel.json")).token, "p-tok");
  // records round-trip and match the documented wire format exactly
  assert.equal(lock("released.json"), core.RELEASED_MARKER);
  assert.equal(core.parseLock(core.RELEASED_MARKER).kind, "released");
  assert.equal(core.panelLockRecord("p-tok", 1000), lock("panel.json"));
  assert.equal(core.parseLock(core.panelLockRecord("x", 5)).kind, "panel");
  assert.equal(core.PANEL_LOCK_TTL_MS, 60_000);
  assert.equal(core.LOCK_UNPARSEABLE_STALE_MS, 600_000);
  assert.equal(core.LOCK_PATH, "~/.config/opencode/.skill-bundles.lock");
});

// ---------- per-project bundles (v0.2) ----------

test("P1 projects/managedProjects round-trip; old files byte-identical", () => {
  const seed = readFileSync(fileURLToPath(new URL("../data/default-bundles.json", import.meta.url)), "utf8");
  assert.equal(core.serializeBundles(core.parseBundles(seed)), seed);
  const old = core.serializeBundles(base());
  assert.equal(core.serializeBundles(core.parseBundles(old)), old);
  assert.ok(!old.includes("projects") && !old.includes("managedProjects"));
  const raw = { version: 1, bundles: [{ id: "a", name: "A", enabled: false, skills: ["x"], projects: ["/p/b/", "~/a", "/p/b"] }], overrides: {}, managedProjects: ["/z", "/p/b"] };
  const s = core.parseBundles(JSON.stringify(raw));
  assert.deepEqual(s.bundles[0].projects, ["/p/b", "~/a"]);
  assert.deepEqual(s.managedProjects, ["/p/b", "/z"]);
  const text = core.serializeBundles(s);
  assert.equal(core.serializeBundles(core.parseBundles(text)), text);
  // empty lists are omitted
  const e = core.parseBundles(JSON.stringify({ ...raw, bundles: [{ ...raw.bundles[0], projects: [] }], managedProjects: [] }));
  assert.equal(e.bundles[0].projects, undefined);
  assert.ok(!core.serializeBundles(e).includes("rojects"));
  for (const bad of [["rel/dir"], ["/a/../b"], [1], "x"]) {
    assert.throws(() => core.parseBundles(JSON.stringify({ ...raw, bundles: [{ ...raw.bundles[0], projects: bad }] })), /projects/);
  }
  assert.throws(() => core.parseBundles(JSON.stringify({ ...raw, managedProjects: ["nope"] })), /managedProjects/);
});

test("P2 bundle project helpers, projectsFor, projectTargets", () => {
  let s = base();
  s = core.addBundleProject(s, "a", "/p/one/");
  s = core.addBundleProject(s, "a", "/p/one");
  s = core.addBundleProject(s, "b", "~/two");
  assert.deepEqual(s.bundles[0].projects, ["/p/one"]);
  assert.deepEqual(base().bundles[0].projects, undefined);
  assert.deepEqual(core.projectsFor(s, "y"), ["/p/one", "~/two"]);
  assert.deepEqual(core.projectsFor(s, "x"), ["/p/one"]);
  assert.deepEqual(core.projectsFor(s, "nope"), []);
  assert.deepEqual(core.projectTargets({ ...s, managedProjects: ["/old"] }), ["/old", "/p/one", "~/two"]);
  s = core.removeBundleProject(s, "a", "/p/one/");
  assert.equal("projects" in s.bundles[0], false);
  s = core.setBundleProjects(s, "b", ["/z", "/a", "/z"]);
  assert.deepEqual(s.bundles[1].projects, ["/a", "/z"]);
  assert.throws(() => core.addBundleProject(s, "a", "rel"), /absolute/);
  assert.throws(() => core.addBundleProject(s, "nope", "/x"), /Unknown bundle/);
  assert.equal(core.projectConfigPath("/p/x/"), "/p/x/.opencode/opencode.json");
  assert.equal(core.projectConfigPath("~/p"), "~/p/.opencode/opencode.json");
  assert.equal(core.normalizeProjectDir("/a//"), "/a");
});

test("P3 applyProjectPermissions splice", () => {
  // missing file
  assert.equal(core.applyProjectPermissions(null, []), null);
  const created = core.applyProjectPermissions(null, ["b", "a", "a"]);
  assert.deepEqual(JSON.parse(created), {
    $schema: "https://opencode.ai/config.json",
    permissions: [{ action: "skill", resource: "a", effect: "allow" }, { action: "skill", resource: "b", effect: "allow" }],
  });
  assert.ok(created.endsWith("}\n"));
  // existing: keeps keys, order, other rules, escapes; no deny *
  const src = '{\n  "model": "x\\u00b7y",\n  "permissions": [\n    { "action": "bash", "resource": "*", "effect": "ask" },\n    { "action": "skill", "resource": "old", "effect": "allow" },\n    { "action": "edit", "resource": "*", "effect": "deny" }\n  ],\n  "z": 1\n}\n';
  const out = core.applyProjectPermissions(src, ["s1"]);
  assert.ok(out.startsWith('{\n  "model": "x\\u00b7y",\n  "permissions": ['));
  assert.ok(out.endsWith('\n  "z": 1\n}\n'));
  assert.deepEqual(JSON.parse(out).permissions.map((r) => [r.action, r.resource]), [["bash", "*"], ["edit", "*"], ["skill", "s1"]]);
  assert.ok(!JSON.parse(out).permissions.some((r) => r.resource === "*" && r.action === "skill"));
  // removal: skill rules gone, others kept, permissions array kept even when empty
  const removed = core.applyProjectPermissions(out, []);
  assert.deepEqual(JSON.parse(removed).permissions.map((r) => r.action), ["bash", "edit"]);
  const onlySkill = core.applyProjectPermissions('{"permissions":[{"action":"skill","resource":"a","effect":"allow"}]}', []);
  assert.deepEqual(JSON.parse(onlySkill), { permissions: [] });
  // nothing of ours and nothing to add: untouched (no permissions key added)
  assert.equal(core.applyProjectPermissions('{"a":1}', []), '{"a":1}');
  const added = core.applyProjectPermissions('{"a":1}', ["q"]);
  assert.deepEqual(JSON.parse(added), { a: 1, permissions: [{ action: "skill", resource: "q", effect: "allow" }] });
  // idempotent
  assert.equal(core.applyProjectPermissions(out, ["s1"]), out);
  assert.throws(() => core.applyProjectPermissions('{"permissions":{}}', ["a"]), /not an array/);
  assert.throws(() => core.applyProjectPermissions("[]", ["a"]), /JSON object/);
  assert.throws(() => core.applyProjectPermissions('{"permissions":[],"permissions":[]}', ["a"]), /duplicate/);
});

test("P4 planChange with project writes: order, managedProjects lifecycle", () => {
  const ids = ["x", "y", "z"];
  const s0 = base();
  const prev = (state, extra = {}) => ({
    bundlesText: core.serializeBundles(state),
    opencodeText: core.applyPermissions('{"permissions":[]}\n', state, ids),
    skillMds: { x: "---\nname: x\n---\n" },
    ...extra,
  });
  // add a project to disabled bundle b (y, z) and override x → called
  const s1 = core.setOverride(core.addBundleProject(s0, "b", "/proj"), "x", "called");
  assert.throws(() => core.planChange(prev(s0), s1, ids), (e) => e.file === "project" && e.id === "/proj");
  const p1 = core.planChange(prev(s0), s1, ids, { "/proj": null });
  assert.deepEqual(p1.order, ["skill", "project", "opencode", "bundles"]);
  assert.deepEqual(p1.writes.map((w) => w.kind), ["skill", "project", "bundles"]);
  const pw = p1.writes[1];
  assert.equal(pw.path, "/proj/.opencode/opencode.json");
  assert.equal(pw.dir, "/proj");
  assert.equal(pw.before, null);
  assert.deepEqual(JSON.parse(pw.after).permissions.map((r) => r.resource), ["y", "z"]);
  assert.deepEqual(p1.state.managedProjects, ["/proj"]);
  assert.deepEqual(JSON.parse(p1.writes[2].after).managedProjects, ["/proj"]);
  // global change too → project before opencode
  const p1b = core.planChange(prev(s0), core.setBundleEnabled(s1, "b", true), ids, { "/proj": null });
  assert.deepEqual(p1b.writes.map((w) => w.kind), ["skill", "project", "opencode", "bundles"]);
  // remove the project: rules removed, dir leaves managedProjects in the same plan
  const s2 = core.removeBundleProject(p1.state, "b", "/proj");
  const p2 = core.planChange(prev(p1.state, { skillMds: { x: p1.writes[0].after } }), s2, ids, { "/proj": pw.after });
  assert.deepEqual(p2.writes.map((w) => w.kind), ["project", "bundles"]);
  assert.deepEqual(JSON.parse(p2.writes[0].after), { $schema: "https://opencode.ai/config.json", permissions: [] });
  assert.equal(p2.state.managedProjects, undefined);
  assert.ok(!p2.writes[1].after.includes("managedProjects"));
  // dir with no rules (missing file) never becomes managed and writes nothing
  const empty = core.addBundleProject(core.createBundle(s0, "E"), "e", "/empty");
  const p3 = core.planChange(prev(s0), empty, ids, { "/empty": null });
  assert.deepEqual(p3.writes.map((w) => w.kind), ["bundles"]);
  assert.equal(p3.state.managedProjects, undefined);
  // re-plan from final state is a no-op
  const p4 = core.planChange({ ...prev(p1.state), skillMds: { x: p1.writes[0].after } }, p1.state, ids, { "/proj": pw.after });
  assert.deepEqual(p4.writes, []);
  // bad project file tagged
  assert.throws(() => core.planChange(prev(s0), s1, ids, { "/proj": '{"permissions":3}' }), (e) => e.file === "project" && /\/proj\/\.opencode\/opencode\.json/.test(e.message));
});

// ---------- project dir aliases ----------

test("A1 normalizeProjectDir collapses ., //, trailing /. and maps $HOME to ~", () => {
  const n = (d, o) => core.normalizeProjectDir(d, o);
  assert.equal(n("/p/."), "/p");
  assert.equal(n("/p/./q//r/"), "/p/q/r");
  assert.equal(n("//p///"), "/p");
  assert.equal(n("/"), "/");
  assert.equal(n("/./"), "/");
  assert.equal(n("~/x/./y/."), "~/x/y");
  assert.equal(n("~//x"), "~/x");
  const home = { home: "/home/u/" };
  assert.equal(n("/home/u/x", home), "~/x");
  assert.equal(n("/home/u/./x/", home), "~/x");
  assert.equal(n("/home/u", home), "~");
  assert.equal(n("/home/user2/x", home), "/home/user2/x"); // prefix, not under home
  assert.equal(n("/home/u/x"), "/home/u/x"); // no home given: stays absolute
  assert.equal(n("~/x", home), "~/x");
  assert.equal(n("/p", { home: "/" }), "/p"); // root home never rewrites
  assert.throws(() => n("/a/../b"), /\.\./);
  assert.throws(() => n("rel"), /absolute/);
});

test("A2 every alias form groups into one write holding the union", () => {
  const home = "/home/u";
  const ids = ["a1", "b1"];
  const mk = (pa, pb) =>
    core.parseBundles(JSON.stringify({
      version: 1,
      bundles: [
        { id: "a", name: "A", enabled: false, skills: ["a1"], projects: [pa] },
        { id: "b", name: "B", enabled: false, skills: ["b1"], projects: [pb] },
      ],
      overrides: {},
    }));
  const prev = (s) => ({ bundlesText: core.serializeBundles(s), opencodeText: '{"permissions":[]}', skillMds: {} });
  for (const [pa, pb, canon] of [
    ["/home/u/p", "~/p", "~/p"],
    ["/p", "/p/.", "/p"],
    ["/p/", "//p", "/p"],
    ["~/p/./", "/home/u//p", "~/p"],
  ]) {
    // stored aliases migrate on parse when home is known
    const s = core.parseBundles(core.serializeBundles(mk(pa, pb)), { home });
    assert.deepEqual(s.bundles.map((b) => b.projects), [[canon], [canon]], `${pa} | ${pb}`);
    assert.deepEqual(core.projectTargets(s), [canon]);
    const plan = core.planChange(prev(s), s, ids, { [canon]: null }, { home });
    const pw = plan.writes.filter((w) => w.kind === "project");
    assert.equal(pw.length, 1, `${pa} | ${pb}`);
    assert.deepEqual(JSON.parse(pw[0].after).permissions.map((r) => r.resource), ["a1", "b1"]);
    // removing through the OTHER spelling leaves the first bundle's allows in place
    const s2 = core.removeBundleProject(plan.state, "b", pa, { home });
    const plan2 = core.planChange({ ...prev(plan.state), bundlesText: plan.writes.at(-1).after }, s2, ids, { [canon]: pw[0].after }, { home });
    const pw2 = plan2.writes.filter((w) => w.kind === "project");
    assert.equal(pw2.length, 1);
    assert.deepEqual(JSON.parse(pw2[0].after).permissions.map((r) => r.resource), ["a1"], `${pa} | ${pb}`);
    assert.deepEqual(plan2.state.managedProjects, [canon]);
  }
  // planChange canonicalizes even a non-canonical in-memory state (no parse), with home
  const raw = mk("/home/u/p", "~/p/.");
  assert.deepEqual(core.projectTargets(raw, { home }), ["~/p"]);
  assert.deepEqual(core.projectsFor(raw, "b1", { home }), ["~/p"]);
  const plan = core.planChange(prev(raw), raw, ids, { "~/p": null }, { home });
  assert.equal(plan.writes.filter((w) => w.kind === "project").length, 1);
  assert.deepEqual(plan.state.bundles.map((b) => b.projects), [["~/p"], ["~/p"]]);
});

test("A3 stored-alias migration: parse dedupes managedProjects and bundle lists", () => {
  const text = JSON.stringify({
    version: 1,
    bundles: [{ id: "a", name: "A", enabled: false, skills: ["x"], projects: ["/home/u/p", "~/p/", "/q/.", "/q"] }],
    overrides: {},
    managedProjects: ["/home/u/p/.", "~/p", "/q//"],
  });
  const s = core.parseBundles(text, { home: "/home/u" });
  assert.deepEqual(s.bundles[0].projects, ["/q", "~/p"]);
  assert.deepEqual(s.managedProjects, ["/q", "~/p"]);
  const without = core.parseBundles(text);
  assert.deepEqual(without.bundles[0].projects, ["/home/u/p", "/q", "~/p"]); // home unknown: only syntactic
  assert.equal(core.canonicalizeProjects(s, { home: "/home/u" }), s); // already canonical: same object
  const merged = core.mergeProjectDirs(s, { "/q": "~/p" });
  assert.deepEqual(merged.bundles[0].projects, ["~/p"]);
  assert.deepEqual(merged.managedProjects, ["~/p"]);
});

test("A4 applyProjectPermissions keeps non-skill entries byte-for-byte", () => {
  const src = '{\n  "permissions": [\n    {"action":"bash","resource":"rm \\u002a","effect":"ask"},\n    { "action": "skill", "resource": "old", "effect": "allow" },\n    { "action": "edit",   "resource": "*", "effect": "deny" }\n  ]\n}\n';
  const out = core.applyProjectPermissions(src, ["n"]);
  assert.ok(out.includes('    {"action":"bash","resource":"rm \\u002a","effect":"ask"},\n'));
  assert.ok(out.includes('    { "action": "edit",   "resource": "*", "effect": "deny" },\n'));
  assert.deepEqual(JSON.parse(out).permissions.map((r) => r.resource), ["rm *", "*", "n"]);
  assert.equal(core.applyProjectPermissions(out, ["n"]), out);
  const gone = core.applyProjectPermissions(out, []);
  assert.ok(gone.includes('{"action":"bash","resource":"rm \\u002a","effect":"ask"}'));
  assert.deepEqual(JSON.parse(gone).permissions.length, 2);
  assert.equal(core.applyProjectPermissions('{"permissions":[{"action":"skill","resource":"a","effect":"allow"}]}', []), '{"permissions":[]}');
});

test("planChange: unreadable SKILL.md refuses 'called', skips 'auto' with a note", () => {
  const st = S({ bundles: [{ id: "a", enabled: true, skills: ["x"] }] });
  const prev = { bundlesText: core.serializeBundles(st), opencodeText: '{"permissions":[]}\n', skillMds: {}, unreadable: ["x"] };
  assert.throws(() => core.planChange(prev, core.setOverride(st, "x", "called"), ["x"]), (e) => e.file === "skill" && e.id === "x");
  const p = core.planChange(prev, st, ["x"]);
  assert.deepEqual(p.skipped.map((s) => s.id), ["x"]);
});

test("planChange: incomplete discovery keeps every rule and restates only flipped ids", () => {
  const st = S({ bundles: [{ id: "a", enabled: true, skills: ["x", "external"] }, { id: "b", enabled: false, skills: ["y"] }] });
  const rules = [
    { action: "skill", resource: "*", effect: "deny" },
    { action: "skill", resource: "external", effect: "allow" },
    { action: "skill", resource: "ghost", effect: "allow" },
    { action: "skill", resource: "ghost", effect: "deny" },
    { action: "skill", resource: "private-*", effect: "allow" },
    { action: "skill", resource: "private-secret", effect: "deny" },
    { action: "skill", resource: "x", effect: "allow" },
  ];
  const oc = JSON.stringify({ permissions: rules }, null, 2) + "\n";
  const md = "---\nname: x\n---\n";
  const prev = { bundlesText: core.serializeBundles(st), opencodeText: oc, skillMds: { x: md, y: md }, incomplete: true };
  const perms = (p) => JSON.parse(p.writes.find((w) => w.kind === "opencode").after).permissions;
  // turning bundle b on: only y is restated; ghost stays denied, private-* exceptions survive
  const on = perms(core.planChange(prev, core.setBundleEnabled(st, "b", true), ["x", "y"]));
  assert.deepEqual(on.slice(0, rules.length), rules);
  assert.deepEqual(on.slice(rules.length), [{ action: "skill", resource: "y", effect: "allow" }]);
  // turning bundle a off: external (not discovered) is restated as deny, not kept allowed
  const off = perms(core.planChange(prev, core.setBundleEnabled(st, "a", false), ["x", "y"])); // external not discovered
  assert.deepEqual(off.filter((r) => r.resource === "external"), [{ action: "skill", resource: "external", effect: "deny" }]);
  assert.deepEqual(off.filter((r) => r.resource === "x"), [{ action: "skill", resource: "x", effect: "deny" }]);
  // "when called" either way is refused; on/off with no SKILL.md edit needed is fine
  assert.throws(() => core.planChange(prev, core.setOverride(st, "x", "called"), ["x", "y"]), (e) => e.file === "skill" && /when called/.test(e.message));
  const called = S({ bundles: st.bundles, overrides: { x: "called" } });
  assert.throws(() => core.planChange({ ...prev, bundlesText: core.serializeBundles(called) }, core.setOverride(called, "x", "auto"), ["x"]), /when called/);
  // no SKILL.md is written while incomplete
  assert.ok(!core.planChange(prev, core.setBundleEnabled(st, "b", true), ["x", "y"]).writes.some((w) => w.kind === "skill"));
  // complete discovery still rewrites the skill rules from scratch
  const q = perms(core.planChange({ ...prev, incomplete: false }, core.setBundleEnabled(st, "b", true), ["x", "y"]));
  assert.ok(!q.some((r) => r.resource === "ghost" || r.resource === "private-*"));
});

test("groups preserves projects when present and omits when absent", () => {
  const st = S({
    bundles: [
      { id: "a", name: "A", enabled: false, skills: ["x"], projects: ["~/p1"] },
      { id: "b", name: "B", enabled: true, skills: ["y"] },
    ],
  });
  const g = core.groups(st, ["x", "y"]);
  assert.deepEqual(g[0].projects, ["~/p1"]);
  assert.equal("projects" in g[1], false);
  assert.equal("projects" in g[2], false);
});

test("overrides[id] === 'off' excludes skill from projectsFor and projectSkills / planChange", () => {
  const st0 = S({
    bundles: [{ id: "a", name: "A", enabled: false, skills: ["x", "y"], projects: ["/proj"] }],
    overrides: {},
  });
  assert.deepEqual(core.projectsFor(st0, "x"), ["/proj"]);
  const prev0 = {
    bundlesText: core.serializeBundles(st0),
    opencodeText: '{"permissions":[]}\n',
    skillMds: { x: "---\nname: x\n---\n", y: "---\nname: y\n---\n" },
  };
  const p0 = core.planChange(prev0, st0, ["x", "y"], { "/proj": null });
  const pw0 = p0.writes.find((w) => w.kind === "project");
  assert.deepEqual(JSON.parse(pw0.after).permissions.map((r) => r.resource), ["x", "y"]);

  // Disable x via override: excluded from projectsFor and removed from project opencode.json
  const st1 = core.setOverride(p0.state, "x", "off");
  assert.deepEqual(core.projectsFor(st1, "x"), []);
  assert.deepEqual(core.projectsFor(st1, "y"), ["/proj"]);
  const p1 = core.planChange({ ...prev0, bundlesText: p0.writes.at(-1).after }, st1, ["x", "y"], { "/proj": pw0.after });
  const pw1 = p1.writes.find((w) => w.kind === "project");
  assert.deepEqual(JSON.parse(pw1.after).permissions.map((r) => r.resource), ["y"]);

  // Clear override: restored to projectsFor and project opencode.json
  const st2 = core.setOverride(p1.state, "x", null);
  assert.deepEqual(core.projectsFor(st2, "x"), ["/proj"]);
  const p2 = core.planChange({ ...prev0, bundlesText: p1.writes.at(-1).after }, st2, ["x", "y"], { "/proj": pw1.after });
  const pw2 = p2.writes.find((w) => w.kind === "project");
  assert.deepEqual(JSON.parse(pw2.after).permissions.map((r) => r.resource), ["x", "y"]);
});

test("effectiveMode and summary support projectDir scope", () => {
  const home = "/home/u";
  const st = S({
    bundles: [
      { id: "g", name: "G", enabled: true, skills: ["g1"] },
      { id: "p", name: "P", enabled: false, skills: ["p1", "p2"], projects: ["~/proj-a"] },
    ],
    overrides: { p2: "off", c1: "called", opencode: "called" },
  });
  const all = ["g1", "p1", "p2", "c1", "opencode"];
  // Global scope (no projectDir or chats dir): g1 (auto), opencode (auto), c1 (called)
  assert.equal(core.effectiveMode(st, "p1"), "off");
  assert.equal(core.effectiveMode(st, "p1", { projectDir: "/home/u/.config/openchamber/chats/123", home }), "off");
  assert.deepEqual(core.summary(st, all), { on: 3, auto: 2, called: 1, chars: 2 * core.CHARS_PER_SKILL });

  // Project A scope: p1 is auto, p2 stays off due to override
  const optsA = { projectDir: "/home/u/proj-a", home };
  assert.equal(core.effectiveMode(st, "g1", optsA), "auto");
  assert.equal(core.effectiveMode(st, "p1", optsA), "auto");
  assert.equal(core.effectiveMode(st, "p2", optsA), "off");
  assert.equal(core.effectiveMode(st, "c1", optsA), "called");
  assert.equal(core.effectiveMode(st, "opencode", optsA), "auto");
  assert.deepEqual(core.summary(st, all, optsA), { on: 4, auto: 3, called: 1, chars: 3 * core.CHARS_PER_SKILL });

  // Project B scope: p1 is off
  const optsB = { projectDir: "/home/u/proj-b", home };
  assert.equal(core.effectiveMode(st, "p1", optsB), "off");
  assert.deepEqual(core.summary(st, all, optsB), { on: 3, auto: 2, called: 1, chars: 2 * core.CHARS_PER_SKILL });
});

test("setBundleGlobal toggles enabled without clearing overrides", () => {
  const s0 = core.setOverride(core.setOverride(base(), "x", "off"), "y", "called");
  const s1 = core.setBundleGlobal(s0, "a", false);
  assert.equal(s1.bundles[0].enabled, false);
  assert.deepEqual({ ...s1.overrides }, { x: "off", y: "called" });
  const s2 = core.setBundleGlobal(s1, "a", true);
  assert.equal(s2.bundles[0].enabled, true);
  assert.deepEqual({ ...s2.overrides }, { x: "off", y: "called" });
  assert.throws(() => core.setBundleGlobal(s0, "nope", true), /Unknown bundle/);
});

test("excludedProjects: round-trip, effectiveMode, summary, and planChange deny/allow rules", () => {
  const home = "/home/u";
  const st0 = core.parseBundles(JSON.stringify({
    version: 1,
    bundles: [
      { id: "g", name: "G", enabled: true, skills: ["g1", "shared"] },
      { id: "p", name: "P", enabled: false, skills: ["shared", "p1"], projects: ["/home/u/proj-a"] },
    ],
    overrides: {},
  }), { home });
  assert.equal(core.serializeBundles(st0).includes("excludedProjects"), false);

  // Exclude global bundle "g" in proj-a: g1 is denied in proj-a, shared stays allowed via bundle "p"
  const st1 = core.excludeBundleProject(st0, "g", "/home/u/proj-a", { home });
  assert.deepEqual(st1.bundles[0].excludedProjects, ["~/proj-a"]);
  assert.equal(core.effectiveMode(st1, "g1", { projectDir: "/home/u/proj-a", home }), "off");
  assert.equal(core.effectiveMode(st1, "shared", { projectDir: "/home/u/proj-a", home }), "auto");
  assert.equal(core.effectiveMode(st1, "g1", { projectDir: "/home/u/proj-b", home }), "auto");
  assert.deepEqual(core.summary(st1, ["g1", "shared", "p1"], { projectDir: "/home/u/proj-a", home }), {
    on: 2, auto: 2, called: 0, chars: 2 * core.CHARS_PER_SKILL,
  });

  const prev = {
    bundlesText: core.serializeBundles(st0),
    opencodeText: core.applyPermissions('{"permissions":[]}\n', st0, ["g1", "shared", "p1"]),
    skillMds: { g1: "---\nname: g1\n---\n", shared: "---\nname: shared\n---\n", p1: "---\nname: p1\n---\n" },
  };
  const plan1 = core.planChange(prev, st1, ["g1", "shared", "p1"], { "~/proj-a": null }, { home });
  const pw1 = plan1.writes.find((w) => w.kind === "project");
  assert.deepEqual(JSON.parse(pw1.after).permissions, [
    { action: "skill", resource: "g1", effect: "deny" },
    { action: "skill", resource: "p1", effect: "allow" },
    { action: "skill", resource: "shared", effect: "allow" },
  ]);

  // includeBundleProject removes the exclusion and drops the deny rule
  const st2 = core.includeBundleProject(plan1.state, "g", "/home/u/proj-a", { home });
  assert.equal(st2.bundles[0].excludedProjects, undefined);
  const plan2 = core.planChange({ ...prev, bundlesText: plan1.writes.at(-1).after }, st2, ["g1", "shared", "p1"], { "~/proj-a": pw1.after }, { home });
  const pw2 = plan2.writes.find((w) => w.kind === "project");
  assert.deepEqual(JSON.parse(pw2.after).permissions, [
    { action: "skill", resource: "p1", effect: "allow" },
    { action: "skill", resource: "shared", effect: "allow" },
  ]);

  // setBundleGlobal(..., false) clears excludedProjects
  const st3 = core.setBundleGlobal(st1, "g", false);
  assert.equal(st3.bundles[0].enabled, false);
  assert.equal(st3.bundles[0].excludedProjects, undefined);

  // setBundleEnabled(..., false) also clears excludedProjects, and excludeBundleProject on disabled bundle does not add excludedProjects
  const st4 = core.setBundleEnabled(st1, "g", false);
  assert.equal(st4.bundles[0].enabled, false);
  assert.equal(st4.bundles[0].excludedProjects, undefined);
  const st5 = core.excludeBundleProject(st4, "g", "/home/u/proj-a", { home });
  assert.equal(st5.bundles[0].excludedProjects, undefined);
});
