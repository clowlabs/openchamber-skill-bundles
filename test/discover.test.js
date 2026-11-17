import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GLOBAL_SKILL_ROOTS,
  SKILL_SCAN_DEPTH,
  SKILL_FILE,
  configSkillRoots,
  normalizeRoot,
  skillRoots,
  classifySkillDir,
  mergeSkillRefs,
  join,
} from "../src/discover.js";

test("join handles empty parts, roots, and trailing separators", () => {
  for (const [a, b, expected] of [
    ["", "", ""], ["", "skill", "skill"], ["~/skills/", "", "~/skills/"],
    ["/", "skill", "/skill"], ["~/skills///", "nested/SKILL.md", "~/skills/nested/SKILL.md"],
  ]) assert.equal(join(a, b), expected);
});

test("constants match OpenCode V2 discovery", () => {
  assert.deepEqual(GLOBAL_SKILL_ROOTS, [
    "~/.claude/skills",
    "~/.agents/skills",
    "~/.config/opencode/skills",
  ]);
  assert.equal(SKILL_SCAN_DEPTH, 6);
  assert.equal(SKILL_FILE, "SKILL.md");
});

test("configSkillRoots extracts ~/ and absolute paths, skips URLs, relative, .., bad JSON", () => {
  assert.deepEqual(configSkillRoots("not json"), []);
  assert.deepEqual(configSkillRoots("{}"), []);
  assert.deepEqual(configSkillRoots(JSON.stringify({ skills: "nope" })), []);
  const oc = JSON.stringify({
    skills: [
      "~/extra/",
      "~",
      "/opt/skills///",
      "https://example.com/skills",
      "http://localhost:8080/s",
      "relative/skills",
      "./local",
      "~/bad/../escape",
      "/abs/../escape",
      42,
      "",
      "   ",
    ],
  });
  assert.deepEqual(configSkillRoots(oc), ["~/extra", "/opt/skills"]); // bare "~" is relative in OpenCode
});

test("skillRoots: compat roots first; a config entry naming a compat root moves it up; first repeat wins", () => {
  assert.deepEqual(skillRoots(null), GLOBAL_SKILL_ROOTS);
  const oc = JSON.stringify({ skills: ["~/.claude/skills/", "~/custom", "~/.config/opencode/skills", "~/custom/."] });
  assert.deepEqual(skillRoots(oc), ["~/.agents/skills", "~/.config/opencode/skills", "~/.claude/skills", "~/custom"]);
});

test("skillRoots: ~/x and its absolute spelling are one source (first position kept)", () => {
  const oc = JSON.stringify({ skills: ["~/custom", "/home/me/.config/opencode/skills", "/home/me/custom"] });
  assert.deepEqual(skillRoots(oc, { home: "/home/me" }), ["~/.claude/skills", "~/.agents/skills", "~/.config/opencode/skills", "~/custom"]);
  assert.deepEqual(skillRoots(JSON.stringify({ skills: ["/home/me/.claude/skills"] }), { home: "/home/me" }), ["~/.agents/skills", "~/.config/opencode/skills", "/home/me/.claude/skills"]);
});

test("normalizeRoot: filesystem root, home, dot segments, bare ~ and relative", () => {
  assert.equal(normalizeRoot("/"), "/");
  assert.equal(normalizeRoot("~/"), "~");
  assert.equal(normalizeRoot("~/single/."), "~/single");
  assert.equal(normalizeRoot("~/a//b/"), "~/a/b");
  assert.equal(normalizeRoot("~"), null);
  assert.equal(normalizeRoot("rel/x"), null);
  assert.equal(normalizeRoot("~/x/../y"), null);
  // a SKILL.md directly in home is named after the home folder; "/" has no name
  assert.equal(classifySkillDir("~", "", [{ name: "SKILL.md", kind: "file" }], { home: "/home/me" }).skills[0].id, "me");
  assert.deepEqual(classifySkillDir("~", "", [{ name: "SKILL.md", kind: "file" }]).skills, []);
  assert.deepEqual(classifySkillDir("/", "", [{ name: "SKILL.md", kind: "file" }]).skills, []);
  assert.equal(classifySkillDir(normalizeRoot("~/single/."), "", [{ name: "SKILL.md", kind: "file" }]).skills[0].id, "single");
});

test("classifySkillDir finds root-level *.md flat skills and recurses into visible subdirs", () => {
  const res = classifySkillDir("~/.agents/skills", "", [
    { name: "alpha.md", kind: "file" },
    { name: ".md", kind: "file" }, // empty id ignored
    { name: "notes.txt", kind: "file" },
    { name: ".hidden", kind: "directory" },
    { name: ".secret.md", kind: "file" },
    { name: "node_modules", kind: "directory" },
    { name: ".git", kind: "directory" },
    { name: "venv", kind: "directory" },
    { name: "__pycache__", kind: "directory" },
    { name: "beta", kind: "directory" },
    { name: "teams", kind: "directory" },
  ]);
  assert.deepEqual(res.skills, [
    { id: "alpha", root: "~/.agents/skills", path: "~/.agents/skills/alpha.md", dir: null },
  ]);
  assert.deepEqual(res.subdirs, ["beta", "teams"]);
});

test("classifySkillDir: SKILL.md at a source root makes the root one skill, named after its folder", () => {
  const res = classifySkillDir("~/single-skill", "", [
    { name: "SKILL.md", kind: "file" },
    { name: "other.md", kind: "file" },
    { name: "sub", kind: "directory" },
  ]);
  assert.deepEqual(res.skills, [{ id: "single-skill", root: "~/single-skill", path: "~/single-skill/SKILL.md", dir: "~/single-skill" }]);
  assert.deepEqual(res.subdirs, []);
});

test("classifySkillDir treats subdir with SKILL.md as a single skill and stops recursing", () => {
  const res = classifySkillDir("~/.agents/skills", "teams/release", [
    { name: "SKILL.md", kind: "file" },
    { name: "extra.md", kind: "file" },
    { name: "nested", kind: "directory" },
  ]);
  assert.deepEqual(res.skills, [
    {
      id: "release",
      root: "~/.agents/skills",
      path: "~/.agents/skills/teams/release/SKILL.md",
      dir: "~/.agents/skills/teams/release",
    },
  ]);
  assert.deepEqual(res.subdirs, []);
});

test("classifySkillDir stops queueing subdirs at SKILL_SCAN_DEPTH", () => {
  const atDepth5 = classifySkillDir("/r", "a/b/c/d/e", [{ name: "f", kind: "directory" }]);
  assert.deepEqual(atDepth5.subdirs, ["a/b/c/d/e/f"]);

  const atDepth6 = classifySkillDir("/r", "a/b/c/d/e/f", [{ name: "g", kind: "directory" }]);
  assert.deepEqual(atDepth6.subdirs, []);
});

test("mergeSkillRefs: later root wins; within a root the last path in sort order wins (as OpenCode)", () => {
  const r1 = [
    { id: "shared", root: "~/.claude/skills", path: "~/.claude/skills/shared/SKILL.md", dir: "~/.claude/skills/shared" },
    { id: "only-claude", root: "~/.claude/skills", path: "~/.claude/skills/only-claude/SKILL.md", dir: "~/.claude/skills/only-claude" },
  ];
  const r2 = [
    { id: "shared", root: "~/.agents/skills", path: "~/.agents/skills/shared/SKILL.md", dir: "~/.agents/skills/shared" },
    { id: "dup", root: "~/.agents/skills", path: "~/.agents/skills/b/dup/SKILL.md", dir: "~/.agents/skills/b/dup" },
    { id: "dup", root: "~/.agents/skills", path: "~/.agents/skills/a/dup/SKILL.md", dir: "~/.agents/skills/a/dup" },
  ];
  const r3 = [
    { id: "shared", root: "~/.config/opencode/skills", path: "~/.config/opencode/skills/shared/SKILL.md", dir: "~/.config/opencode/skills/shared" },
  ];
  const merged = mergeSkillRefs([r1, r2, r3]);
  assert.equal(Object.getPrototypeOf(merged), null);
  assert.equal(merged["only-claude"].root, "~/.claude/skills");
  assert.equal(merged.shared.root, "~/.config/opencode/skills");
  assert.equal(merged.dup.path, "~/.agents/skills/b/dup/SKILL.md");
});
