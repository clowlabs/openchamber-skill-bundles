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
  assert.deepEqual(core.PUBLISH_ORDER, ["skill", "opencode", "bundles"]);
  const prevState = S({ bundles: [{ id: "a", enabled: true, skills: ["zeta", "archify"] }] });
  const prev = {
    bundlesText: core.serializeBundles(prevState),
    opencodeText: core.applyPermissions('{"permissions":[]}\n', prevState, ["zeta", "archify"]),
    skillMds: { zeta: "---\nname: zeta\n---\n", archify: ARCHIFY },
  };
  const next = core.setOverride(core.setOverride(prevState, "zeta", "called"), "archify", "called");
  const p = core.planChange(prev, next, ["zeta", "archify"]);
  assert.deepEqual(p.order, ["skill", "opencode", "bundles"]);
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
